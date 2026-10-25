/**
 * Local proxy between Claude Code and an Anthropic-compatible upstream (DeepSeek)
 * that masks old tool results in request bodies. Responses (incl. SSE) are piped
 * through unbuffered. Bodies and keys are never logged.
 */
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { AnthropicRequest, MaskOptions, maskOldToolResults } from './mask';
import { TappedUsage, usageTap } from './usageTap';
import type { Tagged } from './cacheDiag';
import { cachedLookup } from './dns';
import { errorMessage } from '../text';

export interface ProxyOptions {
  upstream: string;
  mask?: Partial<MaskOptions> | false;
  /** Adds request fields the upstream applies itself (e.g. Anthropic's server-side context editing); /v1/messages only. */
  inject?: (body: AnthropicRequest) => AnthropicRequest;
  /** Tags a /v1/messages request to the main upstream without parsing it (cache diagnostics); a 400 naming the tag resends it untagged. */
  tag?: (body: Buffer, headers: http.IncomingHttpHeaders) => Tagged | undefined;
  /** Reshapes what the upstream can't parse, count_tokens included; returns undefined when nothing changed. */
  fix?: (body: AnthropicRequest) => AnthropicRequest | undefined;
  /** Last byte-level edit of a rewritten body, given its parsed form: cheaper than serialising it again. */
  patch?: (bytes: Buffer, body: AnthropicRequest) => Buffer;
  /** One line per request; `fail` is set for failures (an HTTP status >= 400, an upstream error, a rewrite that failed), with what the request was. */
  log?: (line: string, fail?: FailMeta) => void;
  /** TCP connect and TLS handshake to the upstream, and to tunnelled hosts (default 10 s). */
  connectTimeoutMs?: number;
  /** Time from sending a streamed /v1/messages request to the upstream's response headers (default 60 s); a stalled upstream gets a 529 (see RETRY_FAST). */
  headerTimeoutMs?: number;
  /** The same for every other path: heartbeats, polls, event streams, count_tokens (default 30 s). */
  backgroundHeaderTimeoutMs?: number;
  /** Kept sockets idle this long are closed (default 15 s). */
  idleSocketMs?: number;
  /** DNS lookups (default: the cache in dns.ts). */
  lookup?: net.LookupFunction;
  /** Larger request bodies get a 413 instead of filling memory (default 64 MB). */
  maxBodyBytes?: number;
  /** Sends a /v1/messages request elsewhere (a Claude chat's DeepSeek helpers), unchanged by mask, inject and fix. */
  divert?: (body: Buffer, headers: http.IncomingHttpHeaders) => Divert | undefined;
  /**
   * Also serves as the client's HTTPS_PROXY: CONNECTs to the upstream's host are
   * decrypted with this certificate and handled like direct requests; every
   * other host is tunnelled untouched. The client keeps no custom base URL.
   */
  intercept?: { key: string; cert: string };
  /** A 429 from the upstream (Claude out of quota) for a /v1/messages request: where to send it instead, if anywhere. */
  fallback?: (body: Buffer, headers: http.IncomingHttpHeaders, limited: http.IncomingHttpHeaders) => Divert | undefined;
  /** A reason to refuse a /v1/messages request before sending it (a reached cost limit); the client gets a 400 saying so. */
  refuse?: (body: Buffer) => string | undefined | Promise<string | undefined>;
  /** What each successful /v1/messages reply cost, for sessions no chat records (Remote Control). */
  onUsage?: (u: TappedUsage & { session?: string }) => void;
  /** Every upstream response's path and status (Remote Control watches its bridge's). */
  onResponse?: (pathname: string, status: number) => void;
}

/** A failed request's context for its log row; `background` for paths other than /v1/messages (heartbeats, polls). */
export interface FailMeta { status?: number; model?: string; session?: string; background?: boolean }

/**
 * The model and Claude Code session a request is for, found without parsing
 * the body (it can be megabytes): the session is inside metadata.user_id.
 */
export function requestMeta(raw: Buffer | undefined): { model?: string; session?: string } {
  if (!raw) {
    return {};
  }
  const near = (key: string, re: RegExp) => {
    const at = raw.indexOf(key);
    return at < 0 ? undefined : re.exec(raw.subarray(at, at + 400).toString('utf8'))?.[1];
  };
  const model = near('"model"', /"model"\s*:\s*"([^"]{1,80})"/);
  const session = near('session_id', /session_id\\?"\s*:\s*\\?"([\w-]{8,64})/);
  return { ...(model ? { model } : {}), ...(session ? { session } : {}) };
}

/** The provider's reason from an error body (Anthropic and DeepSeek: error.message), shortened for a log line. */
export function errorReason(body: string): string {
  try {
    const d = JSON.parse(body);
    const m = d?.error?.message ?? d?.message;
    return typeof m === 'string' ? m.slice(0, 240) : '';
  } catch {
    // Not JSON (an HTML error page, a cut-off body).
  }
  return body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Another Anthropic-compatible endpoint for one request, with its own credential. */
export interface Divert {
  url: string;
  /** Header overrides; undefined removes the header. */
  headers: Record<string, string | undefined>;
  /** A reshaped body for the target, if it needs one. */
  body?: Buffer;
}

interface Upstream {
  base: URL;
  client: typeof http | typeof https;
  /** Model calls (/v1/messages). */
  agent: http.Agent;
  /** Every other path, so a pile-up of heartbeats or polls never takes model-call sockets. */
  bg: http.Agent;
  basePath: string;
}

function upstreamOf(url: string, idleMs: number, lookup: net.LookupFunction): Upstream {
  const base = new URL(url);
  const client = base.protocol === 'https:' ? https : http;
  // Reused connections skip the TCP and TLS handshakes on every call.
  const pool = () => expireIdle(new client.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 64, maxFreeSockets: 8, lookup }), idleMs);
  return { base, client, agent: pool(), bg: pool(), basePath: base.pathname.replace(/\/$/, '') };
}

/**
 * Closes kept sockets idle for `ms`: after a network change or sleep they are often dead without knowing it.
 * By hand, because the Agent `timeout` option also arms on sockets in use, and a stream may be silent for long.
 */
function expireIdle(agent: http.Agent, ms: number): http.Agent {
  const timers = new WeakMap<net.Socket, NodeJS.Timeout>();
  agent.on('free', (socket: net.Socket) => {
    clearTimeout(timers.get(socket));
    // Reused meanwhile: no longer in the free list, so it stays.
    const t = setTimeout(() => Object.values(agent.freeSockets).some((list) => list?.includes(socket)) && socket.destroy(), ms);
    t.unref();
    timers.set(socket, t);
  });
  return agent;
}

/** Drops an upstream's kept sockets after a network error, so the next request (Claude Code's retry) gets a fresh one. */
function flush(up: Upstream): void {
  for (const agent of [up.agent, up.bg]) {
    for (const list of Object.values(agent.freeSockets)) for (const s of [...(list ?? [])]) s.destroy();
  }
}

export interface ProxyStats { requests: number; masked: number; savedChars: number }

export interface ProxyHandle {
  url: string;
  stop(): Promise<void>;
  stats(): ProxyStats;
}

/** Hop-by-hop or recomputed; everything else (x-api-key, authorization, anthropic-*) is forwarded. */
const DROP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

/** count_tokens is masked too, so the CLI's token estimate matches what is actually sent. */
const MASKED_PATH = /\/v1\/messages(\/count_tokens)?$/;

function forwardHeaders(src: http.IncomingHttpHeaders, length?: number): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && !DROP.has(k)) out[k] = v;
  if (length !== undefined) out['content-length'] = length;
  return out;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

class BodyTooLarge extends Error {}

/** The whole request body; rejects past `max` bytes or when the client goes away before the end. */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        chunks.length = 0;
        reject(err);
      }
    };
    if (Number(req.headers['content-length']) > max) {
      fail(new BodyTooLarge());
      return;
    }
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) fail(new BodyTooLarge());
      else if (!settled) chunks.push(c);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('client disconnected')));
    req.on('close', () => fail(new Error('client disconnected')));
  });
}

/** Any parse, mask or inject failure falls back to the original bytes, with the error. */
function rewriteBody(
  raw: Buffer,
  opts: Partial<MaskOptions> | false,
  inject?: (body: AnthropicRequest) => AnthropicRequest,
  fix?: (body: AnthropicRequest) => AnthropicRequest | undefined,
  patch?: (bytes: Buffer, body: AnthropicRequest) => Buffer,
): { bytes: Buffer; masked: number; saved: number; error?: unknown } {
  if (opts === false && !inject && !fix && !patch) return { bytes: raw, masked: 0, saved: 0 };
  try {
    let body = JSON.parse(raw.toString('utf8')) as AnthropicRequest;
    let masked = 0;
    let saved = 0;
    const fixed = fix?.(body);
    if (fixed) body = fixed;
    if (opts !== false) {
      const r = maskOldToolResults(body, opts);
      body = r.body;
      masked = r.maskedCount;
      saved = r.savedChars;
    }
    const before = body;
    if (inject) body = inject(body);
    // Unknown fields (speed, output_config, ...) survive the round trip in order; unchanged bodies keep their exact bytes.
    const bytes = !masked && !fixed && body === before ? raw : Buffer.from(JSON.stringify(body));
    return { bytes: patch ? patch(bytes, body) : bytes, masked, saved };
  } catch (error) {
    return { bytes: raw, masked: 0, saved: 0, error };
  }
}

/** Anthropic-shaped error so the CLI shows a readable message. */
function sendError(res: http.ServerResponse, status: number, message: string, type = 'api_error', headers: http.OutgoingHttpHeaders = {}): void {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ type: 'error', error: { type, message: `Dual Agent proxy: ${message}` } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** An error body as text, unpacked if the upstream compressed it; '' if it can't be (cut short). */
function bodyText(raw: Buffer, encoding: string | undefined): string {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(raw).toString('utf8');
    if (encoding === 'br') return zlib.brotliDecompressSync(raw).toString('utf8');
    if (encoding === 'deflate') return zlib.inflateSync(raw).toString('utf8');
    return raw.toString('utf8');
  } catch {
    return '';
  }
}

const HEADER_TIMEOUT = 'EHEADERTIMEOUT';

/**
 * Network failures before any reply byte: answered 529 + x-should-retry so
 * Claude Code retries within a second instead of backing off for minutes.
 */
const RETRY_FAST = new Set([
  HEADER_TIMEOUT, 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED',
]);

/** Errors after which the upstream's other kept sockets are likely dead too. */
const FLUSH = new Set([HEADER_TIMEOUT, 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']);

let familyTimeoutSet = false;

/** Node's 250 ms per-address dual-stack attempt times out on slow or IPv6-less links (nodejs/node#54359). */
function widenFamilyAttemptTimeout(): void {
  if (familyTimeoutSet) return;
  familyTimeoutSet = true;
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') net.setDefaultAutoSelectFamilyAttemptTimeout(1000);
}

/** Calls `onTimeout` unless `s` connects within `ms`; for TLS the handshake is part of connecting. */
function boundConnect(s: net.Socket, ms: number, onTimeout: (err: Error) => void): void {
  const t = setTimeout(() => onTimeout(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), ms);
  s.once(s instanceof tls.TLSSocket ? 'secureConnect' : 'connect', () => clearTimeout(t));
  s.once('close', () => clearTimeout(t));
}

/** Where a request was when it failed: waiting for a socket, or a step towards the reply's headers. */
type Phase = 'queued' | 'lookup' | 'connect' | 'tls' | 'headers';

/** Bounds the connect and the wait for response headers (streamed bodies may take as long as they need); returns the current phase. */
function armTimeouts(upReq: http.ClientRequest, connectMs: number, headerMs: number): () => Phase {
  let phase: Phase = 'queued';
  upReq.on('socket', (s) => {
    if (!s.connecting) {
      phase = 'headers';
      return;
    }
    const secure = s instanceof tls.TLSSocket;
    phase = net.isIP(upReq.host) ? 'connect' : 'lookup';
    s.once('lookup', (err) => !err && (phase = 'connect'));
    s.once('connect', () => (phase = secure ? 'tls' : 'headers'));
    s.once('secureConnect', () => (phase = 'headers'));
    boundConnect(s, connectMs, (err) => upReq.destroy(err));
  });
  const t = setTimeout(() => upReq.destroy(Object.assign(new Error(`no response headers in ${headerMs / 1000}s`), { code: HEADER_TIMEOUT })), headerMs);
  upReq.once('response', () => clearTimeout(t));
  upReq.once('close', () => clearTimeout(t));
  return () => phase;
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const lookup = opts.lookup ?? cachedLookup;
  const connectMs = opts.connectTimeoutMs ?? 10_000;
  const main = upstreamOf(opts.upstream, opts.idleSocketMs ?? 15_000, lookup);
  const diverted = new Map<string, Upstream>();
  const divertTo = (url: string) => diverted.get(url) ?? diverted.set(url, upstreamOf(url, opts.idleSocketMs ?? 15_000, lookup)).get(url)!;
  widenFamilyAttemptTimeout();
  const log = opts.log ?? (() => undefined);
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const stats: ProxyStats = { requests: 0, masked: 0, savedChars: 0 };
  const live = new Set<http.ClientRequest>();
  let stopping = false;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    stats.requests++;
    const path = req.url ?? '/';
    const pathname = path.split('?')[0];
    const modelCall = pathname.endsWith('/v1/messages');
    const bodiless = !(Number(req.headers['content-length']) > 0) && req.headers['transfer-encoding'] === undefined;
    let resent = false;
    let body: Buffer | undefined;
    let note = '';
    let up = main;
    let overrides: Divert['headers'] = {};
    let raw: Buffer | undefined;
    let meta: FailMeta = {};
    let tagged: Tagged | undefined;
    if (req.method === 'POST' && MASKED_PATH.test(pathname)) {
      try {
        raw = await readBody(req, maxBody);
      } catch (err) {
        if (err instanceof BodyTooLarge) {
          log(`${req.method} ${pathname} -> 413 body over ${maxBody} bytes`, { status: 413 });
          sendError(res, 413, `request body is over ${Math.round(maxBody / 1024 / 1024)} MB`, 'request_too_large', { connection: 'close' });
        }
        return;
      }
      meta = requestMeta(raw);
      const refused = pathname.endsWith('/v1/messages') ? await opts.refuse?.(raw) : undefined;
      if (refused) {
        log(`${req.method} ${pathname} refused: ${refused}`, { status: 400, ...meta });
        sendError(res, 400, refused, 'invalid_request_error');
        return;
      }
      const d = opts.divert?.(raw, req.headers);
      if (d) {
        up = divertTo(d.url);
        overrides = d.headers;
        body = d.body ?? raw;
        note = ` via ${up.base.host}`;
      } else {
        const m = rewriteBody(raw, opts.mask === false ? false : (opts.mask ?? {}), pathname.endsWith('/count_tokens') ? undefined : opts.inject, opts.fix, opts.patch);
        body = m.bytes;
        if (m.error) log(`${req.method} ${pathname} rewrite failed, sent unchanged: ${errorMessage(m.error)}`, meta);
        stats.masked += m.masked;
        stats.savedChars += m.saved;
        if (m.masked) note = ` masked ${m.masked} (-${m.saved} chars)`;
        tagged = pathname.endsWith('/v1/messages') ? opts.tag?.(body, req.headers) : undefined;
      }
    }
    // The client hung up while we read: nothing would receive the reply.
    if (res.destroyed || req.socket.destroyed) return;

    /** Sends the request to `up`; `retryable` is the original body while a Claude limit may still send it elsewhere. */
    const send = (up: Upstream, overrides: Divert['headers'], plain: Buffer | undefined, note: string, retryable?: Buffer, tag?: Tagged): void => {
      const body = tag?.body ?? plain;
      const headers = forwardHeaders(req.headers, body?.length);
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete headers[k];
        else headers[k] = v;
      }
      const { base } = up;
      const upReq = up.client.request({
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || undefined,
        method: req.method,
        path: up.basePath + path,
        headers,
        agent: modelCall ? up.agent : up.bg,
      });
      live.add(upReq);
      // The client hung up (a stopped turn) or the proxy is stopping: what breaks after that isn't a failure.
      let dropped = false;
      let failed = false;
      let answered = false;
      /** One failure line per request at most. */
      const fail = (line: string, status?: number) => {
        if (!dropped && !stopping && !failed) {
          failed = true;
          log(line, { status, ...meta, ...(modelCall ? {} : { background: true }) });
        }
      };
      // A streamed reply sends headers at once, so 60 s without them is a stall. A non-streamed one sends
      // them only when the whole answer is done: a short limit there would fail (and retry) every long answer.
      // Other paths answer at once (event streams too); the bridge's long poll gives up by itself after 10 s.
      const streamed = !!body && /"stream"\s*:\s*true/.test(body.subarray(0, 4096).toString('latin1')) || /"stream"\s*:\s*true/.test(body?.subarray(-4096).toString('latin1') ?? '');
      const headerMs = !modelCall ? (opts.backgroundHeaderTimeoutMs ?? 30_000) : streamed ? (opts.headerTimeoutMs ?? 60_000) : Math.max(opts.headerTimeoutMs ?? 60_000, 600_000);
      const phase = armTimeouts(upReq, connectMs, headerMs);

      upReq.on('response', (upRes) => {
        answered = true;
        const status = upRes.statusCode ?? 502;
        opts.onResponse?.(pathname, status);
        const elsewhere = status === 429 && retryable ? opts.fallback?.(retryable, req.headers, upRes.headers) : undefined;
        if (elsewhere) {
          // Out of Claude quota: the same request goes to the fallback instead, before Claude Code sees the 429.
          upRes.resume();
          const target = divertTo(elsewhere.url);
          // The fallback logs it (with the reset time); not a failure of this request.
          log(`${req.method} ${pathname}${note} -> 429, sent to ${target.base.host} instead`);
          send(target, elsewhere.headers, elsewhere.body ?? retryable, ` via ${target.base.host}`);
          return;
        }
        if (status === 400 && tag) {
          // Our tag may be what was refused: hold the (small) error body back until that's known.
          const chunks: Buffer[] = [];
          upRes.on('data', (c: Buffer) => chunks.push(c));
          upRes.on('error', () => res.destroy());
          upRes.on('aborted', () => res.destroy());
          upRes.once('end', () => {
            const raw = Buffer.concat(chunks);
            const text = bodyText(raw, upRes.headers['content-encoding']);
            if (text.includes(tag.field)) {
              tag.rejected();
              log(`${req.method} ${pathname}${note} -> 400 refused the ${tag.field} field; sent again without it`, { status: 400, ...meta });
              send(up, overrides, plain, note, retryable);
              return;
            }
            fail(`${req.method} ${pathname}${note} -> 400${errorReason(text) ? `: ${errorReason(text)}` : ''}`, 400);
            res.writeHead(400, upRes.headers);
            res.end(raw);
          });
          return;
        }
        if (status >= 400) {
          // The provider's reason is in the body: read the start of it as it passes, and log once it ends.
          const chunks: Buffer[] = [];
          let size = 0;
          upRes.on('data', (c: Buffer) => {
            if (size < 65_536) {
              chunks.push(c);
              size += c.length;
            }
          });
          upRes.once('end', () => {
            const why = errorReason(bodyText(Buffer.concat(chunks), upRes.headers['content-encoding']));
            fail(`${req.method} ${pathname}${note} -> ${status}${why ? `: ${why}` : ''}`, status);
          });
        } else {
          log(`${req.method} ${pathname}${note} -> ${status}`);
          if ((opts.onUsage || tag) && pathname.endsWith('/v1/messages')) {
            const tap = usageTap(String(upRes.headers['content-type'] ?? '').includes('event-stream'), (u) => {
              tag?.reply(u);
              opts.onUsage?.({ ...u, session: meta.session });
            });
            upRes.on('data', (c: Buffer) => tap.push(c));
            upRes.once('end', () => tap.end());
          }
        }
        res.writeHead(status, upRes.headers);
        res.flushHeaders();
        upRes.on('error', () => res.destroy());
        upRes.on('aborted', () => {
          fail(`${req.method} ${pathname} -> ${status} stream cut by upstream`);
          res.destroy();
        });
        upRes.pipe(res);
      });
      upReq.on('error', (e: NodeJS.ErrnoException) => {
        if (dropped || stopping) return;
        if (FLUSH.has(e.code ?? '')) flush(up);
        // A kept socket that died meanwhile: sent again once, on a new one (the reusedSocket pattern in Node's http docs).
        if (upReq.reusedSocket && !answered && !resent && (plain || bodiless) && (e.code === 'ECONNRESET' || e.code === 'EPIPE')) {
          resent = true;
          log(`${req.method} ${pathname}${note} -> ${e.code} on a kept connection; sent again on a new one`);
          send(up, overrides, plain, note, retryable, tag);
          return;
        }
        const why = e.code === HEADER_TIMEOUT ? e.message : (e.code ?? e.message);
        const retry = RETRY_FAST.has(e.code ?? '');
        const status = retry ? 529 : 502;
        // The step it failed in tells our timers from the kernel's, and a dead kept socket from a dead network.
        const where = `${phase()}${upReq.reusedSocket ? ', reused socket' : ''}${e.message !== why ? `: ${e.message}` : ''}`;
        // After the headers this is the stream breaking: sendError only drops the connection.
        fail(`${req.method} ${pathname} -> upstream error ${why} (${where})`, res.headersSent ? undefined : status);
        if (retry) sendError(res, status, `upstream ${base.host} did not answer (${why})`, 'overloaded_error', { 'x-should-retry': 'true', 'retry-after': '1' });
        else sendError(res, status, `upstream ${base.host} unreachable (${why})`);
      });
      upReq.on('close', () => live.delete(upReq));
      res.on('close', () => {
        if (!res.writableFinished) {
          dropped = true;
          upReq.destroy();
        }
      });

      if (body) upReq.end(body);
      else if (bodiless) upReq.end();
      else req.pipe(upReq);
    };
    send(up, overrides, body, note, up === main ? raw : undefined, tagged);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`${req.method} ${req.url?.split('?')[0]} -> 400 ${errorMessage(err)}`, { status: 400 });
      sendError(res, 400, 'could not read request');
    });
  });
  const tunnels = new Set<net.Socket>();
  if (opts.intercept) {
    const tlsContext = tls.createSecureContext(opts.intercept);
    // A websocket to the intercepted host (Remote Control's session stream): the HTTP handler
    // drops Upgrade, so replay the handshake as sent and pass the frames through untouched.
    server.on('upgrade', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
      const lines = [`${req.method} ${main.basePath}${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      const host = main.base.hostname;
      const secure = main.base.protocol === 'https:';
      const port = Number(main.base.port) || (secure ? 443 : 80);
      const relay = () => {
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      };
      const up = secure ? tls.connect({ host, servername: host, port, ALPNProtocols: ['http/1.1'], lookup }, relay) : net.connect({ host, port, lookup }, relay);
      boundConnect(up, connectMs, (err) => up.destroy(err));
      up.on('error', (e: NodeJS.ErrnoException) => {
        log(`${req.method} ${req.url?.split('?')[0]} (websocket) -> upstream error ${e.code ?? e.message}`, { status: 502 });
        client.destroy();
      });
      client.on('error', () => up.destroy());
      client.once('close', () => up.destroy());
    });
    server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
      const [host, port] = (req.url ?? '').split(':');
      client.on('error', () => client.destroy());
      tunnels.add(client);
      client.once('close', () => tunnels.delete(client));
      if (host === main.base.hostname) {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) client.unshift(head);
        server.emit('connection', new tls.TLSSocket(client, { isServer: true, secureContext: tlsContext, ALPNProtocols: ['http/1.1'] }));
        return;
      }
      const up = net.connect({ port: Number(port) || 443, host, lookup }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      boundConnect(up, connectMs, (err) => up.destroy(err));
      up.on('error', () => client.destroy());
      client.once('close', () => up.destroy());
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  // A proxy never keeps a process alive on its own (tests, CLI scripts); the extension host outlives it anyway.
  server.unref();
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    stats: () => ({ ...stats }),
    stop: () => new Promise<void>((resolve) => {
      stopping = true;
      for (const r of live) r.destroy();
      for (const t of tunnels) t.destroy();
      for (const u of [main, ...diverted.values()]) {
        u.agent.destroy();
        u.bg.destroy();
      }
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

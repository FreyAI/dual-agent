/**
 * One proxy per upstream and kind, shared by every chat: DeepSeek gets local
 * masking of old tool results and one cache scope for all sessions; Claude gets
 * cache diagnostics and, when chosen, Anthropic's server-side tool clearing.
 * Every reply's final output count is noted for the call log. A proxy that
 * can't start means a direct connection, never a failed chat.
 *
 * In the extension the proxies run in a child process (proxy/child.ts): in the
 * extension host every connection went through VS Code's proxy layer and shared
 * an event loop with other extensions, and 2026-10-21 saw ~150 connect timeouts
 * an hour there while the same connections from a plain Node process all made it.
 */
import * as http from 'http';
import * as path from 'path';
import { ChildProcess, fork } from 'child_process';
import { Divert, ProxyHandle, ProxyOptions, requestMeta, startProxy } from './server';
import { AnthropicRequest } from './mask';
import { withToolClearing } from './contextEdit';
import { declareInlineTools } from './inlineTools';
import { stableUserIdBytes } from './cacheScope';
import { keepThinking } from './thinkingReplay';
import { fixPatterns } from './schemaFix';
import { setCacheDiagnostics, tagRequest } from './cacheDiag';
import { noteFinalOutput } from '../metrics/calls';
import { errorMessage } from '../text';
import { diag } from '../diag/log';

/** Everything DeepSeek needs reshaped, in order; undefined when nothing changed. The cache scope is patched in the bytes (stableUserIdBytes). */
export function forDeepSeek(body: AnthropicRequest): AnthropicRequest | undefined {
  let out: AnthropicRequest | undefined;
  for (const fix of [declareInlineTools, fixPatterns, keepThinking]) {
    out = fix(out ?? body) ?? out;
  }
  return out;
}

/** mask: DeepSeek with old tool results masked; fix: DeepSeek reshaped only; clear: Claude with server-side clearing; claude: Claude unchanged. */
export type ProxyKind = 'mask' | 'fix' | 'clear' | 'claude';

const isClaude = (kind: ProxyKind) => kind === 'clear' || kind === 'claude';

/** Where a Claude chat's DeepSeek helpers go: the DeepSeek proxy, its key, its fast model and (for Claude's own requests in a Remote Control session) its main one. */
export interface DeepSeekRoute { url: string; key: string; fastModel: string; mainModel?: string }

let deepseekRoute: DeepSeekRoute | undefined;

/** Set when a Claude chat with DeepSeek helpers launches; every Claude proxy then sends DeepSeek-model requests there. */
export function routeDeepSeekHelpers(route: DeepSeekRoute | undefined) {
  deepseekRoute = route;
  child?.send({ op: 'config', ...config() });
}

let cacheDiagnostics = false;
/** Claude requests carry cache diagnostics (proxy/cacheDiag.ts), in whichever process the proxies run. */
export function diagnoseCaches(on: boolean) {
  cacheDiagnostics = on;
  setCacheDiagnostics(on);
  child?.send({ op: 'config', ...config() });
}

const config = () => ({ route: deepseekRoute, cacheDiagnostics });

/** A DeepSeek-model request from a Claude chat (a helper), sent to DeepSeek with its key; the claude.ai sign-in never goes along. */
export function toDeepSeek(raw: Buffer, headers: http.IncomingHttpHeaders, route = deepseekRoute): Divert | undefined {
  // Most requests are Claude's own: the model is read without parsing the body (it can be megabytes).
  const model = route ? requestMeta(raw).model : undefined;
  if (!route || !model || !/deepseek/i.test(model)) {
    return undefined;
  }
  let reshaped: Buffer | undefined;
  if (model === route.fastModel) {
    // DeepSeek thinks unless told not to; a DeepSeek chat turns it off for Flash the same way (CLAUDE_CODE_EXTRA_BODY).
    try {
      reshaped = Buffer.from(JSON.stringify({ ...JSON.parse(raw.toString('utf8')), thinking: { type: 'disabled' } }));
    } catch {
      return undefined;
    }
  }
  const betas = String(headers['anthropic-beta'] ?? '').split(',').map((b) => b.trim()).filter((b) => b && !b.startsWith('oauth'));
  return { url: route.url, body: reshaped, headers: { authorization: undefined, cookie: undefined, 'x-api-key': route.key, 'anthropic-beta': betas.length ? betas.join(',') : undefined } };
}

/** Until when Claude is out of quota (from its 429), so a Remote Control session's Claude requests go to DeepSeek meanwhile. */
let claudeLimitedUntil = 0;

/** A Claude-model request answered by DeepSeek instead: Haiku-class background calls by the fast model, the rest by the main one. */
export function asDeepSeek(raw: Buffer, headers: http.IncomingHttpHeaders, route = deepseekRoute): Divert | undefined {
  let body: AnthropicRequest;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!route || typeof body.model !== 'string' || /deepseek/i.test(body.model)) {
    return undefined;
  }
  const model = /haiku/i.test(body.model) ? route.fastModel : (route.mainModel ?? route.fastModel);
  const renamed = Buffer.from(JSON.stringify({ ...body, model }));
  const d = toDeepSeek(renamed, headers, route);
  return d && { ...d, body: d.body ?? renamed };
}

/** When Claude's quota resets, from the 429's headers (Anthropic's unified reset in seconds, else Retry-After); 5 minutes if neither. */
export function limitResetsAt(h: http.IncomingHttpHeaders, now = Date.now()): number {
  const reset = Number(h['anthropic-ratelimit-unified-reset']);
  const after = Number(h['retry-after']);
  return reset > 0 ? reset * 1000 : after > 0 ? now + after * 1000 : now + 5 * 60_000;
}

/** What the extension does for Remote Control sessions, which no chat records: keep their usage, refuse requests over a cost limit, watch the bridge. */
export interface RemoteHooks {
  onUsage?: ProxyOptions['onUsage'];
  /** A reason to refuse a request for this model, if a cost limit is reached. */
  refuse?: (meta: { model?: string; session?: string }) => string | undefined;
  onResponse?: ProxyOptions['onResponse'];
}
let remoteHooks: RemoteHooks = {};
export function setRemoteHooks(hooks: RemoteHooks) {
  remoteHooks = hooks;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** What a proxy reports to the extension: directly here, or as messages from the child process. */
export interface ProxyHooks {
  usage(u: Parameters<NonNullable<ProxyOptions['onUsage']>>[0], intercept: boolean): void;
  response(pathname: string, status: number): void;
  refuse(meta: { model?: string; session?: string }): string | undefined | Promise<string | undefined>;
}

const local: ProxyHooks = {
  usage: (u, intercept) => {
    if (u.id && u.usage.output_tokens) {
      noteFinalOutput(u.id, u.usage.output_tokens);
    }
    if (intercept) {
      remoteHooks.onUsage?.(u);
    }
  },
  response: (pathname, status) => remoteHooks.onResponse?.(pathname, status),
  refuse: (meta) => remoteHooks.refuse?.(meta),
};

/** One proxy's options; the child process builds the same ones with hooks that message the extension. */
export function proxyOptions(upstream: string, kind: ProxyKind, intercept: { key: string; cert: string } | undefined, hooks: ProxyHooks): ProxyOptions {
  return {
    upstream,
    mask: kind === 'mask' ? {} : false,
    inject: kind === 'clear' ? (b) => withToolClearing(b) : undefined,
    tag: isClaude(kind) ? tagRequest : undefined,
    fix: isClaude(kind) ? undefined : forDeepSeek,
    patch: isClaude(kind) ? undefined : stableUserIdBytes,
    divert: isClaude(kind) ? (raw, headers) => toDeepSeek(raw, headers) ?? (intercept && Date.now() < claudeLimitedUntil ? asDeepSeek(raw, headers) : undefined) : undefined,
    intercept,
    // Remote Control only: when Claude runs out of quota mid-session, DeepSeek answers until it resets.
    fallback: intercept
      ? (raw, headers, limited) => {
          const d = asDeepSeek(raw, headers);
          if (d) {
            claudeLimitedUntil = limitResetsAt(limited);
            diag({
              kind: 'failover', level: 'warn', provider: 'claude', agent: 'remote', code: 'rate_limit', status: 429, ...requestMeta(raw),
              detail: `Claude is out of quota until ${new Date(claudeLimitedUntil).toLocaleTimeString()}; DeepSeek answers Remote Control until then`,
            });
          }
          return d;
        }
      : undefined,
    refuse: intercept ? (raw) => hooks.refuse(requestMeta(raw)) : undefined,
    onUsage: (u) => hooks.usage(u, !!intercept),
    onResponse: intercept ? (p, status) => hooks.response(p, status) : undefined,
    // Only failures are kept: a line per successful request would bury them.
    log: (line, fail) =>
      fail &&
      diag({
        kind: 'proxy', level: 'error', provider: isClaude(kind) ? 'Claude' : 'DeepSeek', status: fail.status, model: fail.model, session: fail.session,
        agent: intercept ? 'remote' : undefined, detail: line, target: hostOf(upstream),
        // Heartbeats and polls: not a sign that model calls fail (watchNetwork).
        ...(fail.background ? { background: true } : {}),
      }),
  };
}

const running = new Map<string, Promise<string | undefined>>();
const handles: ProxyHandle[] = [];
let log: (line: string) => void = () => undefined;

/** Where proxy start failures are reported (the extension's output channel). */
export function setProxyLog(fn: (line: string) => void) {
  log = fn;
}

// ---------- The child process ----------

let useChild = false;
let child: ChildProcess | undefined;
let seq = 0;
const waiting = new Map<number, { resolve: (url: string) => void; reject: (err: Error) => void }>();

/** The extension runs proxies in a child process; tests keep them here. */
export function runProxiesInChildProcess(on: boolean) {
  useChild = on;
}

/** Starts the proxy process ahead of the first request (the chat view opened); fire and forget. */
export function warmProxyProcess() {
  if (useChild) {
    proxyProcess();
  }
}

/** The proxy process's id, while one runs. */
export const proxyProcessPid = () => child?.pid;

type FromChild =
  | { op: 'started'; id: number; url?: string; error?: string }
  | { op: 'diag'; row: Parameters<typeof diag>[0] }
  | { op: 'usage'; u: Parameters<ProxyHooks['usage']>[0]; intercept: boolean }
  | { op: 'response'; pathname: string; status: number }
  | { op: 'refuse'; id: number; meta: { model?: string; session?: string } };

function proxyProcess(): ChildProcess {
  if (child) {
    return child;
  }
  // ELECTRON_RUN_AS_NODE: VS Code's binary runs as plain Node, without the extension host's patched networking.
  // UV_THREADPOOL_SIZE: DNS lookups share libuv's pool (4 threads by default) with file I/O; read only at start.
  const proc = fork(path.join(__dirname, 'child.js'), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UV_THREADPOOL_SIZE: '16' }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  proc.stderr?.on('data', (c: Buffer) => log(`[proxy process] ${c.toString().trim()}`));
  proc.on('message', (m: FromChild) => {
    switch (m.op) {
      case 'started': {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.url) w?.resolve(m.url);
        else w?.reject(new Error(m.error ?? 'no URL'));
        break;
      }
      case 'diag':
        diag(m.row);
        break;
      case 'usage':
        local.usage(m.u, m.intercept);
        break;
      case 'response':
        local.response(m.pathname, m.status);
        break;
      case 'refuse':
        void Promise.resolve(local.refuse(m.meta)).then((why) => proc.connected && proc.send({ op: 'refused', id: m.id, why }));
        break;
    }
  });
  // A dead process takes its proxies along: the next launch starts new ones (Claude Code retries meanwhile).
  proc.on('exit', (code, signal) => {
    if (child === proc) {
      child = undefined;
      running.clear();
    }
    for (const w of waiting.values()) w.reject(new Error(`proxy process exited (${signal ?? code})`));
    waiting.clear();
    log(`Proxy process exited (${signal ?? code}); proxies restart with the next session.`);
  });
  proc.on('error', (err) => log(`Proxy process: ${errorMessage(err)}`));
  proc.send({ op: 'config', ...config() });
  child = proc;
  return proc;
}

function startInChild(upstream: string, kind: ProxyKind, intercept?: { key: string; cert: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    proxyProcess().send({ op: 'start', id, upstream, kind, intercept });
  });
}

async function startHere(upstream: string, kind: ProxyKind, intercept?: { key: string; cert: string }): Promise<string> {
  const h = await startProxy(proxyOptions(upstream, kind, intercept, local));
  handles.push(h);
  return h.url;
}

/**
 * The local URL to use instead of `upstream`, or undefined to connect directly; a failed start is retried next time.
 * With `intercept` it is an HTTPS_PROXY instead, decrypting the upstream's host with that certificate (Remote Control).
 */
export async function proxyUrl(upstream: string, kind: ProxyKind, intercept?: { key: string; cert: string }): Promise<string | undefined> {
  const key = `${kind} ${upstream}${intercept ? ' intercept' : ''}`;
  if (!running.has(key)) {
    const start = useChild
      ? startInChild(upstream, kind, intercept).catch((err) => {
          log(`Proxy process couldn't start the ${kind} proxy (${errorMessage(err)}); running it in the extension instead`);
          return startHere(upstream, kind, intercept);
        })
      : startHere(upstream, kind, intercept);
    running.set(key, start.catch((err) => {
      running.delete(key);
      log(`Proxy for ${upstream} (${kind}) failed to start, connecting directly: ${errorMessage(err)}`);
      return undefined;
    }));
  }
  return running.get(key);
}

export async function stopProxies() {
  running.clear();
  const proc = child;
  child = undefined;
  proc?.kill();
  await Promise.all(handles.splice(0).map((h) => h.stop()));
}

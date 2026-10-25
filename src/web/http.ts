/** HTTP for the web tools: a browser-like request with a timeout and a size cap. */
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

/** The site refused us (rate limit, bot check); try another provider and leave this one alone for a while. */
export class BlockedError extends Error {}

/** An HTTP status that says nothing about the provider's health (a bad key, a bad query); 5xx too, but those mean it's down. */
export class StatusError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Defaults to HTML. */
  accept?: string;
  /**
   * Refuse loopback, link-local and private addresses, on every redirect hop:
   * for URLs that come from the model or from web pages, which could point it
   * at the user's own machine or network.
   */
  publicOnly?: boolean;
  /** Cancels the request; its reason (an Error) is what the request throws. */
  signal?: AbortSignal;
}

const MAX_REDIRECTS = 5;

/** Loopback, link-local, private and other non-public IPv4/IPv6 addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function assertPublic(url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) {
    throw new Error(`${host} is a local or private address; only public web pages can be read`);
  }
}

export interface HttpResponse {
  status: number;
  url: string;
  contentType: string;
  headers: Headers;
  bytes: Buffer;
  /** The body cut off at maxBytes. */
  truncated: boolean;
  text(): string;
}

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const cancel = () => controller.abort();
  opts.signal?.addEventListener('abort', cancel, { once: true });
  try {
    opts.signal?.throwIfAborted();
    const request = (target: string) =>
      fetch(target, {
        method: opts.method ?? 'GET',
        body: opts.body,
        // Checked hop by hop when only public addresses are allowed.
        redirect: opts.publicOnly ? 'manual' : 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...opts.headers,
        },
      });
    let current = url;
    if (opts.publicOnly) {
      await assertPublic(current);
    }
    let res = await request(current);
    for (let hop = 0; opts.publicOnly && res.status >= 300 && res.status < 400 && res.headers.get('location'); hop++) {
      if (hop >= MAX_REDIRECTS) {
        throw new Error(`too many redirects from ${url}`);
      }
      current = new URL(res.headers.get('location')!, current).toString();
      await assertPublic(current);
      res = await request(current);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(Buffer.from(value));
        size += value.byteLength;
        if (size > maxBytes) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    }
    const bytes = Buffer.concat(chunks).subarray(0, maxBytes);
    return {
      status: res.status,
      url: res.url || current,
      contentType: res.headers.get('content-type') ?? '',
      headers: res.headers,
      bytes,
      truncated,
      text: () => bytes.toString('utf8'),
    };
  } catch (err) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('cancelled');
    }
    if (controller.signal.aborted) {
      throw new Error(`timed out after ${Math.round((opts.timeoutMs ?? 15_000) / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', cancel);
  }
}

/** The JSON body; a captive portal's or proxy's HTML page gets a clear error instead of "Unexpected token '<'". */
export function parseJson(res: HttpResponse): any {
  if (!/json/i.test(res.contentType)) {
    throw new Error(`non-JSON reply (HTTP ${res.status}, ${res.contentType || 'no content type'})`);
  }
  return JSON.parse(res.text());
}

/** Turns an HTTP status into the right kind of failure for a search provider. */
export function checkStatus(status: number, provider: string) {
  if (status >= 200 && status < 300 && status !== 202) {
    return;
  }
  if ([202, 403, 418, 429, 503].includes(status)) {
    throw new BlockedError(`${provider} is blocking automated searches right now (HTTP ${status})`);
  }
  if (status === 401) {
    throw new StatusError(`${provider} rejected the API key`, status);
  }
  throw new StatusError(`${provider} returned HTTP ${status}`, status);
}

/**
 * A DNS cache for the proxies' upstream connections. Good answers are kept for
 * a minute; when a lookup fails or hangs (a network change, a slow resolver),
 * the last good answer is used for up to 10 minutes instead of failing the
 * request. Same signature as dns.lookup, `all: true` included (autoSelectFamily).
 */
import * as dns from 'dns';
import type { LookupFunction } from 'net';

type Resolve = (hostname: string, options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

export interface DnsCacheOptions {
  resolve?: Resolve;
  now?: () => number;
  /** How long an answer is used without asking again (default 60 s). */
  freshMs?: number;
  /** How long an old answer may stand in for a failed or slow lookup (default 10 min). */
  staleMs?: number;
  /** A lookup slower than this is answered from the old entry, if there is one (default 2 s). */
  slowMs?: number;
}

export function dnsCache(o: DnsCacheOptions = {}): LookupFunction {
  const resolve = o.resolve ?? (dns.lookup as Resolve);
  const now = o.now ?? Date.now;
  const [freshMs, staleMs, slowMs] = [o.freshMs ?? 60_000, o.staleMs ?? 600_000, o.slowMs ?? 2_000];
  const cache = new Map<string, { addresses: dns.LookupAddress[]; at: number }>();
  const pending = new Map<string, Promise<dns.LookupAddress[]>>();

  /** One lookup per key at a time; it fills the cache even after a stale answer was given. */
  const query = (key: string, hostname: string, opts: dns.LookupOptions) => {
    let p = pending.get(key);
    if (!p) {
      p = new Promise<dns.LookupAddress[]>((ok, fail) =>
        resolve(hostname, { ...opts, all: true }, (err, addresses) => {
          if (err) return fail(err);
          cache.set(key, { addresses, at: now() });
          ok(addresses);
        }),
      ).finally(() => pending.delete(key));
      pending.set(key, p);
    }
    return p;
  };

  return ((hostname: string, options: dns.LookupOptions | number | ((...a: unknown[]) => void), callback?: (...a: unknown[]) => void) => {
    const cb = (typeof options === 'function' ? options : callback)!;
    const opts: dns.LookupOptions = typeof options === 'number' ? { family: options } : typeof options === 'object' && options ? options : {};
    const key = `${hostname}|${opts.family ?? 0}|${opts.hints ?? 0}|${opts.order ?? opts.verbatim ?? ''}`;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const reply = (err: NodeJS.ErrnoException | null, addresses?: dns.LookupAddress[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err || !addresses?.length) cb(err ?? Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
      else if (opts.all) cb(null, addresses);
      else cb(null, addresses[0].address, addresses[0].family);
    };
    const hit = cache.get(key);
    const age = hit ? now() - hit.at : Infinity;
    if (hit && age < freshMs) {
      process.nextTick(reply, null, hit.addresses);
      return;
    }
    const old = hit && age < staleMs ? hit.addresses : undefined;
    query(key, hostname, opts).then((a) => reply(null, a), (err) => reply(old ? null : err, old));
    if (old) timer = setTimeout(() => reply(null, old), slowMs);
  }) as LookupFunction;
}

/** The one cache every proxy in a process shares. */
export const cachedLookup = dnsCache();

/**
 * Web search for the agents: the Brave Search and Tavily APIs when a key is set, then DuckDuckGo (HTML
 * and Lite) and Brave's public results page, which need no key. The first
 * provider with results wins; a provider that blocks is rested for a while,
 * one that times out or is down for a minute. One search gets 30 s in all.
 */
import { parseHTML } from './dom';
import { BlockedError, StatusError, checkStatus, httpRequest, parseJson } from './http';
import { collapseSpace as clean, errorMessage, short } from '../text';
import { diag } from '../diag/log';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

export interface SearchProvider {
  id: string;
  label: string;
  /** Providers sharing a key share a rate limit and a cooldown (both DuckDuckGo pages are one site). */
  rateKey: string;
  search(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

export interface SearchKeys {
  brave?: string;
  tavily?: string;
}

export const ENDPOINTS = {
  braveApi: 'https://api.search.brave.com/res/v1/web/search',
  tavily: 'https://api.tavily.com/search',
  ddgHtml: 'https://html.duckduckgo.com/html/',
  ddgLite: 'https://lite.duckduckgo.com/lite/',
  braveHtml: 'https://search.brave.com/search',
};

export type Endpoints = typeof ENDPOINTS;

const stripTags = (s: string) => clean(s.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

/** A results page we couldn't read: our parser is out of date, not a block, so the provider isn't rested. */
export class ParseError extends Error {
  /** The page's start as text (scripts and styles removed), for the failure log. */
  readonly sample: string;
  constructor(message: string, html: string) {
    super(message);
    this.sample = short(stripTags(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')), 200);
  }
}

/** DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<real url>. */
export function unwrapDdgLink(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const real = u.searchParams.get('uddg');
    if (real && u.hostname.endsWith('duckduckgo.com')) {
      return real;
    }
    return u.toString();
  } catch {
    return href;
  }
}

const DDG_BLOCK_MARKERS = ['anomaly-modal', 'error-lite@duckduckgo.com', 'bots use duckduckgo', 'challenge-form', '/anomaly.js'];

function ddgBlocked(html: string) {
  const lower = html.toLowerCase();
  return DDG_BLOCK_MARKERS.some((m) => lower.includes(m));
}

export function parseDdgHtml(html: string): SearchResult[] {
  if (ddgBlocked(html)) {
    throw new BlockedError('DuckDuckGo is showing a bot check');
  }
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  for (const el of document.querySelectorAll('.result, .web-result')) {
    if (el.classList.contains('result--ad') || el.parentElement?.closest('.result, .web-result')) {
      continue;
    }
    const link = el.querySelector('a.result__a');
    const href = link?.getAttribute('href');
    if (!link || !href) {
      continue;
    }
    results.push({ title: clean(link.textContent), url: unwrapDdgLink(href), snippet: clean(el.querySelector('.result__snippet')?.textContent) });
  }
  if (!results.length && !/no-results|No results\./i.test(html)) {
    throw new ParseError('DuckDuckGo returned a page without results', html);
  }
  return results;
}

export function parseDdgLite(html: string): SearchResult[] {
  if (ddgBlocked(html)) {
    throw new BlockedError('DuckDuckGo Lite is showing a bot check');
  }
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  let current: SearchResult | undefined;
  for (const row of document.querySelectorAll('tr')) {
    if (/sponsored/i.test(row.getAttribute('class') ?? '') || row.querySelector('.result-sponsored')) {
      current = undefined;
      continue;
    }
    const link = row.querySelector('a.result-link');
    if (link?.getAttribute('href')) {
      current = { title: clean(link.textContent), url: unwrapDdgLink(link.getAttribute('href')!), snippet: '' };
      results.push(current);
      continue;
    }
    const snippet = row.querySelector('.result-snippet');
    if (snippet && current && !current.snippet) {
      current.snippet = clean(snippet.textContent);
    }
  }
  if (!results.length && !/No results\.|no-results/i.test(html)) {
    throw new ParseError('DuckDuckGo Lite returned a page without results', html);
  }
  return results;
}

export function parseBraveHtml(html: string): SearchResult[] {
  if (/captcha/i.test(html) && !/data-type="web"/.test(html)) {
    throw new BlockedError('Brave is showing a captcha');
  }
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  for (const el of document.querySelectorAll('[data-type="web"].snippet, .snippet[data-type="web"]')) {
    const titleEl = el.querySelector('.search-snippet-title, .title');
    const link = [...el.querySelectorAll('a[href]')].find((a) => /^https?:/.test(a.getAttribute('href') ?? ''));
    if (!titleEl || !link) {
      continue;
    }
    let snippet = clean((el.querySelector('.snippet-description') ?? el.querySelector('.generic-snippet .content'))?.textContent);
    let date: string | undefined;
    const dated = snippet.match(/^(.{1,40}?\bago|[A-Z][a-z]{2} \d{1,2}, \d{4}) - (.*)$/);
    if (dated) {
      date = dated[1];
      snippet = dated[2];
    }
    results.push({ title: clean(titleEl.getAttribute('title') || titleEl.textContent), url: link.getAttribute('href')!, snippet, date });
  }
  if (!results.length && !/no results|did not match/i.test(html)) {
    throw new ParseError('Brave returned a page without results', html);
  }
  return results;
}

/** The providers in the order they're tried. API providers only appear when their key is set. */
export function buildProviders(keys: SearchKeys, endpoints: Endpoints = ENDPOINTS): SearchProvider[] {
  const providers: SearchProvider[] = [];
  if (keys.brave) {
    providers.push({
      id: 'brave-api',
      label: 'Brave Search',
      rateKey: 'brave-api',
      async search(q, count, signal) {
        const res = await httpRequest(`${endpoints.braveApi}?q=${encodeURIComponent(q)}&count=${Math.min(count, 20)}`, {
          headers: { 'X-Subscription-Token': keys.brave! },
          accept: 'application/json',
          maxBytes: 4 * 1024 * 1024,
          signal,
        });
        checkStatus(res.status, 'Brave Search');
        const data = parseJson(res);
        return (data.web?.results ?? []).map((r: any) => ({
          title: stripTags(r.title ?? ''),
          url: r.url,
          snippet: stripTags(r.description ?? r.extra_snippets?.[0] ?? ''),
          date: r.age,
        }));
      },
    });
  }
  if (keys.tavily) {
    providers.push({
      id: 'tavily',
      label: 'Tavily',
      rateKey: 'tavily',
      async search(q, count, signal) {
        const res = await httpRequest(endpoints.tavily, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys.tavily}` },
          body: JSON.stringify({ api_key: keys.tavily, query: q, max_results: Math.min(count, 20), search_depth: 'basic', include_answer: false }),
          accept: 'application/json',
          timeoutMs: 20_000,
          maxBytes: 4 * 1024 * 1024,
          signal,
        });
        checkStatus(res.status, 'Tavily');
        const data = parseJson(res);
        return (data.results ?? []).map((r: any) => ({
          title: clean(r.title),
          url: r.url,
          snippet: clean(r.content).slice(0, 500),
          date: r.published_date,
        }));
      },
    });
  }
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  providers.push(
    {
      id: 'ddg-html',
      label: 'DuckDuckGo',
      rateKey: 'ddg',
      async search(q, _count, signal) {
        const origin = new URL(endpoints.ddgHtml).origin;
        const res = await httpRequest(endpoints.ddgHtml, {
          method: 'POST',
          body: form({ q, b: '', kl: '' }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Referer: `${origin}/` },
          maxBytes: 3 * 1024 * 1024,
          signal,
        });
        checkStatus(res.status, 'DuckDuckGo');
        return parseDdgHtml(res.text());
      },
    },
    {
      id: 'ddg-lite',
      label: 'DuckDuckGo Lite',
      rateKey: 'ddg',
      async search(q, _count, signal) {
        const origin = new URL(endpoints.ddgLite).origin;
        const res = await httpRequest(endpoints.ddgLite, {
          method: 'POST',
          body: form({ q, kl: '' }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Referer: `${origin}/` },
          maxBytes: 3 * 1024 * 1024,
          signal,
        });
        checkStatus(res.status, 'DuckDuckGo Lite');
        return parseDdgLite(res.text());
      },
    },
    {
      id: 'brave-html',
      label: 'Brave',
      rateKey: 'brave-html',
      async search(q, _count, signal) {
        const res = await httpRequest(`${endpoints.braveHtml}?q=${encodeURIComponent(q)}&source=web`, {
          headers: { Referer: `${new URL(endpoints.braveHtml).origin}/` },
          maxBytes: 4 * 1024 * 1024,
          signal,
        });
        checkStatus(res.status, 'Brave');
        return parseBraveHtml(res.text());
      },
    },
  );
  return providers;
}

export interface SearchOutcome {
  results: SearchResult[];
  provider: string;
  cached: boolean;
}

interface EngineOptions {
  minGapMs?: number;
  /** Rest after a block (default 5 min). */
  cooldownMs?: number;
  /** Rest after a timeout, network error or 5xx (default 1 min). */
  failRestMs?: number;
  /** The whole search, every provider included (default 30 s). */
  deadlineMs?: number;
  cacheTtlMs?: number;
  cacheSize?: number;
}

/** URLs that differ only by case, a trailing slash or www. are the same result. */
function dedupeKey(url: string) {
  return url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
}

export class SearchEngine {
  private blockedUntil = new Map<string, number>();
  private lastRequest = new Map<string, Promise<void>>();
  private cache = new Map<string, { at: number; outcome: SearchOutcome; requested: number }>();
  private readonly minGapMs: number;
  private readonly cooldownMs: number;
  private readonly failRestMs: number;
  private readonly deadlineMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheSize: number;

  /** `providers` is called for every search, so a newly added key is used at once. */
  constructor(private readonly providers: () => SearchProvider[], opts: EngineOptions = {}) {
    this.minGapMs = opts.minGapMs ?? 1200;
    this.cooldownMs = opts.cooldownMs ?? 5 * 60_000;
    this.failRestMs = opts.failRestMs ?? 60_000;
    this.deadlineMs = opts.deadlineMs ?? 30_000;
    this.cacheTtlMs = opts.cacheTtlMs ?? 10 * 60_000;
    this.cacheSize = opts.cacheSize ?? 40;
  }

  async search(query: string, count = 6): Promise<SearchOutcome> {
    count = Math.max(1, Math.min(20, Math.round(count)));
    const key = query.toLowerCase().replace(/\s+/g, ' ').trim();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs && (hit.requested >= count || hit.outcome.results.length < hit.requested)) {
      return { ...hit.outcome, results: hit.outcome.results.slice(0, count), cached: true };
    }

    const all = this.providers();
    const now = Date.now();
    let order = all.filter((p) => (this.blockedUntil.get(p.rateKey) ?? 0) <= now);
    if (!order.length) {
      // Everything is resting: try them anyway, the one that frees up soonest first.
      order = [...all].sort((a, b) => (this.blockedUntil.get(a.rateKey) ?? 0) - (this.blockedUntil.get(b.rateKey) ?? 0));
    }

    const failures: string[] = [];
    let blocked = 0;
    let emptyFrom: string | undefined;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new Error(`out of time (${this.deadlineMs / 1000}s for the whole search)`)), this.deadlineMs);
    try {
      for (const provider of order) {
        if (emptyFrom && provider.rateKey === emptyFrom) {
          continue;
        }
        if (stop.signal.aborted) {
          break;
        }
        try {
          await this.pace(provider.rateKey);
          const seen = new Set<string>();
          const results = (await provider.search(query, count, stop.signal))
            .filter((r) => r.url && /^https?:/i.test(r.url) && !seen.has(dedupeKey(r.url)) && seen.add(dedupeKey(r.url)))
            .slice(0, count);
          if (results.length) {
            const outcome = { results, provider: provider.label, cached: false };
            this.remember(key, outcome, count);
            return outcome;
          }
          if (emptyFrom) {
            // A second opinion also found nothing: there's nothing to find.
            return { results: [], provider: provider.label, cached: false };
          }
          emptyFrom = provider.rateKey;
        } catch (err) {
          if (err instanceof BlockedError) {
            blocked++;
            this.blockedUntil.set(provider.rateKey, Date.now() + this.cooldownMs);
          } else if (err instanceof ParseError) {
            diag({ kind: 'tool_error', code: 'web_search', target: provider.label, detail: `${err.message}: ${err.sample}` });
          } else if (!stop.signal.aborted && !(err instanceof StatusError && err.status < 500)) {
            // Timed out, unreachable or down: let it recover, but not for as long as a block.
            this.blockedUntil.set(provider.rateKey, Math.max(this.blockedUntil.get(provider.rateKey) ?? 0, Date.now() + this.failRestMs));
          }
          failures.push(`${provider.label}: ${errorMessage(err)}`);
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (emptyFrom) {
      return { results: [], provider: order.find((p) => p.rateKey === emptyFrom)!.label, cached: false };
    }
    if (blocked && blocked === failures.length) {
      throw new Error(
        `Web search is blocked right now (${failures.join('; ')}). Adding a BRAVE_API_KEY or TAVILY_API_KEY line to the DeepSeek credentials file avoids this.`,
      );
    }
    throw new Error(`Web search failed. ${failures.join('; ')}`);
  }

  /** At least minGapMs between requests to the same site, callers queued in order. */
  private async pace(rateKey: string) {
    const previous = this.lastRequest.get(rateKey) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.lastRequest.set(rateKey, previous.then(() => mine));
    await previous;
    setTimeout(release, this.minGapMs);
  }

  private remember(key: string, outcome: SearchOutcome, requested: number) {
    this.cache.delete(key);
    this.cache.set(key, { at: Date.now(), outcome, requested });
    while (this.cache.size > this.cacheSize) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }
}

/**
 * The best model per tier, so the extension isn't pinned to one release.
 * DeepSeek: its model list (checked once a day) can only upgrade the known-good
 * defaults to a newer version. Claude: its aliases already resolve to the latest
 * release, so we only learn which of them this account offers.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A MODELS.md model: its id and its `key: value` attributes (keys lower-cased). */
export interface ModelEntry {
  id: string;
  attrs: Record<string, string>;
}

/** `id:` on its own line, then indented `key: value` lines; anything else is prose. Kept in file order. */
export function parseModels(md: string): ModelEntry[] {
  const out: ModelEntry[] = [];
  let cur: ModelEntry | undefined;
  for (const line of md.split(/\r?\n/)) {
    const head = /^([\w.-]+):\s*$/.exec(line);
    const attr = /^\s+([a-z][\w -]*?):\s*(.+?)\s*$/i.exec(line);
    if (head) {
      out.push((cur = { id: head[1], attrs: {} }));
    } else if (attr && cur) {
      cur.attrs[attr[1].toLowerCase()] = attr[2];
    } else if (line.trim()) {
      cur = undefined;
    }
  }
  return out.filter((e) => Object.keys(e.attrs).length);
}

let table: ModelEntry[] | undefined;

/** MODELS.md at the extension root (next to out/), read once; empty when it can't be read. */
export function modelTable(): ModelEntry[] {
  if (!table) {
    try {
      table = parseModels(fs.readFileSync(path.join(__dirname, '..', 'MODELS.md'), 'utf8'));
    } catch {
      table = [];
    }
  }
  return table;
}

export type DeepSeekTier = 'flash' | 'thinking';

/** The MODELS.md model marked `default: <tier>`. */
export function deepseekDefault(tier: DeepSeekTier): string {
  const id = modelTable().find((e) => e.attrs.default === tier)?.id;
  if (!id) {
    throw new Error(`MODELS.md has no DeepSeek model with "default: ${tier}"`);
  }
  return id;
}

const STRONG_RE = /pro|reasoner|max|ultra/i;
const FAST_RE = /flash|lite|mini|fast|chat/i;
const UNSTABLE_RE = /preview|exp|beta|test/i;
const version = (id: string) => Number(/v(\d+(?:\.\d+)?)/i.exec(id)?.[1] ?? 0);

/** The newest stable model per tier that is newer than the default; undefined keeps the default. */
export function rankDeepSeek(ids: string[]): Partial<Record<DeepSeekTier, string>> {
  const pick = (tier: DeepSeekTier) => {
    const fits = (id: string) => /deepseek/i.test(id) && !UNSTABLE_RE.test(id) && (tier === 'thinking' ? STRONG_RE.test(id) : FAST_RE.test(id) && !STRONG_RE.test(id));
    const floor = version(deepseekDefault(tier));
    return ids.filter((id) => fits(id) && version(id) > floor).sort((a, b) => version(b) - version(a))[0];
  };
  const out: Partial<Record<DeepSeekTier, string>> = {};
  for (const tier of ['flash', 'thinking'] as const) {
    const id = pick(tier);
    if (id) {
      out[tier] = id;
    }
  }
  return out;
}

/** "deepseek-v4-pro" → "V4 Pro"; an unversioned id keeps the brand ("DeepSeek Flash"). */
export function displayName(id: string): string {
  const words = id.replace(/^deepseek-/i, '').split(/[-_]/).filter(Boolean).map((w) => (/^v\d/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  return version(id) ? words.join(' ') : ['DeepSeek', ...words].join(' ');
}

interface Store {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const CACHE_KEY = 'dualAgent.deepseekModels';
const CACHE_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 5_000;

let deepseekBest: Partial<Record<DeepSeekTier, string>> = {};
let claudeOffered: string[] | undefined;

/** The discovered upgrade for a DeepSeek tier, if any. */
export const discoveredDeepSeek = (tier: DeepSeekTier): string | undefined => deepseekBest[tier];

/**
 * Reads DeepSeek's model list (OpenAI-style GET /models next to its Anthropic
 * endpoint), at most once a day. Any failure keeps the defaults and is returned
 * for the log; a chat never waits on it.
 */
export async function refreshDeepSeekModels(store: Store, baseUrl: string, key: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string | undefined> {
  const cached = store.get<{ at: number; ids: string[] }>(CACHE_KEY);
  if (cached && now - cached.at < CACHE_MS) {
    deepseekBest = rankDeepSeek(cached.ids);
    return undefined;
  }
  const url = `${new URL(baseUrl).origin}/models`;
  try {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      return `DeepSeek model list: HTTP ${res.status} from ${url}; keeping the default models`;
    }
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    if (!ids.length) {
      return `DeepSeek model list: no models in the reply from ${url}; keeping the default models`;
    }
    deepseekBest = rankDeepSeek(ids);
    await store.update(CACHE_KEY, { at: now, ids });
    return undefined;
  } catch (e) {
    return `DeepSeek model list: ${e instanceof Error ? e.message : String(e)}; keeping the default models`;
  }
}

/** The models a Claude session offers (Query.supportedModels: aliases and resolved ids). */
export function noteClaudeModels(models: { value: string; resolvedModel?: string }[]) {
  const ids = models.flatMap((m) => [m.value, m.resolvedModel ?? '']).filter(Boolean);
  claudeOffered = ids.length ? ids : undefined;
}

export type ClaudeTier = 'planner' | 'helper' | 'fast';

/** Opus plans, Sonnet does delegated work, Haiku quick jobs; a family the account doesn't offer falls back to Sonnet. Unknown until a Claude session reports its list. */
export function bestClaude(tier: ClaudeTier): string {
  const family = tier === 'planner' ? 'opus' : tier === 'fast' ? 'haiku' : 'sonnet';
  return !claudeOffered || claudeOffered.some((id) => id.toLowerCase().includes(family)) ? family : 'sonnet';
}

/** Tests only. */
export function resetModels() {
  deepseekBest = {};
  claudeOffered = undefined;
}

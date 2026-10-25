/**
 * Token usage per model, for every Claude and DeepSeek model the agents use.
 *
 * Source: the `modelUsage` on each Claude Code result, which covers the main
 * agent, helper sub-agents and compaction (the `usage` next to it is the main
 * agent only). Its numbers are running totals for the session, carried over
 * when a session is resumed, so each result is recorded as the difference
 * from what was already recorded.
 *
 * Rows are appended to one JSON-lines file per machine, so a folder synced
 * between machines merges without conflicts. Costs are computed here: Claude
 * Code prices DeepSeek models with Claude's rates.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderId } from './providers';
import { JsonlLog } from './jsonl';
import { modelTable } from './models';

/** A usage block as the API reports it on messages and results. */
export interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** The cache writes split by lifetime (Claude only): 1-hour writes cost 2x input, 5-minute ones 1.25x. */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
}

/** Every input token a request used: fresh, read from cache and written to cache. */
export const inputTokens = (u: ApiUsage) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
/** Uncached input, cache writes and output: the chat header's "new tokens". */
export const freshTokens = (u: ApiUsage) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);

export interface TokenCounts {
  /** Input not served from cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /**
   * The part of cacheWrite on the 1-hour cache, when the API said. Unset on
   * rows from before it was recorded: those are priced as they always were.
   */
  cacheWrite1h?: number;
}

export interface UsageRow extends TokenCounts {
  at: number;
  machine: string;
  session?: string;
  repo: string;
  provider: ProviderId;
  model: string;
  /** Claude on a subscription isn't billed per token; its cost is what the API would charge. */
  billing: 'subscription' | 'api';
}

export interface ModelSummary extends TokenCounts {
  model: string;
  provider: ProviderId;
  tokens: number;
  /** Share of all tokens in the summary, 0–1. */
  share: number;
  cost: number;
  costShare: number;
  /** Share of input served from cache, 0–1. */
  hitRate: number;
  /** Some of the cost is API-equivalent only (subscription). */
  notional: boolean;
}

export interface UsageSummary extends TokenCounts {
  tokens: number;
  /** Estimated cost of everything, including subscription usage at API prices. */
  cost: number;
  /** The part actually billed per token (DeepSeek, Anthropic API key). */
  billedCost: number;
  hitRate: number;
  models: ModelSummary[];
  machines: number;
  requests: number;
}

const ZERO: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const total = (c: TokenCounts) => c.input + c.cacheRead + c.cacheWrite + c.output;

// ---------- Prices (USD per 1M tokens) ----------

interface Price {
  input: number;
  cacheRead: number;
  /** Cache writes as a multiple of input (Claude); DeepSeek writes are free. */
  cacheWriteMultiplier: number;
  output: number;
  /** DeepSeek charges half outside its peak hours. */
  offPeakHalf?: boolean;
}

let prices: [RegExp, Price][] | undefined;

/** MODELS.md's models in file order; the first whose `match` (default: its id) fits a model wins. */
function priceTable(): [RegExp, Price][] {
  prices ??= modelTable()
    .filter((m) => m.attrs.input)
    .map(({ id, attrs }) => {
      const num = (key: string) => Number(attrs[key] ?? 0);
      const price: Price = { input: num('input'), cacheRead: num('cache read'), cacheWriteMultiplier: num('cache write'), output: num('output') };
      if (/^yes$/i.test(attrs['off-peak half'] ?? '')) {
        price.offPeakHalf = true;
      }
      return [new RegExp(attrs.match ?? id.replace(/\./g, '\\.'), 'i'), price];
    });
  return prices;
}

export function priceFor(model: string): Price | undefined {
  return priceTable().find(([re]) => re.test(model))?.[1];
}

/** Who serves a model: a Claude chat's helpers may run on DeepSeek, so a session's provider alone isn't enough. */
export const providerOfModel = (model: string | undefined, session: ProviderId): ProviderId => (model && /deepseek/i.test(model) ? 'deepseek' : session);

/** DeepSeek's peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. */
export function isDeepSeekPeak(at: number): boolean {
  const d = new Date(at);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

export function costOf(row: Pick<UsageRow, 'model' | 'at' | 'billing'> & TokenCounts): number {
  const p = priceFor(row.model);
  if (!p) {
    return 0;
  }
  const factor = p.offPeakHalf && !isDeepSeekPeak(row.at) ? 0.5 : 1;
  // 1-hour writes cost 2x input, 5-minute ones 1.25x. Without the API's split, the old guess: subscription
  // sessions write 1-hour, API keys 5-minute (wrong both ways since helpers use 5m and API keys 1h).
  const oneHour = p.cacheWriteMultiplier ? Math.min(row.cacheWrite, row.cacheWrite1h ?? (row.billing === 'subscription' ? row.cacheWrite : 0)) : 0;
  const writes = oneHour * 2 + (row.cacheWrite - oneHour) * p.cacheWriteMultiplier;
  return (factor * (row.input * p.input + row.cacheRead * p.cacheRead + writes * p.input + row.output * p.output)) / 1e6;
}

// ---------- Running totals → new usage ----------

/** The usage fields of one model in a Claude Code result's modelUsage. */
export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

const fromEntry = (e: ModelUsageEntry): TokenCounts => ({
  input: e.inputTokens ?? 0,
  cacheRead: e.cacheReadInputTokens ?? 0,
  cacheWrite: e.cacheCreationInputTokens ?? 0,
  output: e.outputTokens ?? 0,
});

const minus = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: Math.max(0, a.input - b.input),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  output: Math.max(0, a.output - b.output),
});


/**
 * Turns one result's running totals into the usage that is new since the last
 * result. `previous` holds this agent process's last totals per model (empty
 * for a new process); `recorded` what the ledger already has for the session.
 * A resumed process starts from the transcript's saved totals, which the
 * ledger has already recorded, so those are subtracted; a process that starts
 * from zero instead is counted from zero.
 */
export function newUsage(
  cumulative: Record<string, ModelUsageEntry>,
  previous: Map<string, TokenCounts>,
  recorded: Map<string, TokenCounts>,
): Map<string, TokenCounts> {
  const out = new Map<string, TokenCounts>();
  for (const [model, entry] of Object.entries(cumulative ?? {})) {
    const now = fromEntry(entry);
    let base = previous.get(model);
    if (!base) {
      const already = recorded.get(model) ?? ZERO;
      // Compared by total: a carried-over total includes what was recorded even
      // when one field (e.g. cache reads) was counted differently.
      base = total(now) >= total(already) ? already : ZERO;
    }
    previous.set(model, now);
    const delta = minus(now, base);
    if (total(delta) > 0) {
      out.set(model, delta);
    }
  }
  return out;
}

// ---------- The ledger ----------

export class UsageLedger {
  private readonly log: JsonlLog<UsageRow>;

  /** `dir` holds one usage-<machine>.jsonl per machine. */
  constructor(dir: string, readonly machine: string) {
    // Rows with non-numeric counts would turn every total into NaN.
    const valid = (r: any): r is UsageRow => !!r && typeof r.model === 'string' && ['input', 'cacheRead', 'cacheWrite', 'output'].every((k) => Number.isFinite(r[k]));
    this.log = new JsonlLog<UsageRow>(dir, 'usage', machine, valid);
  }

  get file(): string {
    return this.log.file;
  }

  /** Every machine's rows (re-read when the files change on disk). */
  all(): UsageRow[] {
    return this.log.all();
  }

  /** Forget the cached rows, e.g. after another machine's file synced in. */
  reload() {
    this.log.reload();
  }

  record(rows: UsageRow[]) {
    this.log.append(rows);
  }

  /** What the ledger already holds for a session, per model. */
  sessionTotals(session: string): Map<string, TokenCounts> {
    const out = new Map<string, TokenCounts>();
    for (const r of this.all()) {
      if (r.session === session && r.machine === this.machine) {
        const t = out.get(r.model) ?? { ...ZERO };
        t.input += r.input;
        t.cacheRead += r.cacheRead;
        t.cacheWrite += r.cacheWrite;
        t.output += r.output;
        out.set(r.model, t);
      }
    }
    return out;
  }

  summary(filter: (row: UsageRow) => boolean = () => true): UsageSummary {
    return summarize(this.all().filter(filter));
  }
}

export function summarize(rows: UsageRow[]): UsageSummary {
  const byModel = new Map<string, ModelSummary>();
  const sum: UsageSummary = { ...ZERO, tokens: 0, cost: 0, billedCost: 0, hitRate: 0, models: [], machines: new Set(rows.map((r) => r.machine)).size, requests: rows.length };
  for (const r of rows) {
    const cost = costOf(r);
    let m = byModel.get(r.model);
    if (!m) {
      m = { model: r.model, provider: r.provider, ...ZERO, tokens: 0, share: 0, cost: 0, costShare: 0, hitRate: 0, notional: false };
      byModel.set(r.model, m);
    }
    for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
      m[k] += r[k];
      sum[k] += r[k];
    }
    m.cost += cost;
    sum.cost += cost;
    if (r.billing === 'subscription') {
      m.notional = true;
    } else {
      sum.billedCost += cost;
    }
  }
  const hit = (c: TokenCounts) => (c.cacheRead + c.input + c.cacheWrite ? c.cacheRead / (c.cacheRead + c.input + c.cacheWrite) : 0);
  sum.tokens = total(sum);
  sum.hitRate = hit(sum);
  sum.models = [...byModel.values()]
    .map((m) => {
      m.tokens = total(m);
      m.share = sum.tokens ? m.tokens / sum.tokens : 0;
      m.costShare = sum.cost ? m.cost / sum.cost : 0;
      m.hitRate = hit(m);
      return m;
    })
    .sort((a, b) => b.tokens - a.tokens);
  return sum;
}

/** repoKey per folder: read once per session (it runs on every model call, diag row and turn). */
const repoKeys = new Map<string, string>();

/** A stable name for a repo on every machine: its git remote, else its folder name. */
export function repoKey(cwd: string): string {
  let key = repoKeys.get(cwd);
  if (key === undefined) {
    key = readRepoKey(cwd);
    repoKeys.set(cwd, key);
  }
  return key;
}

function readRepoKey(cwd: string): string {
  try {
    const config = fs.readFileSync(path.join(cwd, '.git', 'config'), 'utf8');
    const url = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1];
    if (url) {
      return url
        .replace(/^[a-z]+:\/\/([^@/]+@)?/i, '')
        .replace(/^[^@]+@([^:]+):/, '$1/')
        .replace(/\.git$/, '')
        .toLowerCase();
    }
  } catch {
    // Not a git repo.
  }
  return path.basename(cwd);
}

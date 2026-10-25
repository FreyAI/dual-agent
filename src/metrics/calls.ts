/**
 * Every model call's tokens with the agent that made it (main agent or a
 * helper by name), for the usage panel's graph in 10-minute steps and its
 * per-agent totals. Stored next to the usage ledger as calls-<machine>.jsonl.
 */
import type { ProviderId } from '../providers';
import { ApiUsage, TokenCounts, UsageRow, costOf } from '../usage';
import { JsonlLog } from '../jsonl';

export interface CallRow extends TokenCounts {
  at: number;
  machine: string;
  session?: string;
  repo: string;
  provider: ProviderId;
  agent: string;
  /** The reply it was made in (TurnMetrics.turn); unset between replies (background helpers) and for Remote Control sessions. */
  turn?: string;
  /** A helper's calls: the spawning Agent call's id (HelperRow.id), so each launch's cost adds up. */
  helper?: string;
  /** The reply that launched the helper, set when the call came between replies. */
  spawnTurn?: string;
  model: string;
  billing: UsageRow['billing'];
  /** Tokens a call gained after it was saved: added to the totals, not counted as a call. */
  delta?: boolean;
}

const isCall = (r: any): r is CallRow => !!r && typeof r.agent === 'string' && typeof r.model === 'string' && ['input', 'cacheRead', 'cacheWrite', 'output'].every((k) => Number.isFinite(r[k]));

export class CallLog extends JsonlLog<CallRow> {
  constructor(dir: string, machine: string) {
    // Older versions saved some calls twice (identical rows); count them once.
    super(dir, 'calls', machine, isCall, (r) => [r.at, r.machine, r.session, r.agent, r.model, r.input, r.cacheRead, r.cacheWrite, r.output, r.delta ? 1 : 0].join('|'));
  }
}

/**
 * Each reply's final output count by message id, as the proxies see its stream
 * end. Helpers' streams never reach the SDK and DeepSeek's messages carry 0, so
 * without this every DeepSeek helper call was logged with 0 output (2026-10-21).
 */
const finals = new Map<string, number>();
const MAX_FINALS = 2000;
const finalListeners = new Set<(id: string, output: number) => void>();

export function noteFinalOutput(id: string, output: number) {
  finals.delete(id);
  finals.set(id, output);
  if (finals.size > MAX_FINALS) {
    finals.delete(finals.keys().next().value!);
  }
  for (const fn of finalListeners) {
    fn(id, output);
  }
}

export const finalOutput = (id: string): number | undefined => finals.get(id);

export function onFinalOutput(fn: (id: string, output: number) => void): () => void {
  finalListeners.add(fn);
  return () => finalListeners.delete(fn);
}

export const callTokens = (u: ApiUsage): TokenCounts => {
  const oneHour = u.cache_creation?.ephemeral_1h_input_tokens;
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    ...(typeof oneHour === 'number' ? { cacheWrite1h: oneHour } : {}),
  };
};

const total = (t: TokenCounts) => t.input + t.cacheRead + t.cacheWrite + t.output;

export interface AgentUsage extends TokenCounts {
  name: string;
  calls: number;
  tokens: number;
  cost: number;
  models: string[];
}

export interface UsageTimeline {
  bucketMs: number;
  /** Oldest first; `byAgent` holds each agent's tokens in that bucket. */
  buckets: { at: number; tokens: number; byAgent: Record<string, number> }[];
  /** Every agent in the scope, most tokens first. */
  agents: AgentUsage[];
}

export const BUCKET_MS = 10 * 60_000;
/** A day of 10-minute bars; older calls still count in the agent totals. */
const MAX_BUCKETS = 144;

export function timeline(rows: CallRow[], now: number, bucketMs = BUCKET_MS, maxBuckets = MAX_BUCKETS): UsageTimeline {
  const agents = new Map<string, AgentUsage>();
  for (const r of rows) {
    const a = agents.get(r.agent) ?? { name: r.agent, calls: 0, tokens: 0, cost: 0, models: [], input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    a.calls += r.delta ? 0 : 1;
    a.tokens += total(r);
    a.cost += costOf(r);
    for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
      a[k] += r[k];
    }
    if (!a.models.includes(r.model)) {
      a.models.push(r.model);
    }
    agents.set(r.agent, a);
  }
  const end = Math.floor(now / bucketMs) * bucketMs;
  // A loop, not Math.min(...rows): spreading 100k+ rows overflows the stack.
  let earliest = Infinity;
  for (const r of rows) {
    earliest = Math.min(earliest, r.at);
  }
  const first = rows.length ? Math.floor(earliest / bucketMs) * bucketMs : end;
  const start = Math.max(first, end - (maxBuckets - 1) * bucketMs);
  const buckets: UsageTimeline['buckets'] = [];
  for (let at = start; at <= end; at += bucketMs) {
    buckets.push({ at, tokens: 0, byAgent: {} });
  }
  for (const r of rows) {
    const b = buckets[Math.floor((r.at - start) / bucketMs)];
    if (b) {
      b.tokens += total(r);
      b.byAgent[r.agent] = (b.byAgent[r.agent] ?? 0) + total(r);
    }
  }
  return { bucketMs, buckets, agents: [...agents.values()].sort((a, b) => b.tokens - a.tokens) };
}

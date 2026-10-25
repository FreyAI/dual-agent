/**
 * Efficiency and performance metrics, one record per finished turn: latency
 * (time to first token, total, API time), model calls, tokens and cache hits,
 * peak context, every tool's calls, errors, time and output size, retries,
 * fallbacks and compactions. Stored next to the usage ledger as
 * turns-<machine>.jsonl, summarized in the usage panel and exportable as CSV.
 * No prompt or file content is recorded.
 */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { Effort, ProviderId } from '../providers';
import type { ReplyStyle } from '../lean';
import type { TokenCounts } from '../usage';
import { JsonlLog } from '../jsonl';
import { mean, percentile } from './stats';

export interface ToolStat {
  calls: number;
  errors: number;
  /** Total time inside the tool, excluding permission prompts. */
  ms: number;
  /** Total characters the tool returned to the model (≈ tokens × 4). */
  outChars: number;
}

/** A short id for one reply: unique enough within a machine's logs, short enough to search for. */
export const newTurnId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface TurnMetrics {
  at: number;
  /** This reply's id: its failure rows (diag) and model calls carry it too. */
  turn?: string;
  /** Why auto mode picked this model for it. */
  route?: string;
  machine: string;
  session?: string;
  repo: string;
  provider: ProviderId;
  model?: string;
  effort: Effort;
  /** The settings in force, so real use doubles as an A/B comparison. */
  lean: boolean;
  replyStyle: ReplyStyle;
  outcome: 'done' | 'stopped' | 'error';
  /** Send to done, as the user waited. */
  durationMs: number;
  /** This turn's time in API calls (the SDK's figure is the process's running total). */
  apiMs?: number;
  /** Send to the first streamed text or thinking. */
  ttftMs?: number;
  /** Model requests in the turn's main loop. */
  modelCalls: number;
  /** Model requests by helper agents seen during the turn; their tokens are in `tokens`. */
  helperCalls?: number;
  /** Started by Claude Code itself (a background helper reporting back). */
  implicit?: boolean;
  /** For an automatic turn: the helper whose report started it (HelperRow.id). */
  wokenBy?: string;
  /** The report check still found claims its work didn't show. */
  unverified?: boolean;
  /** Tool output characters trimmed before the model saw them. */
  trimmedChars?: number;
  tokens: TokenCounts;
  cost: number;
  /** The largest context the main agent used in the turn. */
  contextPeak: number;
  tools: Record<string, ToolStat>;
  retries: number;
  /** Provider switches during the turn. */
  fallbacks: number;
  compactions: number;
  /** Time in our hooks (guard, after-tool, edit check, report check), by hook. */
  hooks?: Record<string, { calls: number; ms: number }>;
  /** Time a card (permission, question, plan) waited for the user. */
  blockedMs?: number;
  /** Agent processes started during the turn, and the time until each answered. */
  launches?: number;
  launchMs?: number;
  /** The first turn of a fresh process: its cache share shows what a restart costs. */
  firstOfProcess?: boolean;
  /** The reply took over a process started ahead of the message, so it didn't wait for one. */
  prewarmed?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTokens = (t: unknown) => isRecord(t) && ['input', 'cacheRead', 'cacheWrite', 'output'].every((k) => typeof t[k] === 'number');

/** A stored line summarizeTurns can read without throwing (`typeof null` is 'object', so tools is checked properly). */
const isTurn = (r: any): r is TurnMetrics =>
  isRecord(r) && typeof r.durationMs === 'number' && typeof r.modelCalls === 'number' && typeof r.cost === 'number' && isTokens(r.tokens) && isRecord(r.tools);

export class TurnLog extends JsonlLog<TurnMetrics> {
  constructor(dir: string, machine: string) {
    super(dir, 'turns', machine, isTurn);
  }
}

/** Collects one turn's measurements as its messages and hooks arrive. */
export class TurnMeter {
  /** The current reply's id (TurnMetrics.turn). */
  id = newTurnId();
  private startedAt = Date.now();
  private firstTokenAt?: number;
  private modelCalls = new Set<string>();
  private helperCalls = new Set<string>();
  private trimmed = 0;
  private contextPeak = 0;
  private tools: Record<string, ToolStat> = {};
  private retries = 0;
  private fallbacks = 0;
  private compactions = 0;
  private tokens: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private cost = 0;
  /** The process's API time at the last result: `duration_api_ms` is cumulative per process. */
  private apiTotal = 0;
  private hooks: Record<string, { calls: number; ms: number }> = {};
  private blockedMs = 0;
  private launches = 0;
  private launchMs = 0;
  /** TurnMetrics.prewarmed, set by the controller. */
  prewarmed = false;

  /** A new agent process: its API time starts from zero. */
  newProcess() {
    this.apiTotal = 0;
  }

  /** A new message from the user: everything starts from zero. */
  start() {
    this.id = newTurnId();
    this.startedAt = Date.now();
    this.firstTokenAt = undefined;
    this.modelCalls.clear();
    this.helperCalls.clear();
    this.trimmed = 0;
    this.contextPeak = 0;
    this.tools = {};
    this.retries = 0;
    this.fallbacks = 0;
    this.compactions = 0;
    this.tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    this.cost = 0;
    this.hooks = {};
    this.blockedMs = 0;
    this.launches = 0;
    this.launchMs = 0;
    this.prewarmed = false;
  }

  /** One run of one of our hooks. */
  hook(name: string, ms: number) {
    const h = (this.hooks[name] ??= { calls: 0, ms: 0 });
    h.calls++;
    h.ms += Math.max(0, ms);
  }

  /** A card waited this long for the user. */
  blocked(ms: number) {
    this.blockedMs += Math.max(0, ms);
  }

  /** An agent process started and answered after `ms`. */
  launched(ms: number) {
    this.launches++;
    this.launchMs += Math.max(0, ms);
  }

  /** Tokens a result added; a turn that switched providers has several. */
  usage(tokens: TokenCounts, cost: number) {
    this.tokens = { input: this.tokens.input + tokens.input, cacheRead: this.tokens.cacheRead + tokens.cacheRead, cacheWrite: this.tokens.cacheWrite + tokens.cacheWrite, output: this.tokens.output + tokens.output };
    this.cost += cost;
  }

  firstToken() {
    this.firstTokenAt ??= Date.now();
  }

  /** A main-loop model response (parallel tool calls share one id, so ids are counted once). */
  modelCall(id: string | undefined, context: number) {
    if (id) {
      this.modelCalls.add(id);
    }
    this.contextPeak = Math.max(this.contextPeak, context);
  }

  /** Characters a hook trimmed from a tool's output before the model saw it. */
  trim(chars: number) {
    this.trimmed += Math.max(0, chars);
  }

  /** A helper agent's model response, so its tokens aren't read as the main loop's. */
  helperCall(id: string | undefined) {
    if (id) {
      this.helperCalls.add(id);
    }
  }

  tool(name: string, ms: number, outChars: number, ok: boolean) {
    const t = (this.tools[name] ??= { calls: 0, errors: 0, ms: 0, outChars: 0 });
    t.calls++;
    t.errors += ok ? 0 : 1;
    t.ms += Math.max(0, ms);
    t.outChars += outChars;
  }

  /** What a tool's result put in front of the model, counted when the result reaches it. */
  toolOutput(name: string, chars: number) {
    (this.tools[name] ??= { calls: 0, errors: 0, ms: 0, outChars: 0 }).outChars += chars;
  }

  retry() {
    this.retries++;
  }

  /** The main loop's model calls so far, for escalating mid-turn. */
  get calls(): number {
    return this.modelCalls.size;
  }

  fallback() {
    this.fallbacks++;
  }

  compaction() {
    this.compactions++;
  }

  finish(
    base: Pick<TurnMetrics, 'machine' | 'session' | 'repo' | 'provider' | 'model' | 'effort' | 'lean' | 'replyStyle' | 'outcome' | 'implicit' | 'wokenBy' | 'unverified' | 'firstOfProcess' | 'route'>,
    result?: SDKResultMessage,
  ): TurnMetrics {
    const now = Date.now();
    const api = result?.duration_api_ms;
    // Lower than the last total: a new process the controller didn't report.
    const apiMs = api === undefined ? undefined : api >= this.apiTotal ? api - this.apiTotal : api;
    if (api !== undefined) {
      this.apiTotal = api;
    }
    return {
      at: now,
      turn: this.id,
      ...base,
      durationMs: now - this.startedAt,
      apiMs,
      ttftMs: this.firstTokenAt === undefined ? undefined : this.firstTokenAt - this.startedAt,
      modelCalls: Math.max(this.modelCalls.size, result?.num_turns ?? 0),
      helperCalls: this.helperCalls.size || undefined,
      trimmedChars: this.trimmed || undefined,
      tokens: this.tokens,
      cost: this.cost,
      contextPeak: this.contextPeak,
      tools: this.tools,
      retries: this.retries,
      fallbacks: this.fallbacks,
      compactions: this.compactions,
      hooks: Object.keys(this.hooks).length ? this.hooks : undefined,
      blockedMs: this.blockedMs || undefined,
      launches: this.launches || undefined,
      launchMs: this.launchMs || undefined,
      prewarmed: this.prewarmed,
    };
  }
}

/** Input-side tokens of a turn: fresh, cache reads and cache writes. */
export const inputSide = (t: TokenCounts) => t.input + t.cacheRead + t.cacheWrite;

export interface ToolSummary {
  name: string;
  calls: number;
  errorRate: number;
  /** Average milliseconds per call. */
  avgMs: number;
  /** Average output per call, in estimated tokens. */
  avgOutTokens: number;
  /** This tool's share of all tool output. */
  outputShare: number;
}

export interface TurnSummary {
  turns: number;
  stopped: number;
  errors: number;
  p50Ms?: number;
  p95Ms?: number;
  p50TtftMs?: number;
  avgModelCalls: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  cacheHitRate: number;
  avgContextPeak: number;
  toolCallsPerTurn: number;
  toolErrorRate: number;
  /** Estimated tool output tokens as a share of all input-side tokens. */
  toolOutputShare: number;
  costPerTurn: number;
  /** Cost of all turns divided by the replies that finished (what a finished task costs, failures included). */
  costPerDone: number;
  /** Replies the report check still flagged. */
  unverified: number;
  /** Replies Claude answered: how much the work still depends on it while it's phased out. */
  claudeTurns: number;
  /** Tool output characters trimmed before the model saw them. */
  trimmedChars: number;
  retries: number;
  fallbacks: number;
  compactions: number;
  tools: ToolSummary[];
  /** Average input-side tokens per turn with the lean workflow on and off, when both occur. */
  leanComparison?: { on: number; onTurns: number; off: number; offTurns: number };
}

/** Rows saved before the flag existed: a reply in under 20 ms wasn't waited for. */
const IMPLICIT_TTFT_MS = 20;
const isImplicit = (r: TurnMetrics) => r.implicit ?? (r.ttftMs !== undefined && r.ttftMs < IMPLICIT_TTFT_MS);

export function summarizeTurns(rows: TurnMetrics[]): TurnSummary {
  const tools = new Map<string, ToolStat>();
  for (const r of rows) {
    for (const [name, t] of Object.entries(r.tools)) {
      const acc = tools.get(name) ?? { calls: 0, errors: 0, ms: 0, outChars: 0 };
      acc.calls += t.calls;
      acc.errors += t.errors;
      acc.ms += t.ms;
      acc.outChars += t.outChars;
      tools.set(name, acc);
    }
  }
  const all = [...tools.values()];
  const calls = all.reduce((s, t) => s + t.calls, 0);
  const outChars = all.reduce((s, t) => s + t.outChars, 0);
  const inputTokens = rows.reduce((s, r) => s + inputSide(r.tokens), 0);
  const cacheRead = rows.reduce((s, r) => s + r.tokens.cacheRead, 0);
  const on = rows.filter((r) => r.lean);
  const off = rows.filter((r) => !r.lean);
  const avgIn = (list: TurnMetrics[]) => mean(list.map((r) => inputSide(r.tokens)));
  // Latency is the user's wait: turns Claude Code started itself are left out.
  const timed = rows.filter((r) => !isImplicit(r));
  return {
    turns: rows.length,
    stopped: rows.filter((r) => r.outcome === 'stopped').length,
    errors: rows.filter((r) => r.outcome === 'error').length,
    p50Ms: percentile(timed.map((r) => r.durationMs), 50),
    p95Ms: percentile(timed.map((r) => r.durationMs), 95),
    p50TtftMs: percentile(timed.flatMap((r) => (r.ttftMs === undefined ? [] : [r.ttftMs])), 50),
    avgModelCalls: mean(rows.map((r) => r.modelCalls)),
    avgInputTokens: rows.length ? inputTokens / rows.length : 0,
    avgOutputTokens: mean(rows.map((r) => r.tokens.output)),
    cacheHitRate: inputTokens ? cacheRead / inputTokens : 0,
    avgContextPeak: mean(rows.map((r) => r.contextPeak)),
    toolCallsPerTurn: rows.length ? calls / rows.length : 0,
    toolErrorRate: calls ? all.reduce((s, t) => s + t.errors, 0) / calls : 0,
    toolOutputShare: inputTokens ? outChars / 4 / inputTokens : 0,
    costPerTurn: mean(rows.map((r) => r.cost)),
    costPerDone: rows.reduce((s, r) => s + r.cost, 0) / Math.max(1, rows.filter((r) => r.outcome === 'done' && !r.implicit).length),
    unverified: rows.filter((r) => r.unverified).length,
    claudeTurns: rows.filter((r) => r.provider === 'claude').length,
    trimmedChars: rows.reduce((s, r) => s + (r.trimmedChars ?? 0), 0),
    retries: rows.reduce((s, r) => s + r.retries, 0),
    fallbacks: rows.reduce((s, r) => s + r.fallbacks, 0),
    compactions: rows.reduce((s, r) => s + r.compactions, 0),
    tools: [...tools]
      .map(([name, t]) => ({
        name,
        calls: t.calls,
        errorRate: t.errors / t.calls,
        avgMs: t.ms / t.calls,
        avgOutTokens: t.outChars / 4 / t.calls,
        outputShare: outChars ? t.outChars / outChars : 0,
      }))
      .sort((a, b) => b.outputShare - a.outputShare || b.calls - a.calls),
    leanComparison: on.length && off.length ? { on: avgIn(on), onTurns: on.length, off: avgIn(off), offTurns: off.length } : undefined,
  };
}

const CSV_COLUMNS = [
  'at', 'machine', 'repo', 'provider', 'model', 'effort', 'lean', 'replyStyle', 'outcome', 'implicit', 'durationMs', 'apiMs', 'ttftMs', 'modelCalls', 'helperCalls',
  'input', 'cacheRead', 'cacheWrite', 'output', 'cost', 'contextPeak', 'toolCalls', 'toolErrors', 'toolMs', 'toolOutChars', 'retries', 'fallbacks', 'compactions', 'tools',
] as const;

/** One CSV line per turn, for spreadsheets. */
export function turnsToCsv(rows: TurnMetrics[]): string {
  const cell = (v: unknown) => {
    const s = v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => {
    const t = Object.values(r.tools);
    const values: Partial<Record<(typeof CSV_COLUMNS)[number], unknown>> = {
      ...r,
      at: new Date(r.at).toISOString(),
      input: r.tokens.input,
      cacheRead: r.tokens.cacheRead,
      cacheWrite: r.tokens.cacheWrite,
      output: r.tokens.output,
      cost: r.cost.toFixed(6),
      toolCalls: t.reduce((s, x) => s + x.calls, 0),
      toolErrors: t.reduce((s, x) => s + x.errors, 0),
      toolMs: t.reduce((s, x) => s + x.ms, 0),
      toolOutChars: t.reduce((s, x) => s + x.outChars, 0),
      tools: Object.entries(r.tools).map(([n, x]) => `${n}:${x.calls}`).join(' '),
    };
    return CSV_COLUMNS.map((c) => cell(values[c])).join(',');
  });
  return [CSV_COLUMNS.join(','), ...lines].join('\n') + '\n';
}

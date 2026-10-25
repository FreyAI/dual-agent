/**
 * One chat's token usage and turn metrics: running totals for the chat header,
 * rows for the shared ledgers, and the usage panel's numbers per scope.
 */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { CostReport, ToWebview, Usage, UsageScope } from '../protocol';
import { ProviderId, configuredLimits, settings } from '../providers';
import { ApiUsage, ModelUsageEntry, TokenCounts, UsageLedger, UsageRow, costOf, inputTokens, isDeepSeekPeak, newUsage, providerOfModel, repoKey, summarize } from '../usage';
import { TurnLog, TurnMetrics, summarizeTurns } from '../metrics/turns';
import { percentile } from '../metrics/stats';
import { CallLog, CallRow, callTokens, finalOutput, onFinalOutput, timeline } from '../metrics/calls';
import { Spend, costRows, countingSince, limitsResetAt, spendSince } from '../costLimits';
import { HelperLog, HelperRow } from '../metrics/helpers';
import { TaskLog, summarizeTasks, taskLines } from '../metrics/tasks';
import { diag } from '../diag/log';
import { formatTokens } from '../text';
import * as path from 'path';

export const emptyUsage = (): Usage => ({ input: 0, output: 0, context: 0, cost: 0, estimate: 0 });

/** A usual day's tokens before a repo has history, and the least it may be (cache reads make days range 0.3M-250M). */
export const DEFAULT_DAY_TOKENS = 20_000_000;
export const MIN_DAY_TOKENS = 10_000_000;
const USUAL_DAYS = 7;

/** The local day a time falls on, as midnight's epoch ms. */
const dayOf = (at: number) => new Date(at).setHours(0, 0, 0, 0);

/** The average of the last week's days with usage, before today. */
export function usualDay(rows: { at: number; input: number; cacheRead: number; cacheWrite: number; output: number }[], today: number): number {
  const days = new Map<number, number>();
  for (const r of rows) {
    const d = dayOf(r.at);
    if (d < today && d >= today - USUAL_DAYS * 86_400_000) {
      days.set(d, (days.get(d) ?? 0) + r.input + r.cacheRead + r.cacheWrite + r.output);
    }
  }
  const avg = days.size ? [...days.values()].reduce((a, b) => a + b, 0) / days.size : DEFAULT_DAY_TOKENS;
  return Math.max(MIN_DAY_TOKENS, avg);
}

const ZERO: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const TOKEN_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
const callCounts = (c: TokenCounts): TokenCounts => ({ input: c.input, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, output: c.output, ...(c.cacheWrite1h !== undefined ? { cacheWrite1h: c.cacheWrite1h } : {}) });
/** Saved message ids remembered for late blocks. */
const SAVED_IDS = 1000;
/** The header's burn rate covers this long. */
const BURN_MS = 10 * 60_000;
/** A call's new tokens: what a cache read re-sends isn't new. */
const fresh = (c: TokenCounts) => c.input + c.cacheWrite + c.output;
const context = (c: TokenCounts) => c.input + c.cacheRead + c.cacheWrite;
/**
 * Ten minutes past either is a spike, logged and said once per window. A
 * usual Opus-led chat ran ~$1.70 and ~0.35M new tokens per 10 minutes on
 * 2026-10-21; its worst 10 minutes were 10.8M tokens, nearly all cache reads.
 */
const SPIKE_COST = 3;
const SPIKE_FRESH = 1_000_000;
/** A DeepSeek call that reads less than half of the previous call's cached prefix, at this size, lost its cache. */
const DROP_MIN_CONTEXT = 20_000;
/** How long the delegation split's ledger totals are reused. */
const SPLIT_CACHE_MS = 5_000;

export class ChatUsage {
  private usage = emptyUsage();
  /** The running agent process's totals per model, to turn each result into new usage. */
  private processTotals = new Map<string, TokenCounts>();
  /** The Claude Code sessions this chat has used (a fresh restart starts another). */
  private sessions = new Set<string>();
  /** This chat's rows, kept here too so the chat totals work without the ledgers. */
  private rows: UsageRow[] = [];
  private turns: TurnMetrics[] = [];
  /** The usage panel's scope while it is open, for live updates. */
  private reportScope?: UsageScope;
  /** Model calls seen but not yet saved, by message id: a call's usage repeats on each of its content blocks. */
  private pendingCalls = new Map<string, CallRow>();
  /** This chat's calls, for the graph without a log. */
  private calls: CallRow[] = [];
  /** Calls since the last result, by message id: added to the header's totals so they count up during a turn. */
  private live = new Map<string, CallRow>();
  /** Tokens already saved per message id: a later block of a saved call writes only what grew (M1). */
  private saved = new Map<string, TokenCounts>();
  /** Final output counts from the proxies, for calls whose stream the SDK never shows (helpers, DeepSeek). */
  private readonly offFinal = onFinalOutput((id, output) => this.callOutput(id, output));

  constructor(
    private readonly post: (msg: ToWebview) => void,
    private readonly cwd: () => string,
    private readonly ledger?: UsageLedger,
    /** Saving failed (e.g. the usage folder is on a drive that isn't mounted). */
    private readonly warn: (text: string) => void = () => {},
    private readonly turnLog?: TurnLog,
    private readonly callLog?: CallLog,
    private readonly helperLog?: HelperLog,
    private readonly taskLog?: TaskLog,
  ) {}

  /** Each conversation thread's last context (agent or helper, and model), for the DeepSeek cache check. */
  private threads = new Map<string, number>();
  /** When the last spike was logged. */
  private spikeAt = 0;
  /** splitTokens' last answer: one turn asks for it 3+ times. */
  private split?: { at: number; repo: string; out: Record<ProviderId, number> & { day: number } };

  dispose() {
    this.offFinal();
  }

  get machine(): string {
    return this.ledger?.machine ?? 'this-machine';
  }

  /** A new or reopened chat: its saved totals and session, or nothing. */
  reset(saved?: Usage, sessionId?: string) {
    this.usage = saved ? { ...emptyUsage(), ...saved } : emptyUsage();
    this.sessions = new Set(sessionId ? [sessionId] : []);
    this.rows = [];
    this.turns = [];
    this.pendingCalls.clear();
    this.calls = [];
    this.live.clear();
    this.saved.clear();
  }

  /** One model call by an agent; the latest usage for a message id wins until it's saved. */
  call(id: string | undefined, row: Omit<CallRow, 'at' | 'machine' | 'repo' | keyof ReturnType<typeof callTokens>>, usage: ApiUsage) {
    if (!id) {
      return;
    }
    const prev = this.pendingCalls.get(id) ?? this.live.get(id);
    const call: CallRow = { at: prev?.at ?? Date.now(), machine: this.machine, repo: repoKey(this.cwd()), ...row, ...callTokens(usage) };
    // The final count may have streamed past the proxy before this message arrived.
    call.output = Math.max(call.output, prev?.output ?? 0, finalOutput(id) ?? 0);
    if (!prev && !this.saved.has(id)) {
      this.watchCache(call);
    }
    this.pendingCalls.set(id, call);
    this.live.set(id, call);
    this.show();
  }

  /**
   * A call's final output count, from the stream's message_delta: the
   * assistant messages carry only the count so far (often 1), which left
   * output near zero until the turn's result (2026-10-19: 8k logged vs 177k).
   */
  callOutput(id: string | undefined, output: number) {
    const call = id ? (this.pendingCalls.get(id) ?? this.live.get(id)) : undefined;
    if (!call || output <= call.output) {
      return;
    }
    const updated = { ...call, output };
    this.pendingCalls.set(id!, updated);
    this.live.set(id!, updated);
    this.show();
  }

  /**
   * DeepSeek has no cache diagnostics: a call that reads much less of the
   * cache than its thread's last context (and isn't a new, shorter one) lost
   * its prefix. Masking batches cause some of these by design.
   */
  private watchCache(c: CallRow) {
    const thread = `${c.helper ?? c.agent}|${c.model}`;
    const last = this.threads.get(thread);
    const now = context(c);
    this.threads.set(thread, now);
    if (c.provider !== 'deepseek' || !last || last < DROP_MIN_CONTEXT || c.cacheRead >= last / 2 || now < last * 0.8) {
      return;
    }
    const missed = now - c.cacheRead;
    diag({
      kind: 'cache_miss', level: missed >= 50_000 ? 'warn' : 'info', provider: 'deepseek', model: c.model, session: c.session, turn: c.turn, agent: c.helper ?? (c.agent === 'Main agent' ? 'main' : c.agent),
      code: 'prefix_dropped', detail: `read ${formatTokens(c.cacheRead)} of the previous ${formatTokens(last)}; ~${formatTokens(missed)} sent at full price`,
    });
  }

  /** A helper's calls so far in this chat, for its row (metrics/helpers.ts). */
  helperTotals(id: string): Pick<HelperRow, 'calls' | 'tokens' | 'cost' | 'peakContext' | 'model'> {
    const out = { calls: 0, tokens: { ...ZERO }, cost: 0, peakContext: 0, model: undefined as string | undefined };
    for (const c of [...this.calls, ...this.pendingCalls.values()]) {
      if (c.helper !== id) {
        continue;
      }
      for (const k of TOKEN_KEYS) {
        out.tokens[k] += c[k];
      }
      out.cost += costOf(c);
      if (!c.delta) {
        out.calls++;
        out.peakContext = Math.max(out.peakContext, context(c));
        out.model = c.model;
      }
    }
    return out;
  }

  /** A finished helper's row. */
  addHelper(row: HelperRow) {
    this.save(() => this.helperLog?.append([row]), 'Helper metrics');
  }

  /** Saves the calls seen so far (at each result and before each report). */
  flushCalls() {
    const rows: CallRow[] = [];
    for (const [id, call] of this.pendingCalls) {
      const base = this.saved.get(id);
      this.saved.delete(id);
      this.saved.set(id, callCounts(call));
      if (!base) {
        rows.push(call);
        continue;
      }
      // Saved before: only the growth, flagged so it isn't counted as another call.
      const delta = callCounts(call);
      for (const k of TOKEN_KEYS) {
        delta[k] = Math.max(0, delta[k] - base[k]);
      }
      if (delta.cacheWrite1h !== undefined) {
        delta.cacheWrite1h = Math.max(0, delta.cacheWrite1h - (base.cacheWrite1h ?? 0));
      }
      if (TOKEN_KEYS.some((k) => delta[k] > 0)) {
        rows.push({ ...call, ...delta, delta: true });
      }
    }
    this.pendingCalls.clear();
    // Newest ids are last; older ones won't get more blocks.
    for (const id of this.saved.keys()) {
      if (this.saved.size <= SAVED_IDS) {
        break;
      }
      this.saved.delete(id);
    }
    if (!rows.length) {
      return;
    }
    this.calls.push(...rows);
    this.save(() => this.callLog?.append(rows), 'Call usage');
  }

  /**
   * The 1-hour part of a model's cache writes since the last result, from the
   * calls that said (modelUsage gives only the total). The main agent writes
   * 1-hour caches and helpers 5-minute ones, at 2x and 1.25x input.
   */
  private oneHourShare(model: string, cacheWrite: number): { cacheWrite1h?: number } {
    let split = 0;
    let oneHour = 0;
    for (const c of this.live.values()) {
      if (c.model === model && c.cacheWrite1h !== undefined) {
        split += c.cacheWrite;
        oneHour += c.cacheWrite1h;
      }
    }
    return split > 0 ? { cacheWrite1h: Math.round((cacheWrite * oneHour) / split) } : {};
  }

  /** A new agent process starts its totals from zero. */
  processStarted() {
    this.processTotals = new Map();
  }

  addSession(id: string) {
    this.sessions.add(id);
  }

  /** How much of the model's context the conversation fills, from the latest message. */
  setContext(u: ApiUsage) {
    this.usage.context = inputTokens(u) + (u.output_tokens ?? 0);
    this.show();
  }

  /**
   * Records the tokens each model used since the last result: main agent,
   * helpers and compaction alike (`result.usage` is the main agent only).
   * Returns what was new, for the turn's metrics.
   */
  record(result: SDKResultMessage, provider: ProviderId, subscription: boolean, sessionId?: string): { tokens: TokenCounts; cost: number } {
    const session = result.session_id || sessionId;
    if (session) {
      this.sessions.add(session);
    }
    const recorded = this.ledger && session ? this.ledger.sessionTotals(session) : new Map<string, TokenCounts>();
    const fresh = newUsage((result.modelUsage ?? {}) as unknown as Record<string, ModelUsageEntry>, this.processTotals, recorded);
    this.flushCalls();
    const at = Date.now();
    const repo = repoKey(this.cwd());
    const rows: UsageRow[] = [...fresh].map(([model, t]) => {
      const by = providerOfModel(model, provider);
      return { at, machine: this.machine, session, repo, provider: by, model, billing: subscription && by === 'claude' ? 'subscription' : 'api', ...t, ...this.oneHourShare(model, t.cacheWrite) };
    });
    this.rows.push(...rows);
    this.save(() => this.ledger?.record(rows), 'Token usage');
    const chat = this.summary('chat');
    this.usage.input = chat.input + chat.cacheRead + chat.cacheWrite;
    this.usage.output = chat.output;
    this.usage.fresh = chat.input + chat.cacheWrite + chat.output;
    this.usage.cacheRead = chat.cacheRead;
    this.usage.cost = chat.billedCost;
    this.usage.estimate = chat.cost;
    // The ledger now holds every call so far.
    this.live.clear();
    this.show();
    if (this.reportScope) {
      this.report(this.reportScope);
    }
    const tokens = rows.reduce((t, r) => ({ input: t.input + r.input, cacheRead: t.cacheRead + r.cacheRead, cacheWrite: t.cacheWrite + r.cacheWrite, output: t.output + r.output }), { ...ZERO });
    return { tokens, cost: rows.reduce((sum, r) => sum + costOf(r), 0) };
  }

  /** A finished turn's metrics. */
  addTurn(metrics: TurnMetrics) {
    this.turns.push(metrics);
    this.save(() => this.turnLog?.append([metrics]), 'Turn metrics');
    if (this.reportScope) {
      this.report(this.reportScope);
    }
  }

  /**
   * The usual number of steps a finished reply takes here: the 75th percentile
   * of finished replies, at least 20, once there are 20 to go on. A reminder
   * near it plus a cap there cut cost 24-68% with little loss (arXiv 2510.16786).
   */
  stepBudget(): number | undefined {
    const done = (this.turnLog ? this.turnLog.all() : this.turns).filter((t) => t.outcome === 'done' && !t.implicit && t.modelCalls > 0);
    if (done.length < 20) {
      return undefined;
    }
    return Math.max(20, Math.round(percentile(done.slice(-300).map((t) => t.modelCalls), 75) ?? 20));
  }

  /** Today's per-token spend across every chat and machine (subscription use excluded). */
  spentToday(): number {
    // Other windows and machines append to the ledger too.
    this.ledger?.reload();
    return this.summary('today').billedCost;
  }

  /**
   * Per-token spend since the cost limits' last reset: every chat and machine,
   * plus this chat's calls not saved yet. Counting starts the first time it's asked.
   */
  limitSpend(fresh = false): Spend {
    if (fresh) {
      this.ledger?.reload();
    }
    const since = this.ledger ? countingSince(path.dirname(this.ledger.file)) : 0;
    const rows = this.ledger ? this.ledger.all() : this.rows;
    const live = this.live;
    return spendSince((function* () { yield* rows; yield* live.values(); })(), since);
  }

  /** This repo's tokens today per provider, across every chat and machine, and its usual day, for the delegation split. */
  splitTokens(now = Date.now()): Record<ProviderId, number> & { day: number } {
    const repo = repoKey(this.cwd());
    const last = this.split;
    if (last?.repo === repo && now >= last.at && now - last.at < SPLIT_CACHE_MS && dayOf(now) === dayOf(last.at)) {
      return { ...last.out };
    }
    // Other windows and machines append to the ledger too.
    this.ledger?.reload();
    const rows = (this.ledger ? this.ledger.all() : this.rows).filter((r) => r.repo === repo);
    const today = dayOf(now);
    const out = { claude: 0, deepseek: 0, day: usualDay(rows, today) };
    for (const r of rows) {
      if (dayOf(r.at) === today) {
        out[r.provider] += r.input + r.cacheRead + r.cacheWrite + r.output;
      }
    }
    this.split = { at: now, repo, out };
    return { ...out };
  }

  /** Sends the chat header its totals, including calls made since the last result, and the last 10 minutes' burn. */
  show(now = Date.now()) {
    const usage = { ...this.usage };
    usage.estimate ??= 0;
    // Chats saved before these were counted show their old total.
    usage.fresh ??= usage.input + usage.output;
    usage.cacheRead ??= 0;
    for (const c of this.live.values()) {
      usage.input += c.input + c.cacheRead + c.cacheWrite;
      usage.output += c.output;
      usage.fresh += fresh(c);
      usage.cacheRead += c.cacheRead;
      usage.estimate += costOf(c);
      if (c.billing === 'api') {
        usage.cost += costOf(c);
      }
    }
    const burn = { tokens: 0, cost: 0 };
    const since = now - BURN_MS;
    // Saved calls and those not yet saved never overlap (live keeps saved ones until the result).
    for (const c of [...this.calls, ...this.pendingCalls.values()]) {
      if (c.at >= since) {
        burn.tokens += fresh(c);
        burn.cost += costOf(c);
      }
    }
    usage.burn = burn;
    usage.showCost = settings().get<boolean>('showCostInChat') ?? false;
    this.post({ type: 'usage', usage });
    if ((burn.cost >= SPIKE_COST || burn.tokens >= SPIKE_FRESH) && now - this.spikeAt >= BURN_MS) {
      this.spikeAt = now;
      this.spike(burn, since);
    }
  }

  /** Says, once per window, that the last 10 minutes cost unusually much and who spent it. */
  private spike(burn: { tokens: number; cost: number }, since: number) {
    const by = new Map<string, { cost: number; tokens: number; calls: number }>();
    for (const c of [...this.calls, ...this.pendingCalls.values()]) {
      if (c.at >= since) {
        const who = c.agent === 'Main agent' ? 'the main agent' : `${c.agent} helpers`;
        const a = by.get(who) ?? { cost: 0, tokens: 0, calls: 0 };
        by.set(who, { cost: a.cost + costOf(c), tokens: a.tokens + fresh(c), calls: a.calls + (c.delta ? 0 : 1) });
      }
    }
    const top = [...by].sort((a, b) => b[1].cost - a[1].cost).slice(0, 3);
    const who = top.map(([name, a]) => `${name} $${a.cost.toFixed(2)} (${a.calls} calls)`).join(', ');
    const text = `Spending fast: $${burn.cost.toFixed(2)} and ${formatTokens(burn.tokens)} new tokens in the last 10 minutes: ${who}.`;
    diag({ kind: 'burn_spike', level: 'warn', session: [...this.sessions].at(-1), detail: text });
    this.post({ type: 'notice', level: 'info', text: `${text} Dual Agent: Diagnose Token Burn shows where.` });
  }

  /** Sends the usage panel its numbers, and keeps them live while it stays open. */
  report(scope: UsageScope | undefined) {
    this.reportScope = scope;
    if (scope) {
      this.flushCalls();
      const turns = this.turnLog ? this.turnLog.all().filter(this.inScope(scope)) : this.turns;
      const calls = this.callLog ? this.callLog.all().filter(this.inScope(scope)) : this.calls;
      this.post({
        type: 'usageReport',
        scope,
        summary: this.summary(scope),
        peakNow: isDeepSeekPeak(Date.now()),
        efficiency: turns.length ? summarizeTurns(turns) : undefined,
        tasks: this.taskLog ? taskLines(summarizeTasks(this.taskLog.all())) : undefined,
        timeline: calls.length ? timeline(calls, Date.now()) : undefined,
        costs: this.costs(),
      });
    }
  }

  /** Redraws the open usage panel (a limit changed or was reset). */
  refresh() {
    this.show();
    if (this.reportScope) {
      this.report(this.reportScope);
    }
  }

  /** The Cost tab: spend counts from the last reset, or from the first limit set (none yet: nothing counted). */
  private costs(): CostReport {
    const limits = configuredLimits();
    const resetAt = () => (this.ledger ? limitsResetAt(path.dirname(this.ledger.file)) : 0);
    const counting = !!limits || resetAt() > 0;
    const spend = counting ? this.limitSpend() : { total: 0, byModel: new Map<string, number>() };
    return {
      since: counting ? resetAt() : 0,
      spent: spend.total,
      totalLimit: limits?.total ?? 0,
      spentToday: this.summary('today').billedCost,
      dailyBudget: settings().get<number>('dailyBudgetUsd') ?? 0,
      models: costRows(spend, limits?.perModel ?? {}),
    };
  }

  private save(write: () => void, what: string) {
    try {
      write();
    } catch (err) {
      this.warn(`${what} couldn't be saved: ${err instanceof Error ? err.message : String(err)}. Check the dualAgent.usageFolder setting.`);
    }
  }

  /** Which ledger entries a usage-panel scope covers. */
  private inScope(scope: UsageScope): (r: { session?: string; repo: string; at: number }) => boolean {
    const repo = repoKey(this.cwd());
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return {
      chat: (r: { session?: string }) => !!r.session && this.sessions.has(r.session),
      repo: (r: { repo: string }) => r.repo === repo,
      today: (r: { at: number }) => r.at >= today.getTime(),
      all: () => true,
    }[scope] as (r: { session?: string; repo: string; at: number }) => boolean;
  }

  private summary(scope: UsageScope) {
    // Without a ledger only this chat is known.
    return this.ledger ? this.ledger.summary(this.inScope(scope)) : summarize(this.rows);
  }
}

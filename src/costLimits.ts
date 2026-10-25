/**
 * Spend limits since the last reset, off until set: one for all spend
 * (dualAgent.costLimitUsd) and one per model (dualAgent.modelCostLimitsUsd).
 * Reaching one stops the running reply, and a model over its limit isn't used
 * again until "Dual Agent: Reset Cost Limits". Per-token spend only, like the
 * daily budget: subscription use isn't billed. The reset time is a file next
 * to the usage files, so a synced usage folder shares it between machines.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TokenCounts, UsageRow, costOf } from './usage';

export interface CostLimits { total: number; perModel: Record<string, number> }

export interface Spend { total: number; byModel: Map<string, number> }

type Billable = Pick<UsageRow, 'model' | 'at' | 'billing'> & TokenCounts;

/** Limits of 0 or less are off; on when any is set. */
export function activeLimits(total: number | undefined, perModel: Record<string, unknown> | undefined): CostLimits | undefined {
  const models = Object.fromEntries(Object.entries(perModel ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0));
  const t = typeof total === 'number' && total > 0 ? total : 0;
  return t || Object.keys(models).length ? { total: t, perModel: models } : undefined;
}

export function spendSince(rows: Iterable<Billable>, since: number): Spend {
  const spend: Spend = { total: 0, byModel: new Map() };
  for (const r of rows) {
    if (r.at < since || r.billing !== 'api') {
      continue;
    }
    const cost = costOf(r);
    spend.total += cost;
    spend.byModel.set(r.model, (spend.byModel.get(r.model) ?? 0) + cost);
  }
  return spend;
}

/** Claude Code's aliases name a family; a limit's key may be a family or a full id ("claude-sonnet", "deepseek-flash"). */
const ALIAS: Record<string, string> = { sonnet: 'claude-sonnet', opus: 'claude-opus', haiku: 'claude-haiku' };
const covers = (key: string, model: string) => {
  const m = ALIAS[model] ?? model;
  return m.startsWith(key) || key.startsWith(m);
};

export interface LimitStatus {
  /** Spend since the reset and the limit, when the total limit is set. */
  total?: { spent: number; limit: number };
  /** Per limited model key. */
  models: { key: string; spent: number; limit: number }[];
}

export function limitStatus(spend: Spend, limits: CostLimits): LimitStatus {
  const models = Object.entries(limits.perModel).map(([key, limit]) => {
    let spent = 0;
    for (const [model, cost] of spend.byModel) {
      if (covers(key, model)) {
        spent += cost;
      }
    }
    return { key, spent, limit };
  });
  return { total: limits.total ? { spent: spend.total, limit: limits.total } : undefined, models };
}

/** The Cost tab's rows: each limited key with its spend, then every other model that spent since the reset (limit 0). */
export function costRows(spend: Spend, perModel: Record<string, number>): LimitStatus['models'] {
  const limited = limitStatus(spend, { total: 0, perModel }).models;
  const others = [...spend.byModel].filter(([m, cost]) => cost > 0 && !limited.some((l) => covers(l.key, m))).map(([key, spent]) => ({ key, spent, limit: 0 }));
  return [...limited, ...others.sort((a, b) => b.spent - a.spent)];
}

export const totalReached = (s: LimitStatus) => !!s.total && s.total.spent >= s.total.limit;

/** The limited keys a model (an id or an alias) has used up. */
export const cappedKeys = (s: LimitStatus, model: string | undefined) => (model ? s.models.filter((m) => m.spent >= m.limit && covers(m.key, model)).map((m) => m.key) : []);

/** Limits at 80% or more but not reached; `key` is "all" for the total. */
export function nearing(s: LimitStatus): { key: string; text: string }[] {
  const all = s.total ? [{ key: 'all', ...s.total }] : [];
  return [...all, ...s.models]
    .filter((m) => m.spent >= m.limit * 0.8 && m.spent < m.limit)
    .map((m) => ({ key: m.key, text: `${m.key === 'all' ? 'all models' : m.key}: ${usd(m.spent)} of ${usd(m.limit)}` }));
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

const RESET_FILE = 'cost-limits-reset.json';

/** When the limits were last reset (0: never, so all recorded spend counts). */
export function limitsResetAt(dir: string): number {
  try {
    const at = JSON.parse(fs.readFileSync(path.join(dir, RESET_FILE), 'utf8')).at;
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/** The start of the count: the last reset, or now (saved) when there was none, so old spend never counts against a new limit. */
export function countingSince(dir: string, now = Date.now()): number {
  const since = limitsResetAt(dir);
  if (since) {
    return since;
  }
  try {
    resetLimits(dir, now);
  } catch {
    // An unwritable usage folder: count from now in this process.
  }
  return now;
}

/** Why a request for `model` must not be sent, when a limit is reached; for Remote Control, where no chat checks. */
export function limitRefusal(status: LimitStatus, model: string | undefined): string | undefined {
  const help = 'Run "Dual Agent: Reset Cost Limits" in VS Code or raise the limit to continue.';
  if (totalReached(status)) {
    return `Dual Agent cost limit reached: ${usd(status.total!.spent)} of ${usd(status.total!.limit)} since the last reset. ${help}`;
  }
  const keys = cappedKeys(status, model);
  return keys.length ? `Dual Agent cost limit reached for ${keys.join(', ')}. ${help}` : undefined;
}

export function resetLimits(dir: string, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RESET_FILE), JSON.stringify({ at: now }));
}

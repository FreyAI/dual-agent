/**
 * Cost per completed task: a task is the run of turns from the message that
 * starts a piece of work (router.startsTask) to its outcome, so the number
 * answers "what does finishing something cost" rather than "what does a reply
 * cost". Rows hold counts and costs only, never prompts or file content.
 */
import { JsonlLog } from '../jsonl';
import { percentile } from './stats';
import type { TurnMetrics } from './turns';

export type TaskOutcome = 'done' | 'blocked' | 'abandoned' | 'unknown';

export interface TaskRow {
  at: number;
  endedAt: number;
  machine: string;
  session?: string;
  repo: string;
  /** Costliest model first; the first is the task's main model. */
  models: string[];
  /** Why auto mode picked the first turn's model. */
  route?: string;
  turns: number;
  /** Includes helper spend (helper tokens are already in each turn's cost). */
  cost: number;
  /** The part of `cost` spent by helper agents. */
  helperCost: number;
  tokens: number;
  durationMs: number;
  outcome: TaskOutcome;
  /** False when any turn edited without a passing check; absent for no turns. */
  verified?: boolean;
}

const isTask = (r: any): r is TaskRow =>
  !!r && typeof r === 'object' && typeof r.cost === 'number' && typeof r.turns === 'number' && typeof r.durationMs === 'number' && Array.isArray(r.models) && typeof r.outcome === 'string';

export class TaskLog extends JsonlLog<TaskRow> {
  constructor(dir: string, machine: string) {
    super(dir, 'tasks', machine, isTask);
  }
}

/** How a task ended: the agent finished it, or the user moved on. */
export type TaskEnd = 'finished' | 'needs_you' | 'new_chat' | 'new_task';

/** Collects the turns of the task in progress; `end` turns them into one row. */
export class TaskMeter {
  private turns: TurnMetrics[] = [];
  private helperCost = 0;

  get open(): boolean {
    return this.turns.length > 0;
  }

  /** Call after each finished turn with the helper spend attributed to it. */
  add(turn: TurnMetrics, helperCost = 0) {
    this.turns.push(turn);
    this.helperCost += helperCost;
  }

  /** Closes the task; undefined when no turn ran. A new task with no finish is unknown if the last reply succeeded, else abandoned. */
  end(how: TaskEnd, now = Date.now()): TaskRow | undefined {
    const ts = this.turns;
    if (!ts.length) {
      return undefined;
    }
    const last = ts[ts.length - 1];
    const outcome: TaskOutcome =
      how === 'finished' ? 'done' : how === 'needs_you' ? 'blocked' : how === 'new_chat' ? 'abandoned' : last.outcome === 'done' ? 'unknown' : 'abandoned';
    const byModel = new Map<string, number>();
    for (const t of ts) {
      if (t.model) {
        byModel.set(t.model, (byModel.get(t.model) ?? 0) + t.cost);
      }
    }
    const first = ts[0];
    const row: TaskRow = {
      at: first.at,
      endedAt: now,
      machine: first.machine,
      session: first.session,
      repo: first.repo,
      models: [...byModel].sort((a, b) => b[1] - a[1]).map(([m]) => m),
      route: first.route,
      turns: ts.length,
      cost: ts.reduce((s, t) => s + t.cost, 0),
      helperCost: this.helperCost,
      tokens: ts.reduce((s, t) => s + t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite + t.tokens.output, 0),
      durationMs: ts.reduce((s, t) => s + t.durationMs, 0),
      outcome,
      verified: !ts.some((t) => t.unverified),
    };
    this.turns = [];
    this.helperCost = 0;
    return row;
  }
}

export interface TaskGroup {
  key: string;
  tasks: number;
  done: number;
  /** Cost of the done tasks only. */
  median?: number;
  p90?: number;
}

export interface TaskSummary {
  tasks: number;
  done: number;
  /** done / all tasks; 0 for none. */
  completionRate: number;
  abandoned: number;
  helperShare: number;
  byModel: TaskGroup[];
  byRoute: TaskGroup[];
}

function group(rows: TaskRow[], keyOf: (r: TaskRow) => string): TaskGroup[] {
  const by = new Map<string, TaskRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by]
    .map(([key, rs]) => {
      const costs = rs.filter((r) => r.outcome === 'done').map((r) => r.cost);
      return { key, tasks: rs.length, done: costs.length, median: percentile(costs, 50), p90: percentile(costs, 90) };
    })
    .sort((a, b) => b.tasks - a.tasks);
}

/** Cost per completed task by main model and by router choice, plus how many tasks finish. */
export function summarizeTasks(rows: TaskRow[]): TaskSummary {
  const done = rows.filter((r) => r.outcome === 'done').length;
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  return {
    tasks: rows.length,
    done,
    completionRate: rows.length ? done / rows.length : 0,
    abandoned: rows.filter((r) => r.outcome === 'abandoned').length,
    helperShare: cost ? rows.reduce((s, r) => s + r.helperCost, 0) / cost : 0,
    byModel: group(rows, (r) => r.models[0] ?? 'unknown'),
    byRoute: group(rows, (r) => r.route ?? 'manual'),
  };
}

const usd = (n?: number) => (n === undefined ? '-' : `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`);

/** Short lines for the usage panel: one overall line, then the top groups. */
export function taskLines(s: TaskSummary, top = 3): string[] {
  if (!s.tasks) {
    return [];
  }
  const line = (g: TaskGroup) => `${g.key}: ${usd(g.median)} median, ${usd(g.p90)} p90 (${g.done}/${g.tasks} done)`;
  return [
    `${s.done} of ${s.tasks} tasks finished (${Math.round(s.completionRate * 100)}%)${s.abandoned ? `, ${s.abandoned} abandoned` : ''}`,
    ...s.byModel.slice(0, top).map(line),
    ...s.byRoute.slice(0, top).map((g) => `route ${line(g)}`),
  ];
}

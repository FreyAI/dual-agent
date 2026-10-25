/**
 * Pure aggregation for the eval: one Row per (task, arm, run) becomes per-arm
 * and per-task tables plus a paired comparison against the first arm. No vscode
 * or file access here, so it is unit-tested directly.
 */
import { bootstrapRatioCI, mean, pairedDifference, percentile } from '../../metrics/stats';

export interface Row {
  task: string;
  arm: string;
  kind: string;
  run: number;
  pass: boolean;
  /** The final reply said it was done/fixed/working. */
  claimedDone: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cost: number;
  durationMs: number;
  toolCalls: number;
  toolErrors: number;
  modelCalls: number;
  outcome: string;
  gradeOutput: string;
}

/** The parts of a turn's metrics the eval reads (structural, so no import of the agent). */
export interface TurnLike {
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
  cost: number;
  durationMs: number;
  modelCalls: number;
  tools: Record<string, { calls: number; errors: number }>;
  outcome: string;
}

/** Sums the metrics of several turns (a run can take more than one when the agent pauses). */
export function combine(turns: TurnLike[]) {
  const sum = { input: 0, cacheRead: 0, output: 0, cost: 0, durationMs: 0, modelCalls: 0, toolCalls: 0, toolErrors: 0, outcome: 'done' };
  for (const t of turns) {
    sum.input += t.tokens.input + t.tokens.cacheWrite;
    sum.cacheRead += t.tokens.cacheRead;
    sum.output += t.tokens.output;
    sum.cost += t.cost;
    sum.durationMs += t.durationMs;
    sum.modelCalls += t.modelCalls;
    for (const tool of Object.values(t.tools)) {
      sum.toolCalls += tool.calls;
      sum.toolErrors += tool.errors;
    }
    if (t.outcome !== 'done') {
      sum.outcome = t.outcome;
    }
  }
  return sum;
}

const NEGATED = /\b(could not|couldn'?t|unable|can'?t|cannot|can not|not (yet )?(done|fixed|working|complete)|did not|didn'?t|failed to|still (fail|broken|not))/i;
const CLAIM = /\b(done|fixed|completed?|implemented|resolved|all (the )?tests? (now )?pass(es|ed)?|now (works|passes|pass)|successfully|is working|are passing)\b/i;

/** Does the reply claim success? A sentence with a negation does not count. */
export function claimsDone(reply: string): boolean {
  return reply
    .split(/(?<=[.!?\n])\s+/)
    .some((sentence) => CLAIM.test(sentence) && !NEGATED.test(sentence));
}

export interface Summary {
  name: string;
  runs: number;
  solved: number;
  passRate: number;
  costPerRun: number;
  /** Total cost divided by solved runs; undefined when nothing was solved. */
  costPerSolved?: number;
  inputTokens: number;
  outputTokens: number;
  p50Ms?: number;
  p95Ms?: number;
  toolCalls: number;
  toolErrors: number;
  /** Share of failed runs where the reply still claimed success. */
  falseDoneRate: number;
  falseDone: number;
}

/** Per-group totals and rates. */
export function summarize(name: string, rows: Row[]): Summary {
  const solved = rows.filter((r) => r.pass);
  const failed = rows.filter((r) => !r.pass);
  const falseDone = failed.filter((r) => r.claimedDone).length;
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const times = rows.map((r) => r.durationMs);
  return {
    name,
    runs: rows.length,
    solved: solved.length,
    passRate: rows.length ? solved.length / rows.length : 0,
    costPerRun: rows.length ? totalCost / rows.length : 0,
    costPerSolved: solved.length ? totalCost / solved.length : undefined,
    inputTokens: mean(rows.map((r) => r.inputTokens)),
    outputTokens: mean(rows.map((r) => r.outputTokens)),
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    toolCalls: mean(rows.map((r) => r.toolCalls)),
    toolErrors: mean(rows.map((r) => r.toolErrors)),
    falseDoneRate: failed.length ? falseDone / failed.length : 0,
    falseDone,
  };
}

const groupBy = (rows: Row[], key: (r: Row) => string) => {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  }
  return groups;
};

export interface Comparison {
  arm: string;
  baseline: string;
  /** Tasks both arms ran. */
  tasks: number;
  passDiff: { mean: number; low: number; high: number };
  /** Geometric mean of per-task cost ratios (arm / baseline) with a bootstrap interval. */
  costRatio?: { ratio: number; low: number; high: number };
}

/** Paired comparison of every arm against the first one, over tasks both ran. */
export function compare(rows: Row[], arms: string[]): Comparison[] {
  const byArm = new Map(arms.map((a) => [a, groupBy(rows.filter((r) => r.arm === a), (r) => r.task)]));
  const base = byArm.get(arms[0]);
  if (!base) {
    return [];
  }
  return arms.slice(1).map((arm) => {
    const other = byArm.get(arm) ?? new Map<string, Row[]>();
    const shared = [...base.keys()].filter((t) => other.has(t));
    const rate = (g: Row[]) => g.filter((r) => r.pass).length / g.length;
    const cost = (g: Row[]) => mean(g.map((r) => r.cost));
    const ratios = shared.filter((t) => cost(base.get(t)!) > 0 && cost(other.get(t)!) > 0).map((t) => cost(other.get(t)!) / cost(base.get(t)!));
    const ci = ratios.length ? bootstrapRatioCI(ratios) : undefined;
    return {
      arm,
      baseline: arms[0],
      tasks: shared.length,
      passDiff: pairedDifference(shared.map((t) => rate(base.get(t)!)), shared.map((t) => rate(other.get(t)!))),
      costRatio: ci ? { ratio: Math.exp(mean(ratios.map(Math.log))), low: ci[0], high: ci[1] } : undefined,
    };
  });
}

const pct = (x: number) => (x * 100).toFixed(0) + '%';
const usd = (x?: number) => (x === undefined ? 'n/a' : '$' + x.toFixed(x < 0.1 ? 4 : 3));
const sec = (ms?: number) => (ms === undefined ? 'n/a' : (ms / 1000).toFixed(1) + 's');
const num = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1));
const table = (head: string[], body: string[][]) =>
  [head, head.map(() => '---'), ...body].map((r) => '| ' + r.join(' | ') + ' |').join('\n');

/** The Markdown summary: per arm, per task, and paired comparisons. */
export function renderReport(rows: Row[], arms?: string[]): string {
  if (!rows.length) {
    return '# Eval report\n\nNo runs.\n';
  }
  const armList = arms ?? [...new Set(rows.map((r) => r.arm))];
  const tasks = [...new Set(rows.map((r) => r.task))];
  const out = ['# Eval report', '', rows.length + ' runs, ' + armList.length + ' arms, ' + tasks.length + ' tasks.', '', '## Per arm', ''];
  out.push(
    table(
      ['arm', 'runs', 'pass', 'cost/run', 'cost/solved', 'in tok', 'out tok', 'p50', 'p95', 'tools', 'tool errs', 'false done'],
      armList.map((a) => {
        const s = summarize(a, rows.filter((r) => r.arm === a));
        return [a, String(s.runs), pct(s.passRate), usd(s.costPerRun), usd(s.costPerSolved), num(s.inputTokens), num(s.outputTokens), sec(s.p50Ms), sec(s.p95Ms), num(s.toolCalls), num(s.toolErrors), pct(s.falseDoneRate) + ' (' + s.falseDone + ')'];
      }),
    ),
  );
  out.push('', '## Per task (pass / runs)', '');
  out.push(
    table(
      ['task', ...armList],
      tasks.map((t) => [
        t,
        ...armList.map((a) => {
          const g = rows.filter((r) => r.task === t && r.arm === a);
          return g.length ? g.filter((r) => r.pass).length + '/' + g.length : '-';
        }),
      ]),
    ),
  );
  const cmp = compare(rows, armList);
  if (cmp.length) {
    out.push('', '## Paired comparison vs ' + armList[0], '');
    out.push(
      table(
        ['arm', 'tasks', 'pass rate diff (95%)', 'cost ratio (95% CI)'],
        cmp.map((c) => [
          c.arm,
          String(c.tasks),
          (c.passDiff.mean * 100).toFixed(1) + ' pts [' + (c.passDiff.low * 100).toFixed(1) + ', ' + (c.passDiff.high * 100).toFixed(1) + ']',
          c.costRatio ? c.costRatio.ratio.toFixed(2) + 'x [' + c.costRatio.low.toFixed(2) + ', ' + c.costRatio.high.toFixed(2) + ']' : 'n/a',
        ]),
      ),
    );
  }
  return out.join('\n') + '\n';
}

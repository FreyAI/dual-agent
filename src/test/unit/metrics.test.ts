import '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bootstrapRatioCI, geometricMean, pairedDifference, percentile } from '../../metrics/stats';
import { timeline } from '../../metrics/calls';
import { TurnLog, TurnMeter, TurnMetrics, summarizeTurns, turnsToCsv } from '../../metrics/turns';
import { summarize } from '../../agent/present';

const base = { machine: 'm', repo: 'r', provider: 'deepseek' as const, effort: 'thinking' as const, lean: true, replyStyle: 'full' as const, outcome: 'done' as const };

function turn(over: Partial<TurnMetrics>): TurnMetrics {
  return {
    at: 1,
    ...base,
    durationMs: 1000,
    modelCalls: 2,
    tokens: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 },
    cost: 0.01,
    contextPeak: 1000,
    tools: {},
    retries: 0,
    fallbacks: 0,
    compactions: 0,
    ...over,
  };
}

test('statistics: percentiles, geometric mean, bootstrap interval, paired difference', () => {
  assert.equal(percentile([], 50), undefined);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.ok(Math.abs(percentile([1, 2, 3, 4], 95)! - 3.85) < 1e-9);
  assert.ok(Math.abs(geometricMean([0.5, 2]) - 1) < 1e-9);
  const [lo, hi] = bootstrapRatioCI([0.6, 0.7, 0.65, 0.8, 0.55]);
  assert.ok(lo < 0.67 && hi > 0.62 && hi < 1, `${lo}..${hi}`);
  assert.deepEqual(bootstrapRatioCI([0.6, 0.7, 0.65]), bootstrapRatioCI([0.6, 0.7, 0.65]), 'reproducible');
  const d = pairedDifference([1, 1, 0, 1], [1, 0, 0, 1]);
  assert.equal(d.mean, -0.25);
  assert.ok(d.low < d.mean && d.high > d.mean);
});

test('the meter collects one turn: first token, model calls counted once, tools, retries, usage across a switch', () => {
  const m = new TurnMeter();
  m.start();
  m.firstToken();
  m.firstToken();
  m.modelCall('msg1', 5000);
  m.modelCall('msg1', 5000);
  m.modelCall('msg2', 8000);
  m.tool('Read', 12, 400, true);
  m.tool('Read', 8, 600, true);
  m.tool('Bash', 100, 30, false);
  m.retry();
  m.fallback();
  m.usage({ input: 10, cacheRead: 20, cacheWrite: 0, output: 5 }, 0.001);
  m.usage({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, 0.002);
  const t = m.finish(base);
  assert.equal(t.modelCalls, 2);
  assert.equal(t.contextPeak, 8000);
  assert.deepEqual(t.tools.Read, { calls: 2, errors: 0, ms: 20, outChars: 1000 });
  assert.equal(t.tools.Bash.errors, 1);
  assert.deepEqual(t.tokens, { input: 11, cacheRead: 22, cacheWrite: 3, output: 9 });
  assert.ok(Math.abs(t.cost - 0.003) < 1e-12);
  assert.equal(t.retries, 1);
  assert.equal(t.fallbacks, 1);
  assert.ok(t.ttftMs !== undefined && t.ttftMs >= 0);
});

test('turn summary: latency percentiles, cache rate, tool shares and error rate, lean on/off comparison', () => {
  const s = summarizeTurns([
    turn({ durationMs: 1000, ttftMs: 300, tools: { Read: { calls: 3, errors: 0, ms: 30, outChars: 3000 } } }),
    turn({ durationMs: 3000, ttftMs: 500, tools: { Read: { calls: 1, errors: 0, ms: 10, outChars: 1000 }, Bash: { calls: 2, errors: 1, ms: 200, outChars: 4000 } } }),
    turn({ durationMs: 2000, lean: false, outcome: 'stopped', tokens: { input: 1000, cacheRead: 1000, cacheWrite: 0, output: 10 } }),
  ]);
  assert.equal(s.turns, 3);
  assert.equal(s.stopped, 1);
  assert.equal(s.p50Ms, 2000);
  assert.equal(s.p50TtftMs, 400);
  assert.equal(s.toolCallsPerTurn, 2);
  assert.equal(s.toolErrorRate, 1 / 6);
  assert.equal(s.cacheHitRate, 2800 / 4000);
  assert.equal(s.toolOutputShare, 8000 / 4 / 4000);
  assert.deepEqual(s.tools.map((t) => t.name), ['Read', 'Bash'], 'ordered by output share (tie: calls)');
  assert.equal(s.tools[0].outputShare, 0.5);
  assert.deepEqual(s.leanComparison, { on: 1000, onTurns: 2, off: 2000, offTurns: 1 });
});

test('turns are stored per machine, invalid lines skipped, and export as CSV', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-turns-'));
  const log = new TurnLog(dir, 'mac');
  log.append([turn({ tools: { Read: { calls: 2, errors: 0, ms: 5, outChars: 10 } } })]);
  fs.appendFileSync(log.file, 'not json\n{"durationMs":"x"}\n');
  const bad = turn({});
  for (const broken of [{ tools: null }, { tools: [] }, { tokens: { input: 'x' } }, { modelCalls: undefined }, { cost: null }]) {
    fs.appendFileSync(log.file, JSON.stringify({ ...bad, ...broken }) + '\n');
  }
  fs.writeFileSync(path.join(dir, 'usage-mac.jsonl'), '{"model":"m"}\n');
  const fresh = new TurnLog(dir, 'mac');
  assert.equal(fresh.all().length, 1, 'null tools, bad tokens and missing numbers are skipped');
  assert.doesNotThrow(() => summarizeTurns(fresh.all()));
  const csv = turnsToCsv(fresh.all()).trim().split('\n');
  assert.equal(csv.length, 2);
  assert.match(csv[0], /^at,machine,repo,provider/);
  assert.match(csv[1], /,Read:2$/);
});

test('the line under a reply shows all-model tokens, cache share, tools and first token', () => {
  const line = summarize('deepseek', false, undefined, false, turn({ ttftMs: 1200, durationMs: 8200, tools: { Read: { calls: 3, errors: 1, ms: 1, outChars: 1 } } }));
  assert.equal(line, 'DeepSeek · 1,000 in / 50 out tokens · 90% cached · 3 tools (1 failed) · first token 1.2s · 8.2s');
});

test('a billed reply shows this turn\'s cost from our prices and its helper calls, never the CLI\'s session total', () => {
  const result = { total_cost_usd: 7.07, usage: { input_tokens: 1, output_tokens: 1 } } as any;
  const line = summarize('deepseek', false, result, true, turn({ cost: 0.0123, helperCalls: 4 }));
  assert.match(line, /\$0\.0123/);
  assert.doesNotMatch(line, /7\.07/);
  assert.match(line, /helpers 4 calls/);
  assert.doesNotMatch(summarize('claude', false, result, false, turn({ cost: 0.5 })), /\$/, 'a subscription shows no cost');
});

test('usage timeline: 10-minute buckets stacked by agent, and per-agent totals with cost', () => {
  const t0 = Date.UTC(2026, 9, 17, 12, 0);
  const call = (min: number, agent: string, input: number, cacheRead = 0) =>
    ({ at: t0 + min * 60_000, machine: 'm', repo: 'r', provider: 'deepseek' as const, agent, model: 'deepseek-flash', billing: 'api' as const, input, cacheRead, cacheWrite: 0, output: 10 });
  const t = timeline([call(1, 'Main agent', 1000, 9000), call(4, 'crm-bridge', 500), call(25, 'Main agent', 200)], t0 + 31 * 60_000);
  assert.equal(t.bucketMs, 600_000);
  assert.deepEqual(t.buckets.map((b) => b.tokens), [10_010 + 510, 0, 210, 0]);
  assert.deepEqual(t.buckets[0].byAgent, { 'Main agent': 10_010, 'crm-bridge': 510 });
  assert.deepEqual(t.agents.map((a) => [a.name, a.calls, a.tokens]), [['Main agent', 2, 10_220], ['crm-bridge', 1, 510]]);
  assert.ok(t.agents[0].cost > 0);
  assert.equal(timeline([call(0, 'a', 1)], t0 + 3 * 86_400_000).buckets.length, 144, 'a day of bars at most');
  const many = Array.from({ length: 200_000 }, (_, i) => call(i % 50, 'a', 1));
  assert.equal(timeline(many, t0 + 60 * 60_000).agents[0].calls, 200_000, '"All time" with 200k rows doesn\'t overflow the stack');
});

test('API time is stored per turn, not as the process\'s running total', () => {
  const m = new TurnMeter();
  const api = (ms: number) => m.finish(base, { duration_api_ms: ms } as any).apiMs;
  assert.equal(api(1000), 1000);
  assert.equal(api(1500), 500);
  assert.equal(m.finish(base).apiMs, undefined, 'a turn without a result has none');
  assert.equal(api(1800), 300);
  m.newProcess();
  assert.equal(api(400), 400, 'a new process starts from zero');
  // A lower total without newProcess(): a new process.
  assert.equal(api(200), 200);
});

test('implicit turns (flagged, or old rows under 20 ms to first token) are left out of latency', () => {
  const s = summarizeTurns([
    turn({ durationMs: 1000, ttftMs: 500 }),
    turn({ durationMs: 3000, ttftMs: 700 }),
    turn({ durationMs: 10, ttftMs: 3, implicit: true }),
    turn({ durationMs: 20, ttftMs: 5 }),
  ]);
  assert.equal(s.turns, 4, 'they still count as turns');
  assert.equal(s.p50TtftMs, percentile([500, 700], 50));
  assert.equal(s.p50Ms, percentile([1000, 3000], 50));
  assert.equal(s.p95Ms, percentile([1000, 3000], 95));
});

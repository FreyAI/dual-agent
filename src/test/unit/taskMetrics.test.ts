/** Task metrics: boundary and outcome mapping, cost with helpers, and summaries with no or abandoned tasks. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskLog, TaskMeter, TaskRow, summarizeTasks, taskLines } from '../../metrics/tasks';
import type { TurnMetrics } from '../../metrics/turns';

function turn(over: Partial<TurnMetrics>): TurnMetrics {
  return {
    at: 1, machine: 'm', repo: 'r', provider: 'deepseek', effort: 'thinking', lean: true, replyStyle: 'full', outcome: 'done',
    durationMs: 1000, modelCalls: 1, tokens: { input: 10, cacheRead: 20, cacheWrite: 0, output: 5 }, cost: 0.1, contextPeak: 1, tools: {},
    retries: 0, fallbacks: 0, compactions: 0, model: 'flash', ...over,
  } as TurnMetrics;
}

test('task meter: sums turns, splits helper cost, picks the costliest model', () => {
  const m = new TaskMeter();
  assert.equal(m.end('finished'), undefined, 'no turns, no row');
  m.add(turn({ model: 'flash', cost: 0.1, route: 'edit' }), 0.02);
  m.add(turn({ model: 'pro', cost: 0.5, unverified: true }), 0.1);
  const row = m.end('finished', 99)!;
  assert.deepEqual([row.turns, row.outcome, row.models, row.route, row.endedAt, row.verified], [2, 'done', ['pro', 'flash'], 'edit', 99, false]);
  assert.ok(Math.abs(row.cost - 0.6) < 1e-9 && Math.abs(row.helperCost - 0.12) < 1e-9);
  assert.equal(row.tokens, 70);
  assert.equal(row.durationMs, 2000);
  assert.equal(m.open, false);
  assert.equal(m.end('new_chat'), undefined, 'reset after ending');
});

test('task meter: outcome mapping', () => {
  const end = (how: Parameters<TaskMeter['end']>[0], outcome: TurnMetrics['outcome']) => {
    const m = new TaskMeter();
    m.add(turn({ outcome }));
    return m.end(how)!.outcome;
  };
  assert.equal(end('finished', 'done'), 'done');
  assert.equal(end('needs_you', 'done'), 'blocked');
  assert.equal(end('new_chat', 'done'), 'abandoned');
  assert.equal(end('new_task', 'done'), 'unknown');
  assert.equal(end('new_task', 'stopped'), 'abandoned');
  assert.equal(end('new_task', 'error'), 'abandoned');
});

const row = (over: Partial<TaskRow>): TaskRow => ({ at: 1, endedAt: 2, machine: 'm', repo: 'r', models: ['flash'], turns: 1, cost: 1, helperCost: 0, tokens: 1, durationMs: 1, outcome: 'done', ...over });

test('summary: empty data gives zeros and no lines', () => {
  const s = summarizeTasks([]);
  assert.deepEqual([s.tasks, s.completionRate, s.helperShare, s.byModel], [0, 0, 0, []]);
  assert.deepEqual(taskLines(s), []);
});

test('summary: cost percentiles count done tasks only; abandoned lower the rate', () => {
  const s = summarizeTasks([
    row({ cost: 1 }), row({ cost: 3 }), row({ cost: 100, outcome: 'abandoned' }),
    row({ models: ['pro'], cost: 10, helperCost: 5, route: 'plan' }), row({ models: ['pro'], outcome: 'blocked' }),
  ]);
  assert.equal(s.completionRate, 0.6);
  assert.equal(s.abandoned, 1);
  const flash = s.byModel.find((g) => g.key === 'flash')!;
  assert.deepEqual([flash.tasks, flash.done, flash.median], [3, 2, 2]);
  assert.equal(s.byModel.find((g) => g.key === 'pro')!.median, 10);
  assert.deepEqual(s.byRoute.map((g) => g.key).sort(), ['manual', 'plan']);
  assert.ok(taskLines(s)[0].startsWith('3 of 5 tasks finished (60%), 1 abandoned'));
  const none = summarizeTasks([row({ outcome: 'abandoned' })]);
  assert.equal(none.byModel[0].median, undefined, 'no done task, no median');
});

test('task log: round-trips rows and drops malformed lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
  const log = new TaskLog(dir, 'm');
  log.append([row({ cost: 2 })]);
  fs.appendFileSync(path.join(dir, 'tasks-m.jsonl'), '{"cost":"x"}\nnot json\n');
  assert.deepEqual(log.all().map((r) => r.cost), [2]);
});

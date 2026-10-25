/**
 * Tests for the eval harness itself: every task must fail as shipped and pass
 * with its known solution (so the hidden checks are meaningful), plus the
 * grading edge cases and the pure report maths. No model is called.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { gradeFolder, gradeFresh, setUp } from '../eval/grade';
import { Row, claimsDone, combine, compare, renderReport, summarize } from '../eval/report';
import { EvalTask, TASKS, writeFiles } from '../eval/tasks';
import { HARD_IDS, HARD_TASKS, LOAD_ERRORS } from '../eval/hard';

const EASY = TASKS.filter((t) => t.difficulty !== 'hard');

test('there are 12 easy tasks with the requested mix', () => {
  assert.equal(EASY.length, 12);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  const count = (kind: string) => EASY.filter((t) => t.kind === kind).length;
  assert.deepEqual([count('bugfix'), count('feature'), count('refactor'), count('fix-tests'), count('write-tests'), count('lint')], [3, 3, 2, 2, 1, 1]);
});

for (const task of TASKS) {
  test('task ' + task.id + ': fails as shipped', async () => {
    const g = await gradeFresh(task, false);
    assert.equal(g.pass, false, g.output);
  });
  test('task ' + task.id + ': passes with the solution', async () => {
    const g = await gradeFresh(task, true);
    assert.equal(g.pass, true, g.output);
  });
  test('task ' + task.id + ': prompt does not leak hidden file names', () => {
    // Visible test files are re-written as hidden too (undoing agent edits), so only hidden-only files count.
    for (const name of Object.keys(task.hidden).filter((n) => !(n in task.files))) {
      assert.ok(!task.prompt.includes(name), name);
    }
  });
}

for (const id of HARD_IDS) {
  test('hard task ' + id + ' loads', () => {
    assert.equal(LOAD_ERRORS[id], undefined, LOAD_ERRORS[id]);
  });
}

for (const { task, naive } of HARD_TASKS) {
  test('hard task ' + task.id + ': is marked hard and has a naive fix to beat', () => {
    assert.equal(task.difficulty, 'hard');
    assert.ok(naive.length > 0);
  });
  naive.forEach((n, i) => {
    test('hard task ' + task.id + ': naive fix ' + (i + 1) + ' is still failed by the hidden tests', async () => {
      const start = task.files[n.file];
      assert.ok(start?.includes(n.replace[0]), n.file + ' does not contain the text the naive fix replaces');
      const g = await gradeFresh({ ...task, solution: { [n.file]: start.replace(n.replace[0], n.replace[1]) } }, true);
      assert.equal(g.pass, false, 'the naive fix passed');
    });
  });
}

test("the extension's own memory files don't fail the rename check", async () => {
  const task = TASKS.find((t) => t.id === 'refactor-rename')!;
  const withMemory: EvalTask = { ...task, solution: { ...task.solution, '.dual-agent/memory/handoff.md': 'Renamed calcTotal to orderTotal.' } };
  assert.equal((await gradeFresh(withMemory, true)).pass, true);
});

test('lint task fails when the solution uses console.log', async () => {
  const task = TASKS.find((t) => t.kind === 'lint')!;
  const bad: EvalTask = { ...task, solution: { 'src/temperature.js': task.solution['src/temperature.js'].replace('const round1', "console.log('x');\nconst round1") } };
  const g = await gradeFresh(bad, true);
  assert.equal(g.pass, false);
  assert.match(g.output, /console\.log/);
});

test('write-tests task fails when the agent writes only weak tests', async () => {
  const task = TASKS.find((t) => t.kind === 'write-tests')!;
  const weak: EvalTask = {
    ...task,
    solution: { 'test/cart.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { cartTotal } = require('../src/cart');\ntest('a', () => assert.equal(cartTotal([]), 0));\n" },
  };
  const g = await gradeFresh(weak, true);
  assert.equal(g.pass, false);
});

test('grading a missing command gives a clear message', async () => {
  const task: EvalTask = { ...TASKS[0], check: ['definitely-not-a-command-xyz'] };
  const root = setUp(task);
  const g = await gradeFolder(root, task, 5000);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(g.pass, false);
  assert.match(g.output, /could not start "definitely-not-a-command-xyz"/);
});

test('grading kills a check that hangs and says so', async () => {
  const task: EvalTask = { ...TASKS[0], check: ['node', '-e', 'setInterval(() => {}, 1000)'] };
  const root = setUp(task);
  const started = Date.now();
  const g = await gradeFolder(root, task, 300);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(g.pass, false);
  assert.match(g.output, /timed out/);
  assert.ok(Date.now() - started < 5000);
});

test('hidden files overwrite the agent\'s edits', async () => {
  const task = TASKS.find((t) => t.id === 'fix-tests-inventory')!;
  const root = setUp(task, true);
  writeFiles(root, { 'test/inventory.test.js': "require('node:test').test('x', () => { throw new Error('edited away'); });\n" });
  const g = await gradeFolder(root, task);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(g.pass, true, g.output);
});

// ---------- report ----------

const row = (over: Partial<Row>): Row => ({
  task: 't1', arm: 'a', kind: 'bugfix', run: 0, pass: true, claimedDone: true, inputTokens: 100, outputTokens: 10, cacheRead: 0,
  cost: 0.1, durationMs: 1000, toolCalls: 4, toolErrors: 1, modelCalls: 3, outcome: 'done', gradeOutput: '', ...over,
});

test('claimsDone sees success claims and ignores negated ones', () => {
  assert.equal(claimsDone('I fixed the bug and all tests pass.'), true);
  assert.equal(claimsDone("I couldn't fix it."), false);
  assert.equal(claimsDone('Here is what I found.'), false);
});

test('summarize averages repetitions and reports false done', () => {
  const s = summarize('a', [row({ pass: true, run: 0 }), row({ pass: false, run: 1, claimedDone: true })]);
  assert.equal(s.runs, 2);
  assert.equal(s.passRate, 0.5);
  assert.equal(s.costPerRun, 0.1);
  assert.equal(s.falseDone, 1);
});

test('compare pairs each arm against the first over shared tasks', () => {
  const rows = [row({ task: 'x', arm: 'b' }), row({ task: 'x', arm: 'h', pass: false, claimedDone: true }), row({ task: 'y', arm: 'b' })];
  const [c] = compare(rows, ['b', 'h']);
  assert.equal(c.tasks, 1);
  assert.ok(c.passDiff.mean < 0);
});

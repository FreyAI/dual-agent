import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { LoopGuard, fileDumpReason, signature } from '../../agent/loops';

test('loops: the same call returning the same result is nudged at the 3rd try and refused at the 4th, per agent', () => {
  const g = new LoopGuard();
  const read = { file_path: '/a.ts', offset: 1 };
  assert.deepEqual(g.check('main', 'Read', read), {});
  g.result('main', 'Read', read, true, 'h1');
  assert.deepEqual(g.check('main', 'Read', read), {});
  g.result('main', 'Read', read, true, 'h1');
  assert.match(g.check('main', 'Read', read).nudge ?? '', /returned the same result/);
  g.result('main', 'Read', read, true, 'h1');
  assert.match(g.check('main', 'Read', { offset: 1, file_path: '/a.ts' }).deny ?? '', /same result 3 times/, 'key order ignored');
  assert.deepEqual(g.check('helper-1', 'Read', read), {}, 'other agents are counted separately');
});

test('loops: polling that sees a different result each time is not a loop', () => {
  const g = new LoopGuard();
  for (let i = 0; i < 6; i++) {
    assert.equal(g.check('main', 'Bash', { command: 'curl -s localhost:3000/health' }).deny, undefined);
    g.result('main', 'Bash', { command: 'curl -s localhost:3000/health' }, true, `h${i}`);
  }
});

test('loops: alternating between two calls is nudged, then refused', () => {
  const g = new LoopGuard();
  const a = { command: 'ls src' };
  const b = { command: 'ls test' };
  const verdicts = [a, b, a, b, a, b, a].map((x, i) => {
    const v = g.check('main', 'Bash', x);
    g.result('main', 'Bash', x, true, `r${i}`);
    return v;
  });
  assert.ok(verdicts[4].nudge, 'A B A B A: nudge');
  assert.ok(verdicts[6].deny, 'A B A B A B A: refused');
});

test('loops: a command that failed twice is refused until something changes', () => {
  const g = new LoopGuard();
  const cmd = { command: './deploy.sh staging' };
  for (let i = 0; i < 2; i++) {
    assert.equal(g.check('main', 'Bash', cmd).deny, undefined);
    g.result('main', 'Bash', cmd, false, `e${i}`);
  }
  assert.match(g.check('main', 'Bash', cmd).deny ?? '', /already failed 2 times/);
  g.result('main', 'Edit', { file_path: '/a.ts' }, true, 'x');
  assert.deepEqual(g.check('main', 'Bash', cmd), {}, 'after an edit, running it again is progress');
});

test('loops: dumping source files through the shell is refused; pipes, filtered output, logs and writes are not', () => {
  for (const c of ['cat src/a.ts', "sed -n '1,200p' App/Mail/MailTools.swift", 'head -120 CLAUDE.md', 'cd "/Volumes/T7 Shield/x" && cat lib/crm/index.ts lib/crm/keys.ts', 'cat src/a.ts || true', 'cat src/a.ts && npm test | tail -5']) {
    assert.ok(fileDumpReason(c), c);
  }
  for (const c of ['git show HEAD:src/a.ts | head -40', 'npm test 2>&1 | tail -5', 'tail -f server.log', 'cat > notes.md <<EOF', 'ls src', 'grep -n foo src/a.ts', 'tail -50 build.log', 'cat package.json | jq .version', 'cat x.ts | grep foo', 'cat a.ts b.ts|wc -l']) {
    assert.equal(fileDumpReason(c), undefined, c);
  }
});

test('loops: a test or build rerun is never refused for failing before (a fix may have happened elsewhere)', () => {
  const g = new LoopGuard();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(g.check('main', 'Bash', { command: 'npm test' }), {});
    g.result('main', 'Bash', { command: 'npm test' }, false, `out${i}`);
  }
  assert.equal(g.check('main', 'Bash', { command: 'npm test' }).deny, undefined, 'a helper fixed it: re-run');
  for (let i = 0; i < 2; i++) {
    g.check('main', 'Bash', { command: 'ls missing' });
    g.result('main', 'Bash', { command: 'ls missing' }, false, 'x' + i);
  }
  assert.match(g.check('main', 'Bash', { command: 'ls missing' }).deny ?? '', /already failed 2 times/);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutoCheckConfig, CheckResult, MAX_CHECK_SENDS, plannedChecks, runAutoChecks, runCommand, sendBackText, unverifiedNotice } from '../../agent/autoCheck';
import { Conventions } from '../../memory/conventions';
import { newEvidence, recordTool } from '../../agent/verify';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'autocheck-'));
const node = (js: string) => `node -e ${JSON.stringify(js)}`;
const conv = (c: Record<string, string>): Conventions => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { command: v, source: 'test' }]));
const cfg = (mode: AutoCheckConfig['mode'] = 'all', timeoutMs = 10_000): AutoCheckConfig => ({ mode, timeoutMs, testTimeoutMs: timeoutMs });
const edited = () => {
  const ev = newEvidence();
  recordTool(ev, 'Edit', { file_path: '/repo/src/a.ts' }, true);
  return ev;
};

test('autoCheck: passing checks run in order typecheck, lint, test in the workspace', async () => {
  const dir = tmp();
  const log = (name: string) => node(`require('fs').appendFileSync('order.txt', '${name},')`);
  const r = await runAutoChecks(dir, conv({ test: log('test'), lint: log('lint'), typecheck: log('typecheck') }), edited(), cfg());
  assert.deepEqual(r.map((x) => x.status), ['passed', 'passed', 'passed']);
  assert.equal(fs.readFileSync(path.join(dir, 'order.txt'), 'utf8'), 'typecheck,lint,test,', 'ran with cwd = workspace');
  assert.equal(sendBackText(r, []), undefined);
  assert.equal(unverifiedNotice(r, false), undefined);
});

test('autoCheck: a failure stops the run and the send-back text names command, exit and trimmed output', async () => {
  const fail = node("console.log('\\u001b[31msrc/a.ts(3,1): error TS2322\\u001b[0m'); process.exit(2)");
  const r = await runAutoChecks(tmp(), conv({ typecheck: fail, lint: node('process.exit(0)') }), edited(), cfg());
  assert.equal(r.length, 1, 'later checks are not run');
  assert.equal(r[0].exit, 2);
  const text = sendBackText(r, []) ?? '';
  assert.ok(text.startsWith('Checks failed after your edits: '), text);
  assert.match(text, /exit 2\nsrc\/a\.ts\(3,1\): error TS2322\nFix these, or say why they're unrelated\.$/);
  assert.doesNotMatch(text, /\u001b/);
});

test('autoCheck: long failure output is trimmed', async () => {
  const r = await runAutoChecks(tmp(), conv({ typecheck: node("for (let i=0;i<5000;i++) console.log('error line '+i); process.exit(1)") }), edited(), cfg());
  assert.ok(r[0].detail.length < 4000, String(r[0].detail.length));
});

test('autoCheck: a timeout kills the command and is unverified, not a block', async () => {
  const t0 = Date.now();
  const r = await runAutoChecks(tmp(), conv({ typecheck: node('setTimeout(()=>{}, 30000)') }), edited(), cfg('typecheck', 300));
  assert.ok(Date.now() - t0 < 5000, 'killed promptly');
  assert.equal(r[0].status, 'unverified');
  assert.match(r[0].detail, /timed out after 0\.3s \(killed\)/);
  assert.equal(sendBackText(r, []), undefined);
  assert.match(unverifiedNotice(r, false) ?? '', /^Not verified: .*timed out/);
});

test('autoCheck: a spawn error is reported, not swallowed', async () => {
  const gone = '/nonexistent/dir/for/autocheck';
  const r = await runCommand('true', gone, 5000);
  assert.ok(r.error, 'spawn failure surfaces as error');
  const res = await runAutoChecks(gone, conv({ typecheck: 'true' }), edited(), cfg());
  assert.equal(res[0].status, 'unverified');
  assert.match(res[0].detail, /could not start: /);
});

test('autoCheck: command not found is unverified, not a failure', async () => {
  const r = await runAutoChecks(tmp(), conv({ typecheck: 'definitely-not-a-command-xyz' }), edited(), cfg());
  assert.equal(r[0].status, 'unverified');
  assert.equal(sendBackText(r, []), undefined);
});

test('autoCheck: nothing runs without edits or when off; typecheck mode runs only typecheck', () => {
  const c = conv({ typecheck: 'tc', lint: 'li', test: 'te' });
  assert.deepEqual(plannedChecks(c, newEvidence(), 'all'), [], 'no edits this turn');
  assert.deepEqual(plannedChecks(c, edited(), 'off'), []);
  assert.deepEqual(plannedChecks(c, edited(), 'typecheck').map((p) => p.kind), ['typecheck']);
  assert.deepEqual(plannedChecks(c, edited(), 'all').map((p) => p.kind), ['typecheck', 'lint', 'test']);
  assert.deepEqual(plannedChecks({}, edited(), 'all'), [], 'missing commands are skipped');
});

test('autoCheck: a test that passed after the last edit is skipped, a narrowed or failed one is not', () => {
  const c = conv({ test: 'npm test' });
  const ev = edited();
  recordTool(ev, 'Bash', { command: 'npm test' }, true);
  assert.deepEqual(plannedChecks(c, ev, 'all'), [], 'full run passed since the edit');
  const narrow = edited();
  recordTool(narrow, 'Bash', { command: 'node --test out/test/unit/a.test.js' }, true);
  assert.equal(plannedChecks(c, narrow, 'all').length, 1);
  const failed = edited();
  recordTool(failed, 'Bash', { command: 'npm test' }, false);
  assert.equal(plannedChecks(c, failed, 'all').length, 1);
  const before = newEvidence();
  recordTool(before, 'Bash', { command: 'npm test' }, true);
  recordTool(before, 'Edit', { file_path: '/repo/src/a.ts' }, true);
  assert.equal(plannedChecks(c, before, 'all').length, 1, 'a passing run before the edit does not count');
});

test('autoCheck: the same failure set is sent once, and at most twice a turn', () => {
  const fail = (command: string): CheckResult[] => [{ command, status: 'failed', exit: 1, detail: 'boom' }];
  const sent: string[] = [];
  assert.ok(sendBackText(fail('a'), sent));
  assert.equal(sendBackText(fail('a'), sent), undefined, 'same set again');
  assert.ok(sendBackText(fail('b'), sent));
  assert.equal(sent.length, MAX_CHECK_SENDS);
  assert.equal(sendBackText(fail('c'), sent), undefined, 'cap reached');
  assert.match(unverifiedNotice(fail('c'), false) ?? '', /c still fails \(exit 1\)/);
  assert.equal(unverifiedNotice(fail('c'), true), undefined, 'a send-back needs no notice');
});

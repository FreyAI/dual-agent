import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { failureIn, gitChangedAcross, gitChangedFiles, mergeEvidence, newEvidence, recordTool, resetEvidence, sendBackReason, unsupportedClaims, isCheckCommand, TEST_COMMAND, BUILD_COMMAND } from '../../agent/verify';

const bash = (command: string, ok = true) => ['Bash', { command }, ok] as const;

test('verify: "tests pass" needs a test run in the turn, and its last run must have passed', () => {
  const ev = newEvidence();
  assert.match(unsupportedClaims('Done. All 42 tests pass.', ev)[0], /no test command ran/);
  recordTool(ev, ...bash('npm test', false));
  assert.match(unsupportedClaims('The suite is green.', ev)[0], /last test run failed \(npm test\)/);
  recordTool(ev, ...bash('npm test 2>&1 | tail -5'));
  assert.deepEqual(unsupportedClaims('619/620 pass; the failure is known.', ev), []);
});

test('verify: honest hedges and plain statements are not claims', () => {
  const ev = newEvidence();
  assert.deepEqual(unsupportedClaims('I wrote the fix but the tests were not run yet.', ev), []);
  assert.deepEqual(unsupportedClaims('The test file covers the parser.', ev), []);
});

test('verify: "builds" needs a build or test command', () => {
  const ev = newEvidence();
  assert.match(unsupportedClaims('It builds cleanly now.', ev)[0], /no build or test command ran/);
  recordTool(ev, ...bash('swift build'));
  assert.deepEqual(unsupportedClaims('It builds cleanly now.', ev), []);
});

test('verify: a file the reply says it changed must be edited or show in git', () => {
  const ev = newEvidence();
  recordTool(ev, 'Edit', { file_path: '/repo/src/mail.ts' }, true);
  assert.deepEqual(unsupportedClaims('I updated `src/mail.ts` and fixed the timeout.', ev, []), []);
  assert.match(unsupportedClaims('I added a guard to `src/router.ts`.', ev, [])[0], /changed src\/router\.ts, but that file has no changes/);
  assert.deepEqual(unsupportedClaims('I added a guard to `src/router.ts`.', ev, ['src/router.ts']), [], 'a script edit shows in git');
  assert.deepEqual(unsupportedClaims('I added a guard to `src/router.ts`.', ev), [], 'unknown outside git');
});

test('verify: "done" with open to-dos is a claim; asking a question is not', () => {
  const ev = newEvidence();
  recordTool(ev, 'TodoWrite', { todos: [{ content: 'Write tests', status: 'completed' }, { content: 'Wire the UI', status: 'pending' }] }, true);
  assert.match(unsupportedClaims('All done!', ev)[0], /1 to-do item is still open: Wire the UI/);
  assert.deepEqual(unsupportedClaims('Should I wire the UI next?', ev), []);
  resetEvidence(ev);
  assert.equal(ev.todos.length, 2, 'the to-do list carries over a reset');
  assert.match(sendBackReason(['x']), /correct the report/);
});

test('verify: failures hidden behind a zero exit code are found in the output', () => {
  assert.equal(failureIn('Tests: 3 passed, 0 failed'), undefined);
  assert.equal(failureIn('Test Files  1 failed | 12 passed\nTests  2 failed | 80 passed'), 'Test Files  1 failed | 12 passed');
  assert.match(failureIn('src/a.ts(3,1): error TS2304: Cannot find name') ?? '', /error TS2304/);
  assert.match(failureIn('ok 1 - a\nnot ok 2 - b') ?? '', /^not ok 2/);
  assert.match(failureIn('/x/App.swift:12:5: error: cannot find foo') ?? '', /error: cannot find/);
  assert.equal(failureIn('all good\n0 errors'), undefined);
});

test('verify: changing several things but testing one is sent back; untested code with a "done" too', () => {
  const ev = newEvidence();
  for (const f of ['/r/src/mail.ts', '/r/src/links.ts', '/r/src/search.ts']) {
    recordTool(ev, 'Edit', { file_path: f }, true);
  }
  assert.match(unsupportedClaims('Done.', ev)[0], /changed code \(mail\.ts, links\.ts, search\.ts\) but ran no tests or build/);
  assert.deepEqual(unsupportedClaims('Done, but not tested yet.', ev), [], 'an honest "not tested" passes');
  recordTool(ev, 'Bash', { command: 'npx vitest run test/mail.test.ts' }, true);
  assert.match(unsupportedClaims('Done. Tests pass.', ev)[0], /changed 3 code files but only ran some tests .*links, search/);
  recordTool(ev, 'Bash', { command: 'npm test' }, true);
  assert.deepEqual(unsupportedClaims('Done. Tests pass.', ev), [], 'the full suite covers it');
});

test('verify: git changes include new, renamed and non-ASCII files, without taking the index lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'old.ts'), 'a');
  git('add', '.');
  git('commit', '-qm', 'x');
  git('mv', 'old.ts', 'renamed.ts');
  fs.writeFileSync(path.join(dir, 'café.ts'), 'b');
  const files = await gitChangedFiles(dir);
  assert.ok(files?.includes('renamed.ts'));
  assert.ok(files?.includes('café.ts'), 'non-ASCII names come through unquoted');
  assert.ok(!files?.includes('old.ts'), 'the old name of a rename is skipped');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'index.lock')));
  assert.equal(await gitChangedFiles(os.tmpdir()), undefined, 'outside git: unknown');
});

test('verify: a file changed in another repo counts (2026-10-19: loader.py was flagged though a helper changed it)', async () => {
  const mk = (name: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  };
  const ws = mk('ws');
  const other = mk('other');
  fs.mkdirSync(path.join(other, 'tools'));
  fs.writeFileSync(path.join(other, 'tools', 'loader.py'), 'x');
  const claim = 'I changed tools/loader.py to stream rows.';
  assert.match(unsupportedClaims(claim, newEvidence(), await gitChangedAcross([ws])).join(), /no changes/, 'the workspace alone misses it');
  assert.deepEqual(unsupportedClaims(claim, newEvidence(), await gitChangedAcross([ws, other])), []);
  assert.equal(await gitChangedAcross([os.tmpdir()]), undefined, 'no readable repo: unknown');
});

test("verify: a helper's test runs and edits count for the parent's report", () => {
  const main = newEvidence();
  const helper = newEvidence();
  recordTool(helper, ...bash('npm test'));
  recordTool(helper, 'Edit', { file_path: '/r/src/a.ts' }, true);
  mergeEvidence(main, helper);
  assert.deepEqual(unsupportedClaims('Done: I updated src/a.ts and the tests pass.', main, []), []);
});

test('verify: a claimed file name is read whole (2026-10-19: ".gitignore" was read as ".gitign")', () => {
  const ev = newEvidence();
  recordTool(ev, 'Edit', { file_path: '/u/twenty-local/.gitignore' }, true);
  recordTool(ev, 'Write', { file_path: '/u/app/README.markdown' }, true);
  assert.deepEqual(unsupportedClaims('I updated twenty-local/.gitignore to ignore backups. I also edited README.markdown.', ev, []), []);
  assert.match(unsupportedClaims('I updated twenty-local/.dockerignore too.', ev, []).join(), /changed twenty-local\/\.dockerignore, but/);
});

test('verify: a status reply may quote an earlier test run while nothing changed since (2026-10-19: six false send-backs)', () => {
  const ev = newEvidence();
  recordTool(ev, 'Edit', { file_path: '/r/src/a.ts' }, true);
  recordTool(ev, ...bash('npx vitest run'));
  assert.deepEqual(unsupportedClaims('Fixed src/a.ts; all tests pass.', ev, ['/r/src/a.ts']), []);
  resetEvidence(ev);
  assert.deepEqual(unsupportedClaims('Status: the plugin tests pass (1028).', ev, []), [], 'next turn, nothing edited since the run');
  recordTool(ev, 'Edit', { file_path: '/r/src/b.ts' }, true);
  resetEvidence(ev);
  assert.match(unsupportedClaims('Status: the plugin tests pass.', ev, []).join(), /no test command ran/, 'an edit after the run makes it stale');
  const main = newEvidence();
  recordTool(main, ...bash('npm test'));
  const helper = newEvidence();
  recordTool(helper, 'Edit', { file_path: '/r/src/c.ts' }, true);
  mergeEvidence(main, helper);
  resetEvidence(main);
  assert.match(unsupportedClaims('The tests pass.', main, []).join(), /no test command ran/, "a helper's later edit makes the parent's run stale");
});

test('a check command worth remembering: the build or test tool itself, the whole suite, changing nothing', () => {
  for (const ok of ['npm test', 'npm run test:unit', './gradlew :app:testDebugUnitTest', './gradlew assembleDebug', 'gradle check', 'swift test', 'CI=1 npm run build', 'make test', 'xcodebuild -scheme App test', 'python3 -m pytest']) {
    assert.ok(isCheckCommand(ok), ok);
  }
  for (const no of ['make install', 'make clean', './gradlew clean build', 'cat build.log', 'echo hi && make test', 'npx jest src/a.test.ts', 'npm test -- --grep parser', 'pytest -k parse', 'git push', 'ls']) {
    assert.ok(!isCheckCommand(no), no);
  }
  assert.ok(TEST_COMMAND.test('./gradlew testDebugUnitTest') && BUILD_COMMAND.test('./gradlew :app:assembleDebug'), 'Gradle task names count as tests and builds');
});

test('verify: sendBackReason puts failed checks first and omits the claims part when there are none', () => {
  assert.equal(sendBackReason([], 'Checks failed after your edits: tsc exit 2'), 'Checks failed after your edits: tsc exit 2');
  assert.match(sendBackReason(['no test ran'], 'Checks failed after your edits: tsc exit 2'), /^Checks failed after your edits: tsc exit 2\n\nBefore finishing/);
  assert.doesNotMatch(sendBackReason(['no test ran']), /Checks failed/);
});

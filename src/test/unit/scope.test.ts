import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_REPORT_CHARS, gitIgnores, inScope, inferScope, isReadOnlyCommand, missingScopeReason, parseScope, scopeFooter, scopeViolation, scopeViolationAsync, shellWrites } from '../../agent/scope';

const cwd = '/repo';

test('scope: a brief declares the files a helper may edit and read first', () => {
  assert.deepEqual(parseScope('Fix the parser.\nEdit only: src/parse.ts, src/lex/**\nRead first: src/ast.ts:1-80, docs/grammar.md'), { edit: ['src/parse.ts', 'src/lex/**'], read: ['src/ast.ts:1-80', 'docs/grammar.md'] });
  assert.deepEqual(parseScope('- Edit only: none\n- Read first: README.md'), { edit: [], read: ['README.md'] });
  assert.equal(parseScope('Just do it'), undefined);
  assert.match(missingScopeReason({ prompt: 'Just do it' }) ?? '', /Edit only:/);
  assert.equal(missingScopeReason({ prompt: 'x\nEdit only: none' }), undefined);
  assert.match(scopeFooter({ edit: [], read: [] }), /read-only/);
  assert.match(scopeFooter({ edit: ['src/a.ts'], read: ['b.ts'] }), /edit only: src\/a\.ts.*Read these first: b\.ts.*1,500 tokens/);
  assert.ok(MAX_REPORT_CHARS >= 4000);
});

test('scope: edits outside it are refused, inside allowed; scratch files are fine', () => {
  const scope = { edit: ['src/mail/**', 'test/mail.test.ts'], read: [] };
  assert.ok(inScope(scope, cwd, '/repo/src/mail/search.ts'));
  assert.ok(inScope(scope, cwd, 'test/mail.test.ts'));
  assert.ok(!inScope(scope, cwd, '/repo/src/links.ts'));
  assert.ok(!inScope(scope, cwd, '/elsewhere/src/mail/x.ts'), 'outside the workspace');
  assert.equal(scopeViolation(scope, cwd, 'Edit', { file_path: '/repo/src/mail/a.ts' }), undefined);
  assert.match(scopeViolation(scope, cwd, 'Write', { file_path: '/repo/src/links.ts' }) ?? '', /outside your scope: you may edit only src\/mail\/\*\*/);
  assert.match(scopeViolation({ edit: [], read: [] }, cwd, 'Edit', { file_path: '/repo/a.ts' }) ?? '', /read-only job/);
  assert.match(scopeViolation(scope, cwd, 'Bash', { command: "sed -i 's/a/b/' src/links.ts" }) ?? '', /writes src\/links\.ts/);
  assert.match(scopeViolation(scope, cwd, 'Bash', { command: 'echo hi > src/other.ts' }) ?? '', /writes src\/other\.ts/);
  for (const ok of ['npm test 2>&1 | tail -5', 'echo x > /dev/null', 'grep -rn foo src > /tmp/out.txt', 'cat src/links.ts', 'echo x > src/mail/new.ts']) {
    assert.equal(scopeViolation(scope, cwd, 'Bash', { command: ok }), undefined, ok);
  }
  assert.equal(scopeViolation(scope, cwd, 'Read', { file_path: '/repo/src/links.ts' }), undefined, 'reading is never refused');
});

test('scope: build and tool output is generated, so any helper may write it (2026-10-21: refusals stopped helpers verifying)', async () => {
  const scope = { edit: ['android/app/src/main/kotlin/A.kt'], read: [] };
  const asked: string[] = [];
  const ignored = (abs: string) => (asked.push(abs), !abs.endsWith('/src/build'));
  for (const ok of ['rm -rf android/app/build/tmp/kotlin-classes', 'echo x > android/.gradle/lock', 'rm -rf mac/.build', 'touch node_modules/.cache/x', 'rm -rf target/debug']) {
    assert.equal(scopeViolation(scope, cwd, 'Bash', { command: ok }, ignored), undefined, ok);
  }
  assert.ok(asked.includes('/repo/android/app/build'), 'git is asked about the output folder itself');
  assert.match(scopeViolation(scope, cwd, 'Bash', { command: 'rm -rf src/build/gen.ts' }, ignored) ?? '', /outside your scope/, 'a tracked folder named build/ is source');
  assert.match(scopeViolation(scope, cwd, 'Bash', { command: 'rm -rf android/app/src/main' }, ignored) ?? '', /outside your scope/, 'source stays scoped');
  assert.match(scopeViolation(scope, '/Users/me/build/repo', 'Edit', { file_path: '/Users/me/build/repo/src/a.ts' }, ignored) ?? '', /outside your scope/, 'a "build" folder above the repo is not output');
  assert.match(scopeFooter(scope), /write "not built" or "not tested"/);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-ignore-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n');
  let ticked = false;
  setImmediate(() => (ticked = true));
  assert.equal(await gitIgnores(path.join(repo, 'app/build')), true);
  assert.ok(ticked, 'git runs without blocking the extension thread');
  assert.equal(await gitIgnores(path.join(repo, 'coverage')), false, 'not in .gitignore');
  assert.equal(await gitIgnores(path.join(os.tmpdir(), 'not-a-repo-build')), false);
  fs.rmSync(path.join(repo, '.gitignore'));
  assert.equal(await gitIgnores(path.join(repo, 'app/build')), true, 'cached per folder');
});

test('scope: the async check answers as the sync one, asking about every folder a command writes', async () => {
  const scope = { edit: ['src/a.ts'], read: [] };
  const asked: string[] = [];
  const ignored = (abs: string) => !abs.endsWith('/src/build');
  const later = async (abs: string) => (asked.push(abs), ignored(abs));
  for (const [tool, input] of [
    ['Bash', { command: 'rm -rf build/tmp && echo x > node_modules/.cache/y' }],
    ['Bash', { command: 'rm -rf build/tmp && echo x > src/b.ts' }],
    ['Bash', { command: 'rm -rf src/build/gen.ts' }],
    ['Edit', { file_path: '/repo/src/a.ts' }],
    ['Write', { file_path: '/repo/target/out.txt' }],
  ] as const) {
    assert.equal(await scopeViolationAsync(scope, cwd, tool, input, later), scopeViolation(scope, cwd, tool, input, ignored), `${tool} ${JSON.stringify(input)}`);
  }
  assert.ok(asked.includes('/repo/build') && asked.includes('/repo/node_modules'), 'both output folders were asked about');
});

test('scope: a workspace under a temp folder is still held to the scope', () => {
  const tmp = '/var/folders/x/T/project';
  assert.match(scopeViolation({ edit: ['src/a.ts'], read: [] }, tmp, 'Write', { file_path: `${tmp}/src/b.ts` }) ?? '', /outside your scope/);
  assert.equal(scopeViolation({ edit: ['src/a.ts'], read: [] }, tmp, 'Write', { file_path: '/tmp/notes.txt' }), undefined, 'scratch outside the workspace is fine');
});

// Today's (2026-10-19) refusals: a repo-c chat sent helpers into other repos.
const ws = '/u/repo-c';
const rootOf = (p: string) => ['/u/repo-a', '/u/repo-b', '/u/repo-c'].find((r) => p === r || p.startsWith(r + '/'));

test('scope: globs match relative to a repo the brief names, not only the workspace', () => {
  const scope = parseScope('Work in /u/repo-a.\nEdit only: test/**, scripts/**, vitest config, CLAUDE.md.\nRead first: none', ws, rootOf)!;
  assert.deepEqual(scope.roots, ['/u/repo-a']);
  assert.deepEqual(scope.edit, ['test/**', 'scripts/**', 'vitest.config.*', 'CLAUDE.md'], '"vitest config" is the config file');
  assert.equal(scopeViolation(scope, ws, 'Edit', { file_path: '/u/repo-a/test/setup.ts' }), undefined);
  assert.equal(scopeViolation(scope, ws, 'Write', { file_path: '/u/repo-a/scripts/twenty-egress-check.sh' }), undefined);
  assert.match(scopeViolation(scope, ws, 'Edit', { file_path: '/u/repo-a/src/app.ts' }) ?? '', /outside your scope.*relative to repo-c or repo-a/);
  assert.match(scopeViolation(scope, ws, 'Edit', { file_path: '/u/repo-b/test/x.py' }) ?? '', /outside your scope/, 'a repo the brief does not name');
  assert.equal(parseScope(`In ${ws}/App:\nEdit only: App/**`, ws, rootOf)!.roots, undefined, 'the workspace itself is not an extra root');
});

test('scope: list items keep their path and lose the prose around it', () => {
  const s = parseScope('Edit only: other Tests/*.swift only to remove live tests (not ScreenAskTests.swift, not X.swift), new tests/test_network_guard.py (or the tier dir that fits), Makefile', ws, rootOf)!;
  assert.deepEqual(s.edit, ['Tests/*.swift', 'tests/test_network_guard.py', 'Makefile']);
});

test('scope: shell writes follow cd and ignore options, quotes, heredocs and fd copies', () => {
  const scope = parseScope('In /u/repo-b\nEdit only: tools/chat_eval/**, tests/conftest.py', ws, rootOf)!;
  const ok = [
    'cd /u/repo-b && mv tools/chat_eval/a.py tools/chat_eval/judge.py',
    'cd /u/repo-b/tools/chat_eval; echo x > judge.py',
    'git rm --cached tools/x.py',
    'git commit -m "cp a and b > c"',
    "cat > /tmp/probe.swift <<'EOF'\nprint(1) > out.txt\nEOF\nswift /tmp/probe.swift",
    'npm test 2>&1 | tail -5',
    'make test >/dev/null 2>&1',
    'echo "a > b"',
  ];
  for (const c of ok) {
    assert.equal(scopeViolation(scope, ws, 'Bash', { command: c }), undefined, c);
  }
  assert.match(scopeViolation(scope, ws, 'Bash', { command: 'cd /u/repo-b && echo x > judge.py' }) ?? '', /writes \/u\/repo-b\/judge\.py/);
  assert.match(scopeViolation(scope, ws, 'Bash', { command: 'rm -rf -- App/old.swift' }) ?? '', /writes App\/old\.swift/);
  assert.match(scopeViolation(scope, ws, 'Bash', { command: "cd /u/repo-b && sed -i '' -e 's/a/b/' Makefile" }) ?? '', /Makefile/);
});

test('scope: shellWrites finds each kind of write', () => {
  assert.deepEqual(shellWrites('tee -a log.txt < in; touch a b', '/r'), ['/r/log.txt', '/r/a', '/r/b']);
  assert.deepEqual(shellWrites('cp -r src dst && mv x y', '/r'), ['/r/dst', '/r/y', '/r/x']);
  assert.deepEqual(shellWrites('cp -t out a b', '/r'), ['/r/out']);
  assert.deepEqual(shellWrites("sed -i.bak 's/x/y/' f1 f2", '/r'), ['/r/f1', '/r/f2']);
  assert.deepEqual(shellWrites('cd sub && cd .. && echo hi &> all.log', '/r'), ['/r/all.log']);
  assert.deepEqual(shellWrites('ls # > not.txt', '/r'), []);
});

test('scope: helpers in a worktree are held to the same globs inside it (2026-10-19: every worktree edit was refused)', () => {
  const scope = parseScope('Edit only: App/CRM/TwentyClient.swift, Tests/CRMToolsTests.swift, vitest config', ws, rootOf)!;
  const wt = `${ws}/.claude/worktrees/agent-acf4feea22566ff18`;
  assert.equal(scopeViolation(scope, ws, 'Edit', { file_path: `${wt}/App/CRM/TwentyClient.swift` }), undefined);
  assert.equal(scopeViolation(scope, ws, 'Edit', { file_path: `${wt}/Tests/CRMToolsTests.swift` }), undefined);
  assert.match(scopeViolation(scope, ws, 'Edit', { file_path: `${wt}/App/Agent/Blocks.swift` }) ?? '', /outside your scope/);
  assert.ok(scope.edit.includes('vitest.config.*'), '"vitest config" means the vitest config file');
});

test('scope: absolute globs, shell variables and new symlinks', () => {
  const scope = parseScope('Edit only: /u/repo-a/lib/devlink.ts, /u/twenty/**', ws, rootOf)!;
  assert.equal(scopeViolation(scope, ws, 'Edit', { file_path: '/u/repo-a/lib/devlink.ts' }), undefined);
  assert.equal(scopeViolation(scope, ws, 'Write', { file_path: '/u/twenty/packages/a/b.ts' }), undefined);
  assert.equal(scopeViolation(scope, ws, 'Bash', { command: 'for f in *.swift; do sed -i "" "s/a/b/" "$f"; done' }), undefined, 'unknown until the shell runs');
  assert.equal(scopeViolation(scope, ws, 'Bash', { command: 'cd $B/$S && echo x > out.ts' }), undefined);
  assert.equal(scopeViolation(scope, ws, 'Bash', { command: `ln -s ${ws}/credentials /tmp/nowhere-${Date.now()}/credentials` }), undefined);
});

test('scope: a brief with no "Edit only:" line gets the files it names, not a refusal', () => {
  const s = inferScope('Fix the id check in App/CRM/TwentyClient.swift and add a case to Tests/CRMToolsTests.swift. See https://example.com/x.html and v1.2.3.', ws, rootOf)!;
  assert.deepEqual(s.edit, ['App/CRM/TwentyClient.swift', 'Tests/CRMToolsTests.swift']);
  assert.equal(scopeViolation(s, ws, 'Edit', { file_path: `${ws}/App/CRM/TwentyClient.swift` }), undefined);
  assert.match(scopeViolation(s, ws, 'Edit', { file_path: `${ws}/App/Other.swift` }) ?? '', /outside your scope/);
  assert.equal(inferScope('Look into why the build is slow and report back.', ws, rootOf), undefined, 'no files named: still refused');
});

test('scope: read-only shell commands run without a permission card; anything that writes or runs programs still asks', () => {
  for (const ok of ['git status', 'git diff --stat && git log --oneline -5', 'ls -la src | wc -l', "rg -n 'foo' src", 'grep -o x a.txt', 'find . -name "*.ts"', 'git branch -a', 'cd /tmp && ls', 'npm --version 2>/dev/null || true'.replace('npm --version', 'which npm')]) {
    assert.equal(isReadOnlyCommand(ok), true, ok);
  }
  for (const no of ['npm test', 'rm -rf build', 'echo x > a.txt', 'find . -delete', 'find . -exec rm {} ;', 'git commit -m x', 'git branch -D old', 'git tag v1', 'git remote add o url', 'ls $(touch x)', 'sort -o out.txt in.txt', 'FOO=1 ls', 'curl https://x', 'python3 -c "print(1)"']) {
    assert.equal(isReadOnlyCommand(no), false, no);
  }
});

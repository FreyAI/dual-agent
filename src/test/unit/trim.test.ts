import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { condenseTestOutput, headTail, pruneSpill, trimToolOutput } from '../../agent/trim';

const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-test-'));
const opts = { spillDir, now: 1700000000000 };
const passing = (n: number, mark = '✓') => Array.from({ length: n }, (_, i) => `   ${mark} src/feature${i}.test.ts > works with case number ${i} (3 ms)`).join('\n');
const bash = (stdout: string, stderr = '') => ({ stdout, stderr, interrupted: false, isImage: false });
const run = (command: string, out: unknown) => trimToolOutput('Bash', { command }, out, opts);
const shown = (r: ReturnType<typeof trimToolOutput>) => (r!.output as { stdout: string }).stdout;

test('trim: vitest failures keep the failing test, its error and the summary', () => {
  const out = `${passing(60)}
 FAIL  src/math.test.ts > math > adds
AssertionError: expected 3 to be 2 // Object.is equality
- Expected
+ Received
- 2
+ 3
 ❯ src/math.test.ts:5:20
${passing(30)}
 Test Files  1 failed | 12 passed (13)
      Tests  1 failed | 90 passed (91)
   Duration  1.20s`;
  const r = run('npx vitest run', bash(out))!;
  const text = shown(r);
  assert.match(text, /^\[Dual Agent trimmed this output to failures and the summary; full output: .*Bash-1700000000000\.txt\]/);
  assert.match(text, /FAIL {2}src\/math\.test\.ts > math > adds/);
  assert.match(text, /expected 3 to be 2/);
  assert.match(text, /Tests {2}1 failed \| 90 passed/);
  assert.doesNotMatch(text, /works with case/);
  assert.equal(r.savedChars, out.length - text.length);
  assert.equal(fs.readFileSync(text.match(/full output: (.*)\]/)![1], 'utf8'), out);
});

test('trim: jest ● blocks are kept, console blocks are not', () => {
  const out = `${passing(50, 'PASS')}
FAIL src/add.test.ts
  ● math › adds

    expect(received).toBe(expected) // Object.is equality

    Expected: 2
    Received: 3

      at Object.<anonymous> (src/add.test.ts:11:22)

  ● Console

    console.log
      noisy log line

Test Suites: 1 failed, 50 passed, 51 total
Tests:       1 failed, 120 passed, 121 total
Time:        3.2 s`;
  const text = condenseTestOutput('npm test', out)!;
  assert.match(text, /● math › adds/);
  assert.match(text, /Received: 3/);
  assert.match(text, /add\.test\.ts:11:22/);
  assert.doesNotMatch(text, /noisy log line/);
  assert.match(text, /Tests: +1 failed, 120 passed/);
});

test('trim: node --test TAP keeps not ok blocks with their YAML and the counts', () => {
  const ok = Array.from({ length: 80 }, (_, i) => `# Subtest: case ${i}\nok ${i + 2} - case ${i}\n  ---\n  duration_ms: 0.5\n  ...`).join('\n');
  const out = `TAP version 13
# Subtest: parses dates
not ok 1 - parses dates
  ---
  duration_ms: 1.2
  failureType: 'testCodeFailure'
  error: 'Expected values to be strictly equal'
  code: 'ERR_ASSERTION'
  ...
${ok}
1..81
# tests 81
# suites 0
# pass 80
# fail 1
# duration_ms 120`;
  const text = condenseTestOutput('node --test out/test', out)!;
  assert.match(text, /not ok 1 - parses dates[\s\S]*Expected values to be strictly equal[\s\S]*\.\.\./);
  assert.match(text, /# pass 80\n# fail 1/);
  assert.doesNotMatch(text, /case 3/);
});

test('trim: pytest keeps FAILED lines, E details and the summary', () => {
  const out = `${'tests/test_misc.py ' + '.'.repeat(60) + '\n'}`.repeat(40) + `
=================================== FAILURES ===================================
_________________________________ test_total __________________________________
    def test_total():
>       assert total([1, 2]) == 4
E       assert 3 == 4
tests/test_cart.py:12: AssertionError
=========================== short test summary info ============================
FAILED tests/test_cart.py::test_total - assert 3 == 4
========================= 1 failed, 2399 passed in 4.12s =========================`;
  const text = condenseTestOutput('python -m pytest -q', out)!;
  for (const re of [/_ test_total _/, /E {7}assert 3 == 4/, /test_cart\.py:12: AssertionError/, /FAILED tests\/test_cart\.py::test_total/, /1 failed, 2399 passed/]) {
    assert.match(text, re);
  }
  assert.doesNotMatch(text, /test_misc/);
});

test('trim: go test keeps --- FAIL with its lines and package verdicts', () => {
  const out = `${Array.from({ length: 60 }, (_, i) => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.00s)`).join('\n')}
--- FAIL: TestParse (0.00s)
    parse_test.go:14: got 3, want 2
FAIL
FAIL	example.com/app/parse	0.012s
ok  	example.com/app/util	0.004s`;
  const text = condenseTestOutput('go test ./...', out)!;
  assert.match(text, /--- FAIL: TestParse[\s\S]*got 3, want 2/);
  assert.match(text, /FAIL\texample\.com\/app\/parse/);
  assert.match(text, /ok {2}\texample\.com\/app\/util/);
  assert.doesNotMatch(text, /TestCase1/);
});

test('trim: tsc keeps only the error lines', () => {
  const noise = 'Files: 412\nLines of TypeScript: 51234\n'.repeat(60);
  const out = `${noise}src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(9,1): error TS2304: Cannot find name 'foo'.
Found 2 errors in 2 files.`;
  const text = condenseTestOutput('npx tsc -p .', out)!;
  assert.equal(text, `src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(9,1): error TS2304: Cannot find name 'foo'.\nFound 2 errors in 2 files.`);
});

test('trim: an all-pass run is cut to the summary lines', () => {
  const out = `${passing(80)}
 Test Files  13 passed (13)
      Tests  91 passed (91)`;
  const r = run('npm test', bash(out))!;
  assert.equal(shown(r).split('\n').slice(1).join('\n'), `Test Files  13 passed (13)\n      Tests  91 passed (91)`);
  assert.equal(condenseTestOutput('ls -la', out), undefined, 'not a test or build command');
});

test('trim: a huge grep spills to a file and keeps the head, tail and the path', () => {
  const content = Array.from({ length: 2000 }, (_, i) => `src/file${i}.ts:${i}:const match${i} = true;`).join('\n');
  const out = { mode: 'content', numFiles: 2000, filenames: [], content, numLines: 2000 };
  const r = trimToolOutput('Grep', { pattern: 'match' }, out, opts)!;
  const o = r.output as typeof out;
  assert.deepEqual({ ...o, content: '' }, { ...out, content: '' });
  assert.ok(o.content.length < 3_400);
  assert.match(o.content, /^src\/file0\.ts/);
  assert.match(o.content, /match1999 = true;\n\[Full output \(\d+ chars\) saved to (.*Grep-1700000000000(-\d+)?\.txt); Read it with offset\/limit or Grep it\]$/);
  const file = o.content.match(/saved to (.*\.txt);/)![1];
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.equal(r.savedChars, content.length - o.content.length);
});

test('trim: Glob filenames stay a string array', () => {
  const filenames = Array.from({ length: 1000 }, (_, i) => `/repo/src/deep/folder/file${i}.ts`);
  const r = trimToolOutput('Glob', { pattern: '**/*.ts' }, { filenames, numFiles: 1000, truncated: false, durationMs: 4 }, opts)!;
  const o = r.output as { filenames: string[]; numFiles: number };
  assert.ok(o.filenames.every((f) => typeof f === 'string') && o.filenames.length < 200);
  assert.equal(o.filenames[0], filenames[0]);
  assert.equal(o.numFiles, 1000);
});

test('trim: Bash objects keep their other fields; plain strings stay strings', () => {
  const out = { ...bash('x'.repeat(9_000) + '\nend', 'warn'), returnCodeInterpretation: 'ok', isImage: false };
  const r = run('cat big.log', out)!;
  const o = r.output as typeof out;
  assert.equal(o.interrupted, false);
  assert.equal(o.isImage, false);
  assert.equal(o.returnCodeInterpretation, 'ok');
  assert.equal(o.stderr, '');
  assert.match(o.stdout, /\[Full output \(9009 chars\)/);
  assert.equal(typeof run('cat big.log', 'y\n'.repeat(5_000))!.output, 'string');
  assert.equal(run('cat img.png', { stdout: 'z'.repeat(20_000), stderr: '', isImage: true }), undefined, 'image data untouched');
});

test('trim: MCP content arrays keep their shape and non-text blocks', () => {
  const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
  const blocks = [{ type: 'text', text: 'a'.repeat(6_000) }, image, { type: 'text', text: 'b'.repeat(6_000) }];
  const r = trimToolOutput('mcp__docs__fetch', {}, blocks, opts)!;
  const out = r.output as { type: string; text?: string }[];
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'text');
  assert.match(out[0].text ?? '', /mcp__docs__fetch-1700000000000(-\d+)?\.txt/);
  assert.deepEqual(out[1], image);
  const wrapped = trimToolOutput('mcp__docs__fetch', {}, { content: blocks, isError: false }, opts)!.output as { content: unknown[]; isError: boolean };
  assert.equal(wrapped.isError, false);
  assert.equal(wrapped.content.length, 2);
});

test('trim: small outputs, Read and Edit are left alone', () => {
  assert.equal(run('npm test', bash('Tests  3 passed (3)')), undefined);
  assert.equal(trimToolOutput('Grep', {}, { content: 'a:1:x', filenames: [] }, opts), undefined);
  assert.equal(trimToolOutput('Read', { file_path: 'a' }, 'r'.repeat(50_000), opts), undefined);
  assert.equal(trimToolOutput('Edit', { file_path: 'a' }, 'e'.repeat(50_000), opts), undefined);
  assert.equal(trimToolOutput('Bash', { command: 'ls' }, 42, opts), undefined);
});

test('trim: errors are swallowed', () => {
  const blocker = path.join(spillDir, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  assert.equal(trimToolOutput('Bash', { command: 'cat x' }, 'q'.repeat(20_000), { spillDir: path.join(blocker, 'sub') }), undefined);
  const hostile = { get stdout(): string { throw new Error('boom'); } };
  assert.equal(trimToolOutput('Bash', { command: 'cat x' }, hostile, opts), undefined);
});

test('trim: headTail keeps both ends on line boundaries', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const cut = headTail(text, 300);
  assert.ok(cut.length <= 300);
  assert.match(cut, /^line 0\n[\s\S]*… \[\d+ chars omitted\] …\n[\s\S]*line 499$/);
  assert.equal(headTail('short', 300), 'short');
});

test('pruneSpill deletes saved outputs older than the limit and keeps new ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-spill-'));
  fs.writeFileSync(path.join(dir, 'old.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'y');
  const old = (Date.now() - 8 * 86_400_000) / 1000;
  fs.utimesSync(path.join(dir, 'old.txt'), old, old);
  pruneSpill(dir, 7 * 86_400_000);
  assert.deepEqual(fs.readdirSync(dir), ['new.txt']);
  pruneSpill(path.join(dir, 'missing'), 1);
});

import { EventEmitter, setWorkspaceFolders, vscode } from '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractSymbols, flushIndex, indexRepo, indexWindows, refreshIndex, relPath, resetIndexCacheForTests, resolveTarget, workspacePath } from '../../code/repoIndex';
import { capGroups, duplicatesReport, findDuplicates, mapReport, rankSymbols, renderMap } from '../../code/analysis';
import { checkEdit } from '../../code/editCheck';
import { newErrors, retryEmpty } from '../../code/lsp';
import { FOLDER_FILES_CAP, createCodeServer, noteFiles, noteRefusal } from '../../code/tools';
import { findNotes } from '../../memory/memory';
import { recentDiag, resetDiag } from '../../diag/log';

const names = (text: string, ext: string) => extractSymbols(text, ext).map((s) => `${s.kind} ${s.name}`);

test('definitions are found in each language family', () => {
  assert.deepEqual(
    names(
      [
        'export async function loadUser(id: string) {',
        'export class UserStore {',
        '  async fetchAll(limit = 10): Promise<User[]> {',
        '  private cacheKey(id: string) {',
        '    if (ready) {',
        '}',
        'export interface User {',
        'export type UserId = string;',
        'export const enum Role {',
        'const formatName = (u: User) => u.name;',
        'export const MAX_USERS = 50;',
      ].join('\n'),
      '.ts',
    ),
    ['function loadUser', 'class UserStore', 'method fetchAll', 'interface User', 'type UserId', 'enum Role', 'function formatName', 'const MAX_USERS'],
  );
  assert.deepEqual(names('def parse_date(s):\nclass Parser:\n    def run(self):\n    def _hidden(self):\nTIMEOUT = 5\n', '.py'), [
    'function parse_date',
    'class Parser',
    'method run',
    'const TIMEOUT',
  ]);
  assert.deepEqual(names('func (s *Server) Start() error {\ntype Config struct {\n', '.go'), ['function Start', 'type Config']);
  assert.deepEqual(names('pub fn render(x: u8) -> String {\npub(crate) struct Frame {\nconst LIMIT: u32 = 3;\n', '.rs'), ['function render', 'struct Frame', 'const LIMIT']);
  assert.deepEqual(names('public class Invoice {\n    public static int total(int a) {\n', '.java'), ['class Invoice', 'method total']);
  assert.deepEqual(names('deploy() {\n', '.sh'), ['function deploy']);
  assert.deepEqual(names('unknown', '.txt'), []);
});

test('code_map ranks shared, distinctive definitions first and filters by query and folder', () => {
  const files = [
    { rel: 'src/money.ts', symbols: extractSymbols('export function formatPrice(n: number) {\nexport function run() {', '.ts'), idents: new Set(['formatPrice', 'run']), windows: [] },
    { rel: 'src/cart.ts', symbols: [], idents: new Set(['formatPrice', 'run']), windows: [] },
    { rel: 'src/checkout.ts', symbols: [], idents: new Set(['formatPrice', 'run']), windows: [] },
    { rel: 'lib/other.ts', symbols: extractSymbols('export function parseDate(s: string) {', '.ts'), idents: new Set(['parseDate']), windows: [] },
  ];
  const overview = rankSymbols(files);
  assert.equal(overview[0].name, 'formatPrice', 'a distinctive name used in two other files leads');
  assert.equal(overview[0].users, 2);
  assert.deepEqual(rankSymbols(files, 'price').map((s) => s.name), ['formatPrice']);
  assert.deepEqual(rankSymbols(files, 'parse date').map((s) => s.name), ['parseDate']);
  assert.deepEqual(rankSymbols(files, undefined, 'lib').map((s) => s.name), ['parseDate']);
  const { text, shown } = renderMap(overview, 70);
  assert.equal(shown, 1, 'the budget is respected');
  assert.match(text, /^src\/money\.ts\n {2}L1 export function formatPrice\(n: number\) {2}\[2\]$/);
});

type Indexed = Parameters<typeof rankSymbols>[0][number];
const file = (rel: string, defs: string, idents: string[]): Indexed => ({ rel, symbols: extractSymbols(defs, '.ts'), idents: new Set(idents), windows: [] });

test('code_map weights: active files first, prompt identifiers boosted, private and common names demoted', () => {
  const users = (n: number, ids: string[]) => Array.from({ length: n }, (_, i) => file(`src/user${i}.ts`, '', ids));
  const files = [
    file('src/shared.ts', 'export function widelyUsedHelper() {', ['widelyUsedHelper']),
    file('src/mine.ts', 'export function myNewThing() {', ['myNewThing']),
    { ...file('src/private.ts', '', ['_internalCache']), symbols: [{ name: '_internalCache', kind: 'const', line: 1, signature: '_internalCache = {}' }] },
    ...users(3, ['widelyUsedHelper', '_internalCache']),
    file('src/caller.ts', '', ['myNewThing']),
  ];
  const score = (name: string) => rankSymbols(files).find((s) => s.name === name)?.score ?? 0;
  assert.equal(rankSymbols(files)[0].name, 'widelyUsedHelper');
  assert.ok(Math.abs(score('_internalCache') - score('widelyUsedHelper') / 10) < 1e-9, 'a private name with the same users counts a tenth');
  assert.equal(rankSymbols(files, undefined, undefined, { files: ['src/mine.ts'] })[0].name, 'myNewThing', 'an active file leads');
  assert.equal(rankSymbols(files, undefined, undefined, { words: ['fix', 'myNewThing()'] })[0].name, 'myNewThing', 'named in the prompt');

  const common = [...Array.from({ length: 6 }, (_, i) => file(`src/def${i}.ts`, 'export function renderItem() {', ['renderItem'])), file('src/one.ts', 'export function renderPanel() {', ['renderPanel']), file('src/use.ts', '', ['renderItem', 'renderPanel'])];
  assert.equal(rankSymbols(common)[0].name, 'renderPanel', 'a name defined in more than 5 files is demoted');
});

test('code_map output stops at the budget and says how many more', () => {
  const many = [file('src/big.ts', Array.from({ length: 300 }, (_, i) => `export function helperNumber${i}() {`).join('\n'), [])];
  const text = mapReport(rankSymbols(many), 'helper');
  assert.ok(text.length < 4200, String(text.length));
  assert.match(text, /\n\(\d+ more; narrow with query or path\.\)$/);
  assert.ok(mapReport(rankSymbols(many)).length > 4 * 3000, 'an overview gets four times the budget');
  assert.doesNotMatch(mapReport(rankSymbols(many), undefined, 1e6), /more;/);
});

test('references and duplicates are capped with a narrow-it message', () => {
  const groups: [string, number[]][] = [['a', [1, 2, 3]], ['b', [4, 5]], ['c', [6]]];
  assert.deepEqual(capGroups(groups, 4), { shown: [['a', [1, 2, 3]], ['b', [4]]], more: 2, moreGroups: 2 });
  assert.deepEqual(capGroups(groups, 10).more, 0);
  const dup = { file: 'a.ts', start: 1, end: 8, other: 'b.ts', otherStart: 1, otherEnd: 8 };
  const report = duplicatesReport(Array.from({ length: 23 }, () => dup));
  assert.equal(report.split('\n').length, 21);
  assert.match(report, /… 3 more duplicated blocks; narrow with a path/);
  assert.doesNotMatch(duplicatesReport([dup]), /more/);
});

const BLOCK = Array.from({ length: 10 }, (_, i) => `  total += items[${i}].price * items[${i}].qty;`).join('\n');

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-code-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('find_duplicates reports copied blocks once, with both locations', async () => {
  const root = repo({
    'src/a.ts': `export function a() {\n${BLOCK}\n}\n`,
    'src/b.ts': `// header\n\nexport function b() {\n${BLOCK}\n}\n`,
    'src/c.ts': 'export const c = 1;\n',
  });
  const files = await indexRepo(root);
  const all = findDuplicates(files);
  assert.equal(all.length, 1, JSON.stringify(all));
  assert.deepEqual(all[0], { file: 'src/a.ts', start: 2, end: 11, other: 'src/b.ts', otherStart: 4, otherEnd: 13 });
  const inB = findDuplicates(files, 'src/b.ts');
  assert.equal(inB.length, 1);
  assert.equal(inB[0].other, 'src/a.ts');
  assert.deepEqual(findDuplicates(files, 'src/c.ts'), []);
  assert.deepEqual(findDuplicates(files, undefined, 20), [], 'blocks shorter than min_lines are left out');
});

test('the index follows git (ignored files left out) and picks up changed files', async () => {
  const root = repo({ '.gitignore': 'gen/\n', 'src/keep.ts': 'export function keepMe() {}\n', 'gen/skip.ts': 'export function skipMe() {}\n' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const symbols = async () => (await indexRepo(root)).flatMap((f) => f.symbols.map((s) => s.name));
  assert.deepEqual(await symbols(), ['keepMe']);
  fs.writeFileSync(path.join(root, 'src', 'keep.ts'), 'export function keepMe() {}\nexport function addedLater() {}\n');
  assert.deepEqual(await symbols(), ['keepMe', 'addedLater']);
});

test('edit check: flags comments that narrate the edit, not ordinary ones', async () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
  const check = (text: string) => checkEdit(root, 'Edit', { file_path: path.join(root, 'src/a.ts'), new_string: text }, new Set());
  for (const bad of ['// Added a null check', '// Fixed the off-by-one', '# Updated: use the new client', '// Now uses the cache', '/* changed to async as requested */']) {
    assert.match((await check(`${bad}\nexport const a = 1;`)) ?? '', /Comments describe the edit/, bad);
  }
  for (const ok of ['// Removed items stay in the undo stack', '// Fixed-size buffer: the protocol caps frames at 4 KB', '// Retry once: the API drops the first request after idle']) {
    assert.equal(await check(`${ok}\nexport const a = 1;`), undefined, ok);
  }
});

test('edit check: reports a block the agent just copied, once, and ignores old duplicates elsewhere in the file', async () => {
  const root = repo({
    'src/a.ts': `export function a() {\n${BLOCK}\n}\n`,
    'src/b.ts': 'export const before = 1;\n',
  });
  const reported = new Set<string>();
  const copied = `export function b() {\n${BLOCK}\n}\n`;
  fs.writeFileSync(path.join(root, 'src/b.ts'), `export const before = 1;\n${copied}`);
  const note = await checkEdit(root, 'Edit', { file_path: path.join(root, 'src/b.ts'), new_string: copied }, reported);
  assert.match(note ?? '', /src\/b\.ts duplicates existing code: L3-12 = src\/a\.ts L2-11/);
  assert.equal(await checkEdit(root, 'Edit', { file_path: path.join(root, 'src/b.ts'), new_string: copied }, reported), undefined, 'not raised twice');

  fs.writeFileSync(path.join(root, 'src/b.ts'), `export const before = 2;\n${copied}`);
  assert.equal(
    await checkEdit(root, 'Edit', { file_path: path.join(root, 'src/b.ts'), new_string: 'export const before = 2;' }, new Set()),
    undefined,
    'an edit elsewhere in the file does not raise the existing copy',
  );
});

test('edit check: a MultiEdit is checked edit by edit, so an old copy elsewhere in the file is not raised', async () => {
  const root = repo({ 'src/a.ts': `export function a() {\n${BLOCK}\n}\n` });
  // b.ts already holds a copy of a's block; the MultiEdit only changes two small lines.
  fs.writeFileSync(path.join(root, 'src/b.ts'), `export const x = 1;\nexport function old() {\n${BLOCK}\n}\nexport const y = 2;\n`);
  const edits = [{ new_string: 'export const x = 1;' }, { new_string: 'export const y = 2;' }];
  assert.equal(await checkEdit(root, 'MultiEdit', { file_path: path.join(root, 'src/b.ts'), edits }, new Set()), undefined);
  const copied = { new_string: `export function old() {\n${BLOCK}\n}` };
  assert.match((await checkEdit(root, 'MultiEdit', { file_path: path.join(root, 'src/b.ts'), edits: [edits[0], copied] }, new Set())) ?? '', /duplicates existing code/);
});

test('code tools refuse paths outside the workspace: .., absolute, and a symlink out', () => {
  const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
  const outside = repo({ 'secret.ts': 'export const key = 1;\n' });
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.equal(workspacePath(root, 'src/a.ts'), path.join(root, 'src/a.ts'));
  for (const p of ['../x.ts', path.join(outside, 'secret.ts'), 'link/secret.ts']) {
    assert.throws(() => workspacePath(root, p), /outside the workspace/, p);
  }
});

test('indexing works without git, skips dependency folders and unreadable files, and refuses the home folder', async () => {
  const root = repo({ 'src/ok.ts': 'export function fine() {}\n', 'node_modules/dep/index.ts': 'export function dep() {}\n', 'src/locked.ts': 'export function locked() {}\n' });
  fs.chmodSync(path.join(root, 'src/locked.ts'), 0o000);
  try {
    const names = (await indexRepo(root)).flatMap((f) => f.symbols.map((s) => s.name));
    assert.ok(names.includes('fine'));
    assert.ok(!names.includes('dep'), 'node_modules skipped');
    if (process.getuid?.() !== 0) {
      assert.ok(!names.includes('locked'), 'unreadable file skipped, not fatal');
    }
  } finally {
    fs.chmodSync(path.join(root, 'src/locked.ts'), 0o644);
  }
  await assert.rejects(indexRepo(os.homedir()), /home folder/);
});

test('the index forgets files that were deleted', async () => {
  const root = repo({ 'src/a.ts': 'export function keep() {}\n', 'src/b.ts': 'export function gone() {}\n' });
  await indexRepo(root);
  fs.rmSync(path.join(root, 'src/b.ts'));
  assert.deepEqual((await indexRepo(root)).map((f) => f.rel), ['src/a.ts']);
});

test('a workspace index lists again only after a file is created or deleted; another repo still after 30 s', async () => {
  const ws = repo({ 'src/a.ts': 'export function a() {}\n' });
  const other = repo({ 'src/a.ts': 'export function a() {}\n' });
  const created = new EventEmitter<{ fsPath: string }>();
  let disposed = 0;
  const stub = vscode as any;
  stub.workspace.createFileSystemWatcher = () => ({ onDidCreate: created.event, onDidDelete: new EventEmitter().event, dispose: () => disposed++ });
  setWorkspaceFolders([ws]);
  const realNow = Date.now;
  const rels = async (root: string) => (await refreshIndex(root, [path.join(root, 'src/a.ts')])).map((f) => f.rel).sort();
  try {
    resetIndexCacheForTests();
    await indexRepo(ws);
    await indexRepo(other);
    fs.writeFileSync(path.join(ws, 'src/b.ts'), 'export function b() {}\n');
    fs.writeFileSync(path.join(other, 'src/b.ts'), 'export function b() {}\n');
    Date.now = () => realNow() + 31_000;
    assert.deepEqual(await rels(ws), ['src/a.ts'], 'no file event: not listed again after 31 s');
    assert.deepEqual(await rels(other), ['src/a.ts', 'src/b.ts'], 'outside the workspace: the 30 s rule');
    created.fire({ fsPath: path.join(ws, '.dual-agent', 'index-v1.json') });
    assert.deepEqual(await rels(ws), ['src/a.ts'], 'hidden folders are ignored');
    created.fire({ fsPath: path.join(ws, 'src/b.ts') });
    assert.deepEqual(await rels(ws), ['src/a.ts', 'src/b.ts'], 'a created file: listed again');
  } finally {
    Date.now = realNow;
    setWorkspaceFolders([]);
    delete stub.workspace.createFileSystemWatcher;
    await flushIndex();
    resetIndexCacheForTests();
  }
  assert.equal(disposed, 1, 'the watcher is disposed');
});

test('edit check and code tools accept the resolved path of a workspace reached through a symlink', async () => {
  const real = repo({ 'src/a.ts': `export function a() {\n${BLOCK}\n}\n` });
  const linked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-link-')), 'project');
  fs.symlinkSync(real, linked);
  const copied = `export function b() {\n${BLOCK}\n}\n`;
  fs.writeFileSync(path.join(real, 'src/b.ts'), copied);
  // The workspace is opened as the symlink; Claude Code reports the file by its resolved path.
  assert.equal(relPath(linked, path.join(real, 'src/b.ts')), 'src/b.ts');
  const note = await checkEdit(linked, 'Write', { file_path: path.join(fs.realpathSync(real), 'src/b.ts'), content: copied }, new Set());
  assert.match(note ?? '', /src\/b\.ts duplicates existing code/);
});

/** Source files read while running `fn`, to tell a warm start from re-indexing. */
async function sourceReads(fn: () => Promise<unknown>): Promise<string[]> {
  const read = fs.promises.readFile;
  const seen: string[] = [];
  fs.promises.readFile = ((file: fs.PathLike, ...rest: unknown[]) => {
    if (String(file).endsWith('.ts')) {
      seen.push(path.basename(String(file)));
    }
    return (read as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof read;
  try {
    await fn();
  } finally {
    fs.promises.readFile = read;
  }
  return seen.sort();
}

test('the index is saved to .dual-agent and a new session reads only changed files', async () => {
  const root = repo({ 'src/a.ts': `export function a() {\n${BLOCK}\n}\n`, 'src/b.ts': 'export function b() {}\n' });
  const first = await indexRepo(root);
  await flushIndex();
  const saved = path.join(root, '.dual-agent', 'index', 'index-v1.json');
  assert.ok(fs.existsSync(saved));
  assert.equal(fs.readFileSync(path.join(root, '.dual-agent', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');

  resetIndexCacheForTests();
  let warm: Awaited<ReturnType<typeof indexRepo>> = [];
  assert.deepEqual(await sourceReads(async () => (warm = await indexRepo(root))), [], 'unchanged files come from disk');
  assert.deepEqual(warm, first, 'symbols, identifiers and windows survive the round trip');

  fs.writeFileSync(path.join(root, 'src/b.ts'), 'export function b() {}\nexport function bLater() {}\n');
  resetIndexCacheForTests();
  let after: Awaited<ReturnType<typeof indexRepo>> = [];
  assert.deepEqual(await sourceReads(async () => (after = await indexRepo(root))), ['b.ts']);
  assert.deepEqual(after.flatMap((f) => f.symbols.map((s) => s.name)), ['a', 'b', 'bLater']);
});

test('a corrupt or wrong-shaped saved index is ignored and replaced', async () => {
  const root = repo({ 'src/a.ts': 'export function a() {}\n' });
  const saved = path.join(root, '.dual-agent', 'index', 'index-v1.json');
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  for (const bad of ['{not json', JSON.stringify({ version: 1, files: { 'src/a.ts': { stamp: 'x', symbols: 'nope', idents: [], windows: [] } } }), JSON.stringify({ version: 2, files: {} })]) {
    fs.writeFileSync(saved, bad);
    resetIndexCacheForTests();
    assert.deepEqual(await sourceReads(async () => assert.deepEqual((await indexRepo(root)).flatMap((f) => f.symbols.map((s) => s.name)), ['a'])), ['a.ts']);
  }
  await flushIndex();
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).version, 1);
  // The rewritten index is valid, so the next session reads nothing.
  resetIndexCacheForTests();
  assert.deepEqual(await sourceReads(() => indexRepo(root)), []);
});

test('language-server questions: empty answers retry within a deadline; no provider is not retried', async () => {
  const limits = { requestMs: 1000, deadlineMs: 120, backoffMs: 40 };
  let calls = 0;
  const started = Date.now();
  assert.equal(await retryEmpty(async () => { calls++; return []; }, 6, limits), undefined);
  assert.ok(Date.now() - started < 400, `bounded by the deadline (${Date.now() - started} ms)`);
  assert.ok(calls < 6, `stopped early (${calls} calls)`);
  calls = 0;
  assert.equal(await retryEmpty(async () => { calls++; return undefined; }, 6, limits), undefined);
  assert.equal(calls, 1, 'no provider: asked once');
  calls = 0;
  assert.deepEqual(await retryEmpty(async () => (++calls < 2 ? [] : ['x']), 6, limits), ['x']);
  await assert.rejects(retryEmpty(() => new Promise<string[]>(() => undefined), 6, limits), /did not answer/);
});

test('edit check: a language that never reported is looked at once, not waited on; one that reports is waited for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-lsp-'));
  const file = (name: string) => (fs.writeFileSync(path.join(dir, name), 'let a = 1;\n'), path.join(dir, name));
  const [txt, ts, py] = [file('notes.txt'), file('a.ts'), file('b.py')];
  const diags = new Map<string, unknown[]>();
  const changed = new EventEmitter<{ uris: { fsPath: string }[] }>();
  const report = (f: string, message?: string) => {
    diags.set(f, message ? [{ severity: 0, message, range: { start: { line: 0 } } }] : []);
    changed.fire({ uris: [{ fsPath: f }] });
  };
  const stub = vscode as any;
  Object.assign(stub.languages, { getDiagnostics: (uri?: { fsPath: string }) => (uri ? diags.get(uri.fsPath) ?? [] : []), onDidChangeDiagnostics: changed.event });
  stub.workspace.textDocuments = [[txt, 'plaintext'], [ts, 'typescript'], [py, 'python']].map(([f, languageId]) => ({ uri: { fsPath: f }, languageId }));
  try {
    diags.set(txt, [{ severity: 0, message: 'typo', range: { start: { line: 0 } } }]);
    const started = Date.now();
    assert.match((await newErrors(dir, txt, new Set())) ?? '', /typo/);
    assert.ok(Date.now() - started < 1000, `plain text: one look after the settle time (${Date.now() - started} ms)`);

    report(ts);
    let done = false;
    const check = newErrors(dir, ts, new Set()).then((r) => ((done = true), r));
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal(done, false, 'TypeScript has reported this session: its verdict is waited for');
    report(ts, 'bad type');
    assert.match((await check) ?? '', /1 new error[\s\S]*bad type/);

    // Python hasn't reported yet, but starts to during the wait: the wait is extended.
    const pyCheck = newErrors(dir, py, new Set());
    setTimeout(() => report(py), 300);
    setTimeout(() => report(py, 'syntax'), 600);
    assert.match((await pyCheck) ?? '', /syntax/);
  } finally {
    for (const key of Object.keys(stub.languages)) {
      delete stub.languages[key];
    }
    delete stub.workspace.textDocuments;
  }
});

/** The code tools' handlers for a workspace, by name; each returns the result text, or throws with the error text. */
async function codeTools(root: string): Promise<Record<string, (args: object) => Promise<string>>> {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  let tools: any[] = [];
  createCodeServer({ ...sdk, createSdkMcpServer: (opts: any) => { tools = opts.tools; return {}; } }, () => root);
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      async (args: object) => {
        const res = await t.handler(args, {});
        if (res.isError) {
          throw new Error(res.content[0].text);
        }
        return res.content[0].text as string;
      },
    ]),
  );
}

test('notes_add cuts a long body and says so, and takes files as a list, a JSON string or a comma list', async () => {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  assert.deepEqual(noteFiles('["src/a.ts", "src/b.ts"]'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(noteFiles('src/a.ts, src/b.ts'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(noteFiles(['src/a.ts']), ['src/a.ts']);
  assert.deepEqual(noteFiles(undefined), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-notes-'));
  let tools: any[] = [];
  createCodeServer({ ...sdk, createSdkMcpServer: (opts: any) => { tools = opts.tools; return {}; } }, () => root);
  const add = tools.find((t) => t.name === 'notes_add');
  assert.match(add.description, /body up to 1500 chars/);
  const res = await add.handler({ title: 'Long note', body: 'x'.repeat(2000), files: 'src/a.ts, src/b.ts' }, {});
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /body cut to 1500 of 2000 characters/);
  const saved = findNotes(root, 'Long note');
  assert.match(saved, /src\/a\.ts/);
  assert.ok(!saved.includes('x'.repeat(1501)));
});

test('notes_add: a helper\'s note is pending until its report checks out, and keys are refused', async () => {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-notes-'));
  let tools: any[] = [];
  const helperCalls = new Set(['toolu_helper']);
  createCodeServer({ ...sdk, createSdkMcpServer: (opts: any) => { tools = opts.tools; return {}; } }, () => root, undefined, (id) => (id && helperCalls.has(id) ? { by: 'helper', helper: 'agent-7' } : { by: 'main' }));
  const add = tools.find((t) => t.name === 'notes_add');
  const meta = (id: string) => ({ _meta: { 'claudecode/toolUseId': id } });
  const byHelper = await add.handler({ title: 'Gradle lock', body: 'One Gradle run at a time.', kind: 'gotcha' }, meta('toolu_helper'));
  assert.match(byHelper.content[0].text, /It stays a proposal until a build or test you run passes, or the main agent saves it\./);
  assert.match(fs.readFileSync(path.join(root, '.dual-agent/memory/notes.md'), 'utf8'), /Kind: gotcha\nBy: helper\nPending: agent-7\n/);
  const taken = await add.handler({ title: 'gradle lock', body: 'Something else.' }, meta('toolu_helper'));
  assert.equal(taken.isError, false);
  const main = await add.handler({ title: 'Gradle lock', body: 'One Gradle run at a time; the main agent checked.' }, meta('toolu_main'));
  assert.doesNotMatch(main.content[0].text, /proposal/);
  assert.doesNotMatch(findNotes(root, 'gradle'), /a proposal/, 'the main agent\'s write confirms it');
  const key = await add.handler({ title: 'API', body: 'The key is sk-ant-abcdefghijklmnopqrstuvwxyz0123' }, meta('toolu_main'));
  assert.equal(key.isError, true);
  assert.match(key.content[0].text, /must not hold keys/);
  assert.equal(noteRefusal('The `token: string` field holds the session id.'), undefined, 'prose about code is fine');
  assert.match(noteRefusal('Keys live in credentials/deepseek.env') ?? '', /credential paths/);
});

test('a failing code tool writes one tool_error row', async () => {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-tools-'));
  let tools: any[] = [];
  createCodeServer({ ...sdk, createSdkMcpServer: (opts: any) => { tools = opts.tools; return {}; } }, () => root);
  resetDiag();
  const res = await tools.find((t) => t.name === 'find_duplicates').handler({ path: 'nope.ts' }, {});
  assert.equal(res.isError, true);
  assert.deepEqual(recentDiag(60_000).map((r) => [r.kind, r.code]), [['tool_error', 'find_duplicates']]);
  assert.match(recentDiag(60_000)[0].detail!, /^nope\.ts not found \(tried .*nope\.ts\)\. For another repo, give an absolute path\.$/);
  resetDiag();
});

const gitRepo = (files: Record<string, string>) => {
  const root = repo(files);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
};

test('paths: relative to the workspace, absolute or ~ anywhere, placed in their own git repo', () => {
  const ws = repo({ 'src/a.ts': 'export const a = 1;\n' });
  const other = gitRepo({ 'lib/sites/registry.ts': 'export const sites = [];\n' });
  assert.deepEqual(resolveTarget(ws, 'src/a.ts'), { root: ws, abs: path.join(ws, 'src/a.ts'), rel: 'src/a.ts', isDir: false, inRepo: true });
  assert.deepEqual(resolveTarget(ws, '.'), { root: ws, abs: ws, rel: '', isDir: true, inRepo: true });
  assert.deepEqual(resolveTarget(ws, path.join(other, 'lib/sites')), { root: other, abs: path.join(other, 'lib/sites'), rel: 'lib/sites', isDir: true, inRepo: true });
  assert.equal(resolveTarget(ws, '~').abs, os.homedir());
  assert.throws(() => resolveTarget(ws, 'lib/sites/registry.ts'), new RegExp(`not found \\(tried ${path.join(ws, 'lib/sites/registry.ts')}\\)\\. For another repo, give an absolute path\\.`));
  assert.throws(() => resolveTarget(ws, path.join(other, 'nope.ts')), /nope\.ts not found\.$/);
  const loose = repo({ 'x.ts': '' });
  assert.deepEqual(resolveTarget(ws, path.join(loose, 'x.ts')), { root: loose, abs: path.join(loose, 'x.ts'), rel: 'x.ts', isDir: false, inRepo: false });
});

test('code tools on another repo: outline, map, definition, references, duplicates by folder, notes', async () => {
  resetIndexCacheForTests();
  const ws = repo({ 'src/a.ts': 'export const a = 1;\n' });
  const other = gitRepo({
    'lib/sites/registry.ts': 'export function registerSite(name: string) {\n  return name;\n}\n',
    'lib/use.ts': "import { registerSite } from './sites/registry';\nregisterSite('x');\n",
    'components/a.tsx': `export function A() {\n${BLOCK}\n}\n`,
    'components/b.tsx': `export function B() {\n${BLOCK}\n}\n`,
  });
  const tools = await codeTools(ws);
  const at = (rel: string) => path.join(other, rel);
  const label = `(in ${other})\n`;

  // No language server in the test host: the pattern index answers instead of failing.
  const outline = await tools.code_outline({ path: at('lib/sites/registry.ts') });
  assert.equal(outline, `${label}lib/sites/registry.ts (4 lines; no language server, approximate)\n  L1 function registerSite`);
  assert.match(await tools.code_map({ path: at('lib'), query: 'register site' }), /^\(in .*\)\nlib\/sites\/registry\.ts\n {2}L1 export function registerSite\(name: string\)/);
  assert.match(await tools.code_definition({ symbol: 'registerSite', path: at('lib/use.ts') }), /lib\/sites\/registry\.ts:1 {2}export function registerSite[^\n]*\n\(pattern index; no language server answered\)$/);
  const refs = await tools.code_references({ symbol: 'registerSite', path: at('lib/use.ts'), context: 1 });
  assert.match(refs, /3 text matches for registerSite in 2 files/);
  assert.match(refs, /lib\/use\.ts\n {2}L1: import \{ registerSite \}[^\n]*\n {4}2\| registerSite\('x'\);/);

  const dups = await tools.find_duplicates({ path: at('components') });
  assert.equal(dups, `${label}components/a.tsx L2-11 = components/b.tsx L2-11 (10 lines)`, 'a pair inside the folder is reported once');
  assert.equal(await tools.find_duplicates({ path: at('lib') }), `${label}No duplicated blocks in 2 files under lib.`);
  await assert.rejects(tools.find_duplicates({ path: 'components' }), /components not found \(tried .*components\)/);
  await assert.rejects(tools.code_outline({ path: at('lib') }), /lib is a folder; give a file\./);

  // The other repo's index is cached: a second call re-reads nothing.
  assert.deepEqual(await sourceReads(() => tools.code_map({ path: at('lib') })), []);

  assert.equal(await tools.notes_add({ title: 'Site registry', body: 'Sites register in lib/sites.', files: [at('lib/sites/registry.ts')], path: other }), `Saved "Site registry" in ${other}.`);
  assert.match(await tools.notes_read({ query: 'registry', path: at('lib') }), /lib\/sites\/registry\.ts/);
  assert.doesNotMatch(await tools.notes_read({ query: 'registry' }), /Site registry/);
});

test('find_duplicates on a folder caps the files checked and says so', async () => {
  const many = Object.fromEntries(Array.from({ length: FOLDER_FILES_CAP + 5 }, (_, i) => [`gen/f${String(i).padStart(3, '0')}.ts`, `export const v${i} = ${i};\n`]));
  const ws = repo({ ...many, 'gen/f204.ts': `export function z() {\n${BLOCK}\n}\n`, 'src/copy.ts': `export function y() {\n${BLOCK}\n}\n` });
  const tools = await codeTools(ws);
  assert.equal(await tools.find_duplicates({ path: 'gen' }), `No duplicated blocks in ${FOLDER_FILES_CAP} files under gen.\n(Checked the first ${FOLDER_FILES_CAP} of ${FOLDER_FILES_CAP + 5} files under gen; pass a subfolder for the rest.)`);
  assert.match(await tools.find_duplicates({ path: 'src' }), /^src\/copy\.ts L2-11 = gen\/f204\.ts L2-11/);
});

/** fs.promises.stat calls on source files while running `fn`. */
async function sourceStats(fn: () => Promise<unknown>): Promise<number> {
  const stat = fs.promises.stat;
  let n = 0;
  fs.promises.stat = ((file: fs.PathLike, ...rest: unknown[]) => {
    n += String(file).endsWith('.ts') ? 1 : 0;
    return (stat as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof stat;
  try {
    await fn();
  } finally {
    fs.promises.stat = stat;
  }
  return n;
}

test('edit check is incremental on a warm index: only the edited file is re-read, and the window map stays in step', async () => {
  resetIndexCacheForTests();
  const root = gitRepo({ 'src/a.ts': `export function a() {\n${BLOCK}\n}\n`, 'src/b.ts': 'export const b = 1;\n', 'src/c.ts': 'export const c = 1;\n' });
  await indexRepo(root);
  const copied = `export function b() {\n${BLOCK}\n}\n`;
  fs.writeFileSync(path.join(root, 'src/b.ts'), `export const b = 1;\n${copied}`);
  let note: string | undefined;
  assert.equal(await sourceStats(async () => (note = await checkEdit(root, 'Edit', { file_path: path.join(root, 'src/b.ts'), new_string: copied }, new Set()))), 1);
  assert.match(note ?? '', /src\/b\.ts duplicates existing code: L3-12 = src\/a\.ts L2-11/);

  // The kept map answers as one built from scratch, after edits that add and remove windows.
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
  await checkEdit(root, 'Write', { file_path: path.join(root, 'src/a.ts'), content: 'export const a = 2;\n' }, new Set());
  const files = await indexRepo(root);
  assert.deepEqual(findDuplicates(files, undefined, 8, await indexWindows(root)), findDuplicates(files));
  assert.deepEqual(findDuplicates(files), []);

  // A new file isn't in the index yet: a full pass picks it up.
  fs.writeFileSync(path.join(root, 'src/d.ts'), copied.replace('b()', 'd()'));
  assert.match((await checkEdit(root, 'Write', { file_path: path.join(root, 'src/d.ts'), content: copied.replace('b()', 'd()') }, new Set())) ?? '', /src\/d\.ts duplicates existing code: L2-11 = src\/b\.ts L3-12/);
});

test('edit check on a file in another repo compares it with that repo', async () => {
  const ws = repo({ 'src/a.ts': 'export const a = 1;\n' });
  const other = gitRepo({ 'lib/x.ts': `export function x() {\n${BLOCK}\n}\n` });
  const copied = `export function y() {\n${BLOCK}\n}\n`;
  fs.writeFileSync(path.join(other, 'lib/y.ts'), copied);
  assert.match((await checkEdit(ws, 'Write', { file_path: path.join(other, 'lib/y.ts'), content: copied }, new Set())) ?? '', /lib\/y\.ts duplicates existing code: L2-11 = lib\/x\.ts L2-11/);
});

import { events, fakeEditor, focusEditor } from '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attachmentBlocks, editorContext, editorInfo, likelyRelevant, markSeen, trackEditor } from '../../context';
import type { IndexedFile } from '../../code/repoIndex';
import * as repoIndex from '../../code/repoIndex';
import { flushIndex, resetIndexCacheForTests } from '../../code/repoIndex';

const realIndexRepo = repoIndex.indexRepo;
let indexRepo: typeof repoIndex.indexRepo = realIndexRepo;

const SOURCE = ['function add(a, b) {', '  return a + b;', '}', '', 'export { add };'].join('\n');

let changes = 0;
trackEditor(() => changes++);

test('the open file shows in the chat, with the highlighted lines', () => {
  focusEditor(fakeEditor('/proj/src/math.ts', SOURCE, [1, 3]) as any);
  assert.deepEqual(editorInfo(), { name: 'math.ts', path: '/proj/src/math.ts', selection: '1-3' });

  focusEditor(fakeEditor('/proj/src/math.ts', SOURCE) as any);
  assert.deepEqual(editorInfo(), { name: 'math.ts', path: '/proj/src/math.ts', selection: undefined }, 'no highlight, just the file');
});

test('highlighting lines updates the chat', () => {
  const before = changes;
  const editor = fakeEditor('/proj/src/math.ts', SOURCE, [2, 2]);
  events.selection.fire({ textEditor: editor as any });
  assert.equal(editorInfo()?.selection, '2-2');
  assert.ok(changes > before, 'the chat is told to refresh');
});

test('focusing the chat (no text editor) keeps the file the user was on', () => {
  focusEditor(fakeEditor('/proj/src/kept.ts', SOURCE, [4, 5]) as any);
  focusEditor(undefined);
  assert.equal(editorInfo()?.name, 'kept.ts');
  assert.equal(editorInfo()?.selection, '4-5');
});

test('non-file editors (output panel, settings) are ignored', () => {
  focusEditor(fakeEditor('/proj/src/real.ts', SOURCE) as any);
  const output = fakeEditor('/output', 'log');
  (output.document.uri as any).scheme = 'output';
  focusEditor(output as any);
  assert.equal(editorInfo()?.name, 'real.ts');
});

test('closing the file removes it from the chat', () => {
  const editor = fakeEditor('/proj/src/closing.ts', SOURCE);
  focusEditor(editor as any);
  editor.document.isClosed = true;
  events.closeDocument.fire(editor.document);
  assert.equal(editorInfo(), undefined);
});

test('a selection is sent instead of the file, and only once', () => {
  focusEditor(fakeEditor('/proj/src/math.ts', SOURCE, [1, 3]) as any);
  const seen = new Map<string, string>();
  const first = editorContext(seen)!;
  assert.match(first, /looking at \/proj\/src\/math\.ts/);
  assert.match(first, /selected lines 1-3:\n```typescript\nfunction add\(a, b\) \{\n {2}return a \+ b;\n\}\n```/);
  assert.doesNotMatch(first, /Current contents/);

  const second = editorContext(seen)!;
  assert.match(second, /still have lines 1-3 selected \(unchanged\)/);
  assert.doesNotMatch(second, /```/, 'an unchanged selection is not resent');
});

test('without a selection the file is sent once, and not after the agent wrote it', () => {
  focusEditor(fakeEditor('/proj/src/math.ts', SOURCE) as any);
  const seen = new Map<string, string>();
  assert.match(editorContext(seen)!, /Current contents of math\.ts/);
  const second = editorContext(seen)!;
  assert.match(second, /unchanged since you last saw them/);
  assert.doesNotMatch(second, /Current contents/, 'unchanged contents are not resent');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-seen-'));
  const file = path.join(dir, 'new.ts');
  fs.writeFileSync(file, 'export const x = 1;\n');
  markSeen(seen, file);
  focusEditor(fakeEditor(file, 'export const x = 1;\n') as any);
  assert.match(editorContext(seen)!, /unchanged since you last saw them/);
});

test('before any editor event, the active editor is used', () => {
  // The last file was closed, and VS Code has another one active that no event announced yet.
  const prev = fakeEditor('/proj/src/prev.ts', SOURCE);
  focusEditor(prev as any);
  prev.document.isClosed = true;
  events.closeDocument.fire(prev.document);
  focusEditor(fakeEditor('/proj/src/startup.ts', SOURCE, [2, 3]) as any, false);
  assert.deepEqual(editorInfo(), { name: 'startup.ts', path: '/proj/src/startup.ts', selection: '2-3' });
});

test('a cold index is skipped after a short wait instead of holding the turn', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-cold-'));
  try {
    indexRepo = () => new Promise<IndexedFile[]>(() => undefined);
    assert.equal(await likelyRelevant(bin, 'recompute the cart total somehow', []), undefined);
    indexRepo = async () => [];
    assert.equal(await likelyRelevant(bin, 'recompute the cart total somehow', []), undefined);
    const started = Date.now();
    assert.equal(await likelyRelevant(bin, 'recompute the cart total somehow', []), undefined);
    assert.ok(Date.now() - started < 1500);
  } finally {
    indexRepo = realIndexRepo;
    resetIndexCacheForTests();
  }
});

test('a warm index gives the likely relevant block for a message naming no file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-warm-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'cart.ts'), 'export function recomputeTotal() {\n  return 0;\n}\n');
  fs.writeFileSync(path.join(dir, 'src', 'auth.ts'), 'export function login() {\n  return 1;\n}\n');
  try {
    assert.equal(repoIndex.cachedIndex(dir), undefined, 'nothing cached before indexing');
    await realIndexRepo(dir);
    assert.deepEqual(repoIndex.cachedIndex(dir)?.map((f) => f.rel).sort(), ['src/auth.ts', 'src/cart.ts'], 'the turn reads the loaded index without waiting');
    const block = (await likelyRelevant(dir, 'recompute the cart total', []))!;
    assert.match(block, /src\/cart\.ts: recomputeTotal L1/);
    assert.doesNotMatch(block, /auth\.ts/);
    assert.equal(await likelyRelevant(dir, 'look at src/cart.ts', []), undefined);
    assert.equal(await likelyRelevant(dir, 'the things and stuff work fine', []), undefined);
  } finally {
    await flushIndex();
    resetIndexCacheForTests();
  }
});

test('large files are referenced by path rather than pasted', () => {
  focusEditor(fakeEditor('/proj/big.ts', 'x'.repeat(50_000)) as any);
  const ctx = editorContext(new Map())!;
  assert.match(ctx, /It is large, so read the parts you need/);
  assert.ok(ctx.length < 1000);
});

test('attachments: text inline, images as image blocks, binaries and missing files by path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-attach-'));
  const text = path.join(dir, 'notes.txt');
  const png = path.join(dir, 'pic.png');
  const bin = path.join(dir, 'data.bin');
  fs.writeFileSync(text, 'hello notes');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3, 0]));

  const blocks = attachmentBlocks([text, png, bin, path.join(dir, 'gone.txt')]);
  assert.match((blocks[0] as any).text, /notes\.txt:\n```\nhello notes\n```/);
  assert.equal(blocks[2].type, 'image');
  assert.equal((blocks[2] as any).source.media_type, 'image/png');
  assert.match((blocks[3] as any).text, /data\.bin \(data\.bin, 5 bytes\)\. Read it with your tools/);
  assert.match((blocks[4] as any).text, /gone\.txt could not be read/);
});

test('an unreadable attachment is described, not dropped or thrown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-attach-'));
  const blocks = attachmentBlocks([dir, path.join(dir, 'missing.txt')]);
  assert.equal(blocks.length, 2);
  assert.match((blocks[0] as any).text, /Read it with your tools/);
  assert.match((blocks[1] as any).text, /could not be read/);
});

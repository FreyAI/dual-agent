import '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChatHistory, ChatRecorder, MAX_CHAT_CHARS, SavedChat, newestWithin } from '../../history';

/** In-memory stand-in for VS Code's workspaceState. */
function memento() {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => (data.has(key) ? structuredClone(data.get(key)) : fallback) as T,
    // As in VS Code, undefined removes the key.
    update: async (key: string, value: unknown) => void (value === undefined ? data.delete(key) : data.set(key, structuredClone(value))),
    keys: () => [...data.keys()],
  };
}

function conversation(recorder: ChatRecorder, text: string) {
  recorder.record({ type: 'state', busy: false });
  recorder.record({ type: 'user', text, attachments: [] });
  recorder.record({ type: 'assistantStart', provider: 'deepseek', effort: 'thinking' });
  recorder.record({ type: 'delta', text: 'Hel' });
  recorder.record({ type: 'delta', text: 'lo ' });
  recorder.record({ type: 'delta', text: 'there' });
  recorder.record({ type: 'tool', name: 'Read', detail: 'src/a.ts' });
  recorder.record({ type: 'usage', usage: { input: 10, output: 2, context: 10, cost: 0 } });
  recorder.record({ type: 'usage', usage: { input: 30, output: 9, context: 25, cost: 0 } });
  recorder.record({ type: 'permission', id: 'p1', title: 'Allow?' });
  recorder.record({ type: 'done', summary: 'DeepSeek · 30 in / 9 out tokens' });
}

test('a chat is recorded compactly: text pieces merged, one usage total, no transient UI', async () => {
  const history = new ChatHistory(memento() as any);
  const recorder = new ChatRecorder(history);
  conversation(recorder, 'Explain the build');
  await recorder.save('session-1');

  const saved = history.get(recorder.chat!.id)!;
  assert.equal(saved.title, 'Explain the build');
  assert.equal(saved.sessionId, 'session-1');
  assert.deepEqual(saved.providers, ['deepseek']);
  assert.deepEqual(
    saved.transcript.map((e) => e.type),
    ['user', 'assistantStart', 'delta', 'tool', 'usage', 'done'],
  );
  assert.equal(saved.transcript[2].text, 'Hello there');
  assert.deepEqual(saved.transcript[4].usage, { input: 30, output: 9, context: 25, cost: 0 });
});

test('nothing is saved until the first message', async () => {
  const history = new ChatHistory(memento() as any);
  const recorder = new ChatRecorder(history);
  recorder.record({ type: 'state' });
  recorder.record({ type: 'notice', level: 'info', text: 'hi' });
  await recorder.save('s');
  assert.deepEqual(history.list(), []);
});

test('chats are listed newest first, and latest() is the most recent', async () => {
  const history = new ChatHistory(memento() as any);
  for (const title of ['first', 'second', 'third']) {
    const r = new ChatRecorder(history);
    conversation(r, title);
    await r.save(undefined);
    await new Promise((res) => setTimeout(res, 5));
  }
  assert.deepEqual(history.list().map((c) => c.title), ['third', 'second', 'first']);
  assert.equal(history.latest()!.title, 'third');
  assert.equal(history.list()[0].messages, 1);
});

test('reopening a chat keeps adding to it rather than starting a new one', async () => {
  const history = new ChatHistory(memento() as any);
  const first = new ChatRecorder(history);
  conversation(first, 'original');
  await first.save('s1');
  const id = first.chat!.id;

  const reopened = new ChatRecorder(history);
  reopened.load(history.get(id));
  reopened.record({ type: 'user', text: 'follow-up', attachments: [] });
  await reopened.save('s1');
  assert.equal(history.list().length, 1);
  assert.equal(history.get(id)!.transcript.filter((e) => e.type === 'user').length, 2);
  assert.equal(history.get(id)!.title, 'original', 'the title stays the first message');
});

test('long titles are shortened, and only the newest 50 chats are kept', async () => {
  const history = new ChatHistory(memento() as any);
  const r = new ChatRecorder(history);
  r.record({ type: 'user', text: `${'word '.repeat(30)}\nsecond line`, attachments: [] });
  await r.save(undefined);
  assert.ok(history.list()[0].title.length <= 60);
  assert.ok(history.list()[0].title.endsWith('…'));

  for (let i = 0; i < 55; i++) {
    const chat: SavedChat = { id: `c${i}`, title: `chat ${i}`, createdAt: i, updatedAt: Date.now() + 1000 + i, providers: [], transcript: [] };
    await history.save(chat);
  }
  assert.equal(history.list().length, 50);
  assert.equal(history.list()[0].title, 'chat 54');
});

test('delete and clear', async () => {
  const history = new ChatHistory(memento() as any);
  for (const t of ['a', 'b']) {
    const r = new ChatRecorder(history);
    conversation(r, t);
    await r.save(undefined);
  }
  const [b, a] = history.list();
  await history.delete(a.id);
  assert.deepEqual(history.list().map((c) => c.id), [b.id]);
  await history.clear();
  assert.deepEqual(history.list(), []);
});

test('a saved chat is capped at about 1 MB, dropping its oldest entries first', async () => {
  const history = new ChatHistory(memento() as any);
  const recorder = new ChatRecorder(history);
  recorder.record({ type: 'user', text: 'first', attachments: [] });
  for (let i = 0; i < 30; i++) {
    recorder.record({ type: 'tool', name: 'Read', detail: `${i} ${'x'.repeat(50_000)}` });
  }
  recorder.record({ type: 'user', text: 'newest', attachments: [] });
  await recorder.save(undefined);
  const saved = history.latest()!;
  assert.ok(JSON.stringify(saved.transcript).length <= MAX_CHAT_CHARS);
  assert.equal(saved.transcript.at(-1)?.text, 'newest', 'the newest entries stay');
  assert.ok(!saved.transcript.some((e) => e.text === 'first'), 'the oldest went');
  assert.deepEqual(newestWithin([{ type: 'delta', text: 'y'.repeat(100) }], 10).length, 1, 'one oversized entry is still kept');
});

test('a failed save is logged, never an unhandled rejection', async () => {
  const lines: string[] = [];
  const broken = { ...memento(), update: async () => { throw new Error('disk full'); } };
  const recorder = new ChatRecorder(new ChatHistory(broken as any), (l) => lines.push(l));
  recorder.record({ type: 'user', text: 'hi', attachments: [] });
  await recorder.save(undefined);
  assert.match(lines[0], /disk full/);
});

test('saved chats share a total budget: the oldest go first, the newest always stays', async () => {
  const history = new ChatHistory(memento() as any, 3000);
  const chat = (id: string, at: number, chars: number): SavedChat => ({ id, title: id, createdAt: at, updatedAt: at, providers: [], transcript: [{ type: 'delta', text: 'x'.repeat(chars) }] });
  await history.save(chat('a', 1, 1000));
  await history.save(chat('b', 2, 1000));
  await history.save(chat('c', 3, 1000));
  assert.deepEqual(history.list().map((c) => c.id), ['c', 'b'], 'the oldest chat is dropped');
  await history.save(chat('d', 4, 5000));
  assert.deepEqual(history.list().map((c) => c.id), ['d'], 'the newest stays even over the budget');
});

test('the old one-array store moves into per-chat keys, losing nothing, and a second run changes nothing', async () => {
  const m = memento();
  const chat = (id: string, at: number, text: string): SavedChat => ({ id, title: id, createdAt: at, updatedAt: at, providers: ['claude'], transcript: [{ type: 'user', text }] });
  await m.update('dualAgent.chats', [chat('a', 1, 'old a'), chat('b', 2, 'old b')]);
  // Another window already saved a newer "b": the old copy must not overwrite it.
  await m.update('dualAgent.chatIndex', [{ id: 'b', title: 'b', updatedAt: 5, messages: 1, size: 10 }]);
  await m.update('dualAgent.chat:b', chat('b', 5, 'new b'));
  const history = new ChatHistory(m as any);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(history.list().map((c) => c.id), ['b', 'a']);
  assert.equal(history.get('a')!.transcript[0].text, 'old a');
  assert.equal(history.get('b')!.transcript[0].text, 'new b');
  assert.equal(m.get('dualAgent.chats'), undefined, 'the old key is removed');
  const stored = () => JSON.stringify(m.keys().filter((k) => k !== 'dualAgent.chats').map((k) => [k, m.get(k)]));
  const before = stored();
  await m.update('dualAgent.chats', [chat('a', 1, 'old a')]);
  new ChatHistory(m as any);
  await new Promise((res) => setImmediate(res));
  assert.equal(stored(), before, 'running it again is a no-op');
  assert.equal(m.get('dualAgent.chats'), undefined);
});

test('a save writes only its own chat; delete and clear remove the per-chat keys', async () => {
  const m = memento();
  const writes: string[] = [];
  const watched = { ...m, update: async (key: string, value: unknown) => (writes.push(key), m.update(key, value)) };
  const history = new ChatHistory(watched as any);
  for (const t of ['a', 'b', 'c']) {
    const r = new ChatRecorder(history);
    conversation(r, t);
    writes.length = 0;
    await r.save(undefined);
  }
  assert.deepEqual(writes.sort(), [`dualAgent.chat:${history.latest()!.id}`, 'dualAgent.chatIndex'], 'one chat and the index');
  const [c, b] = history.list();
  await history.delete(b.id);
  assert.ok(!m.keys().includes(`dualAgent.chat:${b.id}`));
  assert.equal(history.get(b.id), undefined);
  await history.clear();
  assert.deepEqual(m.keys().filter((k) => k.startsWith('dualAgent.chat:')), []);
  assert.equal(history.get(c.id), undefined);
});

test('chats dropped by the caps lose their keys', async () => {
  const m = memento();
  const history = new ChatHistory(m as any, 3000);
  const chat = (id: string, at: number): SavedChat => ({ id, title: id, createdAt: at, updatedAt: at, providers: [], transcript: [{ type: 'delta', text: 'x'.repeat(1000) }] });
  for (const [id, at] of [['a', 1], ['b', 2], ['c', 3]] as const) {
    await history.save(chat(id, at));
  }
  assert.deepEqual(m.keys().filter((k) => k.startsWith('dualAgent.chat:')).sort(), ['dualAgent.chat:b', 'dualAgent.chat:c']);
});

test('a reply capped at 100k characters stops growing: later pieces are dropped, not re-sliced', () => {
  const recorder = new ChatRecorder(new ChatHistory(memento() as any));
  recorder.record({ type: 'user', text: 'long', attachments: [] });
  recorder.record({ type: 'delta', text: 'x'.repeat(99_990) });
  recorder.record({ type: 'delta', text: 'y'.repeat(20) });
  const capped = recorder.chat!.transcript.at(-1)!;
  assert.equal(capped.text, `${'x'.repeat(99_990)}${'y'.repeat(10)}…`);
  for (let i = 0; i < 100; i++) {
    recorder.record({ type: 'delta', text: 'more' });
  }
  assert.equal(recorder.chat!.transcript.at(-1), capped, 'the capped entry is left as it was');
});

test('a save after a sent message waits (one save per burst); save() runs at once and cancels it', async () => {
  const history = new ChatHistory(memento() as any);
  const recorder = new ChatRecorder(history);
  let saves = 0;
  recorder.record({ type: 'user', text: 'hi', attachments: [] });
  recorder.saveSoon(() => saves++, 30);
  recorder.saveSoon(() => saves++, 30);
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(saves, 1);
  recorder.saveSoon(() => saves++, 30);
  await recorder.save(undefined);
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(saves, 1, 'the pending save was cancelled');
  assert.equal(history.list().length, 1);
});

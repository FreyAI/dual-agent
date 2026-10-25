import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'net';
import { Launch, cancelDictation, toggleDictation } from '../../dictation';

/** A stand-in for the helper app: connects back, says hello with `token`, and records what it's told. */
function fakeHelper(lines: (token: string) => object[], heard: string[] = [], token?: string): Launch {
  return async (port, real) => {
    const s = net.connect(port, '127.0.0.1');
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      heard.push(...d.trim().split('\n'));
      // Like the app: answer a stop or cancel, then quit.
      s.end(`${JSON.stringify({ type: 'done', send: heard.at(-1) === 'stop' })}\n`);
    });
    s.on('error', () => undefined);
    for (const l of [{ type: 'hello', token: token ?? real }, ...lines(real)]) {
      s.write(`${JSON.stringify(l)}\n`);
    }
  };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(cond(), 'timed out');
};

test('dictation streams the helper\'s words and level to the chat, then has it send', async () => {
  const posted: any[] = [];
  const chat = {};
  toggleDictation(chat, (m) => posted.push(m), fakeHelper(() => [
    { type: 'listening', device: 'MacBook Air Microphone' },
    { type: 'level', level: 0.4 },
    { type: 'text', text: 'fix the' },
    { type: 'text', text: 'fix the failing test' },
    { type: 'done', send: true },
  ]));
  await until(() => posted.at(-1)?.state === 'off');
  assert.deepEqual(posted, [
    { type: 'dictation', state: 'starting' },
    { type: 'dictation', state: 'listening', level: 0 },
    { type: 'dictation', state: 'listening', level: 0.4 },
    { type: 'dictation', state: 'listening', text: 'fix the' },
    { type: 'dictation', state: 'listening', text: 'fix the failing test' },
    { type: 'dictation', state: 'off', send: true, problem: undefined },
  ]);
});

test('clicking the mic again tells the helper to finish; editing tells it to cancel', async () => {
  const posted: any[] = [];
  const heard: string[] = [];
  const chat = {};
  toggleDictation(chat, (m) => posted.push(m), fakeHelper(() => [{ type: 'listening' }], heard));
  await until(() => posted.some((m) => m.state === 'listening'));
  toggleDictation(chat, (m) => posted.push(m), fakeHelper(() => []));
  await until(() => posted.at(-1)?.state === 'off');
  assert.deepEqual([heard, posted.at(-1).send], [['stop'], true]);

  heard.length = 0;
  toggleDictation(chat, (m) => posted.push(m), fakeHelper(() => [{ type: 'listening' }, { type: 'text', text: 'add a' }], heard));
  await until(() => posted.at(-1)?.text === 'add a');
  cancelDictation(chat);
  await until(() => posted.at(-1)?.state === 'off');
  assert.deepEqual([heard, posted.at(-1).send], [['cancel'], false]);
});

test('a helper without the token is turned away, and the chat hears why nothing started', async () => {
  const posted: any[] = [];
  const chat = {};
  // Ends at the 10 s hello timeout otherwise; cancelling frees the chat at once.
  toggleDictation(chat, (m) => posted.push(m), fakeHelper(() => [{ type: 'text', text: 'sneaky' }], [], 'wrong'));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!posted.some((m) => m.text === 'sneaky'));
  cancelDictation(chat);
  assert.deepEqual(posted.at(-1), { type: 'dictation', state: 'off', send: false, problem: undefined });
});

test('a helper that fails to open is reported', async () => {
  const posted: any[] = [];
  toggleDictation({}, (m) => posted.push(m), () => Promise.reject(new Error('Unable to find application')));
  await until(() => posted.at(-1)?.state === 'off');
  assert.match(posted.at(-1).problem, /Unable to find application/);
});

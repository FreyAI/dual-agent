import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { askAdvisor } from '../../agent/advisor';

const call = { baseUrl: 'https://api.example.com/anthropic/', key: 'sk-x', model: 'deepseek-v4-pro' };

test('advisor: one call with the brief, the answer text back; errors say what failed', async () => {
  let sent: any;
  const ok = (async (url: string, init: any) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Check the id parser at a.ts:10.' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await askAdvisor(call, 'Why does the id check fail?', 'a.ts:10 throws on uuid', ok), 'Check the id parser at a.ts:10.');
  assert.equal(sent.url, 'https://api.example.com/anthropic/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'sk-x');
  assert.equal(sent.body.model, 'deepseek-v4-pro');
  assert.match(sent.body.messages[0].content, /Why does the id check fail\?\n\na\.ts:10 throws/);
  const bad = (async () => new Response('{"error":{"message":"overloaded"}}', { status: 529 })) as unknown as typeof fetch;
  await assert.rejects(askAdvisor(call, 'q', 'c', bad), /advisor HTTP 529: .*overloaded/);
  const empty = (async () => new Response('{"content":[]}', { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(askAdvisor(call, 'q', 'c', empty), /no answer/);
});

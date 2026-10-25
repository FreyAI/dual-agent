import { resetConfig } from '../helpers/vscodeStub';
import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { bestClaude, displayName, noteClaudeModels, rankDeepSeek, refreshDeepSeekModels, resetModels } from '../../models';
import { deepseekModel } from '../../providers';

const store = (init: Record<string, unknown> = {}) => {
  const data = { ...init };
  return { data, get: <T>(k: string) => data[k] as T | undefined, update: async (k: string, v: unknown) => void (data[k] = v) };
};
const reply = (ids: string[], status = 200) => (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status })) as unknown as typeof fetch;

afterEach(() => {
  resetModels();
  resetConfig({});
});

test('ranking only upgrades the defaults to a newer stable version per tier', () => {
  assert.deepEqual(rankDeepSeek(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-flash']), {}, 'nothing newer: keep the defaults');
  assert.deepEqual(rankDeepSeek(['deepseek-v4-pro', 'deepseek-v5-pro', 'deepseek-v4.5-pro', 'deepseek-v5-flash']), { thinking: 'deepseek-v5-pro', flash: 'deepseek-v5-flash' });
  assert.deepEqual(rankDeepSeek(['deepseek-v6-pro-preview', 'deepseek-v3-pro']), {}, 'previews and older versions never win');
  assert.deepEqual(rankDeepSeek(['deepseek-v5-pro-flash']), { thinking: 'deepseek-v5-pro-flash' }, 'a strong model is never the fast one');
});

test('display names follow the model id', () => {
  assert.equal(displayName('deepseek-v4-pro'), 'V4 Pro');
  assert.equal(displayName('deepseek-flash'), 'DeepSeek Flash');
  assert.equal(displayName('deepseek-v5-flash'), 'V5 Flash');
});

test('deepseekModel: settings, else the discovered upgrade, else the default', async () => {
  assert.equal(deepseekModel('thinking'), 'deepseek-v4-pro');
  const s = store();
  assert.equal(await refreshDeepSeekModels(s, 'https://api.deepseek.com/anthropic', 'sk', reply(['deepseek-v5-pro']), 1000), undefined);
  assert.equal(deepseekModel('thinking'), 'deepseek-v5-pro');
  assert.equal(deepseekModel('flash'), 'deepseek-flash');
  resetConfig({ 'deepseek.model': 'deepseek-v4-pro' });
  assert.equal(deepseekModel('thinking'), 'deepseek-v4-pro', 'a model set by hand wins');
});

test('the model list is fetched from next to the Anthropic endpoint, with the key, and cached a day', async () => {
  const s = store();
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-v5-pro' }] }));
  }) as unknown as typeof fetch;
  await refreshDeepSeekModels(s, 'https://api.deepseek.com/anthropic', 'sk-1', fetchImpl, 1000);
  await refreshDeepSeekModels(s, 'https://api.deepseek.com/anthropic', 'sk-1', fetchImpl, 1000 + 3_600_000);
  assert.deepEqual(calls, ['https://api.deepseek.com/models Bearer sk-1'], 'the second call within a day reads the cache');
  await refreshDeepSeekModels(s, 'https://api.deepseek.com/anthropic', 'sk-1', fetchImpl, 1000 + 25 * 3_600_000);
  assert.equal(calls.length, 2, 'refreshed after a day');
});

test('a failed or empty model list keeps the defaults and says why', async () => {
  assert.match((await refreshDeepSeekModels(store(), 'https://api.deepseek.com/anthropic', 'sk', reply([], 401)))!, /HTTP 401.*keeping the default models/);
  assert.match((await refreshDeepSeekModels(store(), 'https://api.deepseek.com/anthropic', 'sk', reply([])))!, /no models/);
  const down = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
  const s = store();
  assert.match((await refreshDeepSeekModels(s, 'https://api.deepseek.com/anthropic', 'sk', down))!, /ECONNREFUSED/);
  assert.equal(s.data['dualAgent.deepseekModels'], undefined, 'nothing cached, so the next start tries again');
  assert.equal(deepseekModel('thinking'), 'deepseek-v4-pro');
});

test('Claude tiers use the families the account offers', () => {
  assert.deepEqual([bestClaude('planner'), bestClaude('helper'), bestClaude('fast')], ['opus', 'sonnet', 'haiku'], 'unknown until a session reports: the usual families');
  noteClaudeModels([{ value: 'default', resolvedModel: 'claude-sonnet-5-5' }, { value: 'haiku' }]);
  assert.equal(bestClaude('planner'), 'sonnet', 'no Opus on this account');
  assert.equal(bestClaude('fast'), 'haiku');
});

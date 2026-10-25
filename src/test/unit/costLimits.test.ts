import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { activeLimits, cappedKeys, costRows, limitStatus, limitsResetAt, nearing, resetLimits, spendSince, totalReached } from '../../costLimits';

const row = (model: string, output: number, at = 1000, billing: 'api' | 'subscription' = 'api') => ({ model, at, billing, input: 0, cacheRead: 0, cacheWrite: 0, output });

test('cost limits are off until one is set', () => {
  assert.equal(activeLimits(undefined, undefined), undefined);
  assert.equal(activeLimits(0, {}), undefined);
  assert.equal(activeLimits(0, { 'deepseek-v4-pro': 0 }), undefined, 'a 0 limit is off');
  assert.deepEqual(activeLimits(5, { x: 'bad' as unknown as number, 'deepseek-flash': 2 }), { total: 5, perModel: { 'deepseek-flash': 2 } });
});

test('spend counts billed calls since the reset, per model; subscription use is free', () => {
  const spend = spendSince([row('deepseek-v4-pro', 1_000_000), row('deepseek-v4-pro', 1_000_000, 10), row('claude-opus-5-5', 1_000_000, 1000, 'subscription')], 100);
  assert.equal(spend.byModel.size, 1);
  assert.ok(spend.total > 0 && spend.total === spend.byModel.get('deepseek-v4-pro'));
});

test('a model limit covers every id it starts, and Claude Code\'s aliases', () => {
  const spend = spendSince([row('claude-sonnet-5-5', 1_000_000), row('deepseek-flash', 10)], 0);
  const status = limitStatus(spend, { total: 0, perModel: { 'claude-sonnet': 0.01, 'deepseek-flash': 100 } });
  assert.deepEqual(cappedKeys(status, 'claude-sonnet-5-5'), ['claude-sonnet']);
  assert.deepEqual(cappedKeys(status, 'sonnet'), ['claude-sonnet'], 'the alias the router uses');
  assert.deepEqual(cappedKeys(status, 'deepseek-flash'), [], 'under its limit');
  assert.equal(totalReached(status), false, 'no total limit');
});

test('limits warn from 80% until reached', () => {
  const status = limitStatus({ total: 8.5, byModel: new Map([['deepseek-v4-pro', 8.5]]) }, { total: 10, perModel: { 'deepseek-v4-pro': 8 } });
  assert.deepEqual(nearing(status).map((n) => n.key), ['all'], 'the model limit is reached, not near');
  assert.match(nearing(status)[0].text, /all models: \$8\.50 of \$10\.00/);
});

test('the reset time is kept next to the usage files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-'));
  assert.equal(limitsResetAt(dir), 0);
  resetLimits(dir, 1234);
  assert.equal(limitsResetAt(dir), 1234);
});

test('the Cost tab lists limited models, then the others that spent', () => {
  const spend = { total: 3, byModel: new Map([['claude-sonnet-5-5', 1], ['deepseek-flash', 0.5], ['deepseek-v4-pro', 1.5]]) };
  assert.deepEqual(costRows(spend, { 'claude-sonnet': 5 }), [
    { key: 'claude-sonnet', spent: 1, limit: 5 },
    { key: 'deepseek-v4-pro', spent: 1.5, limit: 0 },
    { key: 'deepseek-flash', spent: 0.5, limit: 0 },
  ]);
});

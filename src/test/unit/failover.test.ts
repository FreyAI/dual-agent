import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { FailedTurn, canRetry, errorCode, pauseUntil, recover, statusIn, stopRetrying } from '../../agent/failover';

const failed = (over: Partial<FailedTurn>): FailedTurn => ({
  provider: 'claude',
  code: 'rate_limit',
  producedOutput: false,
  fallbackUsed: false,
  freshRetryUsed: false,
  resumedAcross: false,
  retries: 0,
  ...over,
});

test('history the other provider wrote and this one refuses: retry fresh, once', () => {
  assert.deepEqual(recover(failed({ code: 'invalid_request', resumedAcross: true }), false), { kind: 'freshRetry' });
  assert.deepEqual(recover(failed({ code: 'invalid_request', resumedAcross: true, freshRetryUsed: true, retries: 3 }), false), { kind: 'report' });
});

test('a failed reply is retried three times, then goes to the other provider, then is reported', () => {
  const err = (over: Partial<FailedTurn>) => failed({ provider: 'deepseek', code: 'unknown', ...over });
  assert.deepEqual(recover(err({}), true), { kind: 'retry', attempt: 1, continuing: false });
  assert.deepEqual(recover(err({ retries: 2, producedOutput: true }), true), { kind: 'retry', attempt: 3, continuing: true });
  assert.deepEqual(recover(err({ retries: 3 }), true), { kind: 'switch', to: 'claude', continuing: false });
  assert.deepEqual(recover(err({ retries: 3, producedOutput: true }), true), { kind: 'switch', to: 'claude', continuing: true });
  assert.deepEqual(recover(err({ retries: 3 }), false), { kind: 'report' }, 'nothing to switch to');
  assert.deepEqual(recover(err({ retries: 3, fallbackUsed: true }), true), { kind: 'report' }, 'never ping-pong');
  assert.deepEqual(recover(err({ code: 'invalid_request' }), true), { kind: 'switch', to: 'claude', continuing: false }, 'a bad request is not resent as is');
  assert.deepEqual(recover(err({ code: 'invalid_request' }), false), { kind: 'report' });
});

test('usage limits and account problems switch at once: retrying cannot fix them', () => {
  assert.deepEqual(recover(failed({}), true), { kind: 'switch', to: 'deepseek', continuing: false });
  assert.deepEqual(recover(failed({ code: 'authentication_failed' }), true), { kind: 'switch', to: 'deepseek', continuing: false });
  assert.deepEqual(recover(failed({ code: 'billing_error' }), false), { kind: 'report' });
});

test('retries stop at once for permanent errors, and early only when switching helps', () => {
  assert.equal(stopRetrying('authentication_failed', 1, false), true);
  assert.equal(stopRetrying('rate_limit', 1, true), true);
  assert.equal(stopRetrying('rate_limit', 1, false), false);
  assert.equal(stopRetrying('overloaded', 2, true), false, 'outages get a few tries first');
  assert.equal(stopRetrying('overloaded', 3, true), true);
});

test('a provider pause uses its reset time (seconds or ms), else the cooldown', () => {
  assert.equal(pauseUntil(1_900_000_000, 30), 1_900_000_000_000);
  assert.equal(pauseUntil(1_900_000_000_000, 30), 1_900_000_000_000);
  assert.equal(pauseUntil(undefined, 30, 1000), 1000 + 30 * 60_000);
});

test('a DeepSeek 400 or 422 that Claude Code calls unknown is a bad request', () => {
  assert.equal(errorCode('unknown', 'API Error: 422 Failed to deserialize the JSON body into the target type'), 'invalid_request');
  assert.equal(errorCode('unknown', 'API Error: 400 messages: invalid'), 'invalid_request');
  assert.equal(errorCode('unknown', 'API Error: 500 upstream'), 'server_error');
  assert.equal(errorCode('unknown', 'connection reset'), 'unknown');
  assert.equal(errorCode('overloaded', 'API Error: 400'), 'overloaded', 'a known code is kept');
});

test('DeepSeek out of balance (402) is a billing error: never retried', () => {
  const code = errorCode('unknown', 'API Error: 402 Insufficient Balance');
  assert.equal(code, 'billing_error');
  assert.equal(canRetry(code), false);
});

test('failover: an unknown error takes its code from the HTTP status (2026-10-19: retries never stopped for these)', () => {
  assert.equal(errorCode('unknown', '', 503), 'server_error');
  assert.equal(errorCode('unknown', '', 529), 'overloaded');
  assert.equal(errorCode('unknown', '', 429), 'rate_limit');
  assert.equal(errorCode('unknown', '', null, true), 'server_error', 'no response at all');
  assert.equal(errorCode(undefined, 'API Error: 401 invalid x-api-key'), 'authentication_failed');
  assert.equal(statusIn('API Error: 529 {"type":"overloaded_error"}'), 529);
  assert.equal(stopRetrying(errorCode('unknown', '', 503), 3, true), true, 'an unmapped outage now stops after 3 tries');
  assert.equal(canRetry('authentication_failed'), false);
  assert.equal(canRetry('max_output_tokens'), false);
  assert.equal(canRetry('server_error'), true);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { withTimeout } from '../../async';

test('withTimeout passes results through and rejects slow work with a clear message', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, 'Fast thing'), 7);
  await assert.rejects(withTimeout(new Promise(() => {}), 50, 'The language server'), /The language server did not answer within 0s/);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50, 'x'), /boom/);
});

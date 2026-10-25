import '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { bridgeState } from '../../remote';

test('Remote Control is connected once its bridge registers or polls, and not when it goes offline', () => {
  assert.equal(bridgeState('/v1/environments/bridge', 200), 'connected');
  assert.equal(bridgeState('/v1/environments/env_1/work/poll', 200), 'connected');
  assert.equal(bridgeState('/v1/environments/bridge', 401), 'starting', 'a refused registration');
  assert.equal(bridgeState('/v1/environments/env_1/work/poll', 503), undefined, 'a passing outage changes nothing');
  assert.equal(bridgeState('/v1/environments/bridge/env_1/offline', 200), 'starting');
  assert.equal(bridgeState('/v1/messages', 200), undefined);
});

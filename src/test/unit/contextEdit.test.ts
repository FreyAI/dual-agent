import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { withToolClearing } from '../../proxy/contextEdit';

test('tool clearing joins the edits Claude Code already sends, after clear_thinking, once', () => {
  const body = { model: 'claude', messages: [], context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } };
  const out = withToolClearing(body) as any;
  assert.deepEqual(out.context_management.edits.map((e: any) => e.type), ['clear_thinking_20251015', 'clear_tool_uses_20250919']);
  const clearing = out.context_management.edits[1];
  assert.deepEqual([clearing.trigger.value, clearing.keep.value, clearing.clear_at_least.value], [100_000, 6, 40_000], 'clears in batches of 40k so the cache is rewritten rarely');
  assert.equal((withToolClearing(out) as any).context_management.edits.length, 2, 'applying twice adds nothing');
  assert.deepEqual((body as any).context_management.edits.length, 1, 'the input is not changed');
  const side = { messages: [] };
  assert.equal(withToolClearing(side), side, 'requests sent without context management (and its beta header) stay unchanged');
});

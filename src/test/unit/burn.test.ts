import '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { HelperTracker } from '../../metrics/helpers';
import { ChatUsage } from '../../agent/chatUsage';
import { burnReport } from '../../diag/burn';
import { recentDiag, resetDiag } from '../../diag/log';
import type { ToWebview } from '../../protocol';

const base = { machine: 'm', session: 's1', repo: 'github.com/me/app' };
const zero = { calls: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0, peakContext: 0, model: undefined };

test('helpers: a launch is tracked by spawn id and task id, and ends once with its tools and outcome', () => {
  const h = new HelperTracker();
  h.spawn('toolu_1', 'general-purpose', 1200, 'turn-a', false);
  h.task('task-1', 'toolu_1', true);
  assert.equal(h.idOf('task-1'), 'toolu_1');
  assert.equal(h.spawnTurnOf('task-1'), 'turn-a');
  assert.ok(h.isBackground('toolu_1'), 'Claude Code said it was backgrounded');
  h.tool('toolu_1', 'Read', 30_000);
  h.tool('task-1', 'Read', 2_000);
  h.outcome('task-1', 'checked', 900);
  const row = h.end('task-1', () => ({ ...zero, calls: 12, cost: 0.4, model: 'deepseek-flash' }), base);
  assert.equal(row?.id, 'toolu_1');
  assert.deepEqual(row?.tools, { Read: { calls: 2, outChars: 32_000 } });
  assert.equal(row?.outcome, 'checked');
  assert.equal(row?.reportChars, 900);
  assert.equal(row?.calls, 12);
  assert.equal(h.end('toolu_1', () => zero, base), undefined, 'ends once');
  assert.deepEqual(h.running(), []);
});

test('usage: a helper\'s totals add up its calls; a DeepSeek call that lost its cached prefix is logged', () => {
  resetDiag();
  const usage = new ChatUsage(() => undefined, () => '/repo');
  const call = { session: 's1', provider: 'deepseek' as const, agent: 'general-purpose', model: 'deepseek-flash', billing: 'api' as const, helper: 'toolu_9' };
  usage.call('d1', call, { input_tokens: 2_000, cache_read_input_tokens: 40_000, output_tokens: 100 });
  usage.call('d2', call, { input_tokens: 1_000, cache_read_input_tokens: 41_000, output_tokens: 100 });
  assert.equal(recentDiag(60_000).filter((r) => r.kind === 'cache_miss').length, 0, 'a normal cache hit');
  usage.call('d3', call, { input_tokens: 40_000, cache_read_input_tokens: 4_000, output_tokens: 100 });
  const miss = recentDiag(60_000).filter((r) => r.kind === 'cache_miss');
  assert.equal(miss.length, 1);
  assert.equal(miss[0].code, 'prefix_dropped');
  assert.equal(miss[0].agent, 'toolu_9');
  assert.match(miss[0].detail ?? '', /read 4\.0k of the previous 42k; ~40k sent at full price/);
  usage.call('m1', { ...call, agent: 'Main agent', helper: undefined, model: 'deepseek-v4-pro' }, { input_tokens: 10, output_tokens: 5 });
  const t = usage.helperTotals('toolu_9');
  assert.equal(t.calls, 3);
  assert.equal(t.tokens.input, 43_000);
  assert.equal(t.peakContext, 44_000);
  assert.equal(t.model, 'deepseek-flash');
  usage.dispose();
});

test('usage: ten minutes of fast spending is logged and said once, with who spent it', () => {
  resetDiag();
  const posted: ToWebview[] = [];
  const usage = new ChatUsage((m) => posted.push(m), () => '/repo');
  const opus = { session: 's1', provider: 'claude' as const, agent: 'Main agent', model: 'claude-opus-5-5', billing: 'subscription' as const };
  usage.call('o1', opus, { input_tokens: 10, cache_creation_input_tokens: 300_000, output_tokens: 1_000 });
  assert.equal(recentDiag(60_000).filter((r) => r.kind === 'burn_spike').length, 0, '$2.42 is under the line');
  usage.call('o2', opus, { input_tokens: 10, cache_creation_input_tokens: 300_000, output_tokens: 1_000 });
  const spikes = recentDiag(60_000).filter((r) => r.kind === 'burn_spike');
  assert.equal(spikes.length, 1);
  assert.match(spikes[0].detail ?? '', /^Spending fast: \$4\.84 and 602k new tokens in the last 10 minutes: the main agent \$4\.84 \(2 calls\)\.$/);
  usage.call('o3', opus, { input_tokens: 10, cache_creation_input_tokens: 300_000, output_tokens: 1_000 });
  assert.equal(recentDiag(60_000).filter((r) => r.kind === 'burn_spike').length, 1, 'once per window');
  assert.equal(posted.filter((m) => m.type === 'notice' && /Diagnose Token Burn/.test(m.text)).length, 1);
  usage.dispose();
});

test('the burn report says where the window\'s tokens went and what to look at first', () => {
  const at = Date.UTC(2026, 9, 21, 9, 5);
  const call = (agent: string, model: string, t: Record<string, number>, extra: Record<string, unknown> = {}): any => ({ at, machine: 'm', session: 'sess-aaaa1111', repo: 'github.com/me/app', provider: /deepseek/.test(model) ? 'deepseek' : 'claude', agent, model, billing: 'subscription', input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...t, ...extra });
  const turn = (implicit: boolean, cost: number, wokenBy?: string): any => ({ at, session: 'sess-aaaa1111', implicit, wokenBy, cost, tools: { Read: { calls: 4, errors: 0, ms: 0, outChars: 80_000 } }, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
  const text = burnReport({
    calls: [
      call('Main agent', 'claude-opus-5-5', { cacheWrite: 500_000, cacheRead: 100_000, output: 2_000 }),
      call('general-purpose', 'deepseek-flash', { cacheRead: 900_000, input: 20_000 }, { helper: 'toolu_abc123', spawnTurn: 't1' }),
    ],
    turns: [turn(false, 1), turn(true, 2, 'toolu_abc123'), turn(true, 1, 'toolu_abc123')],
    helpers: [{ at, endedAt: at + 120_000, ...{ machine: 'm', session: 'sess-aaaa1111', repo: 'github.com/me/app' }, id: 'toolu_abc123', type: 'general-purpose', model: 'deepseek-flash', promptChars: 900, calls: 40, tokens: { input: 20_000, cacheRead: 900_000, cacheWrite: 0, output: 0 }, cost: 0.02, peakContext: 30_000, tools: { Read: { calls: 9, outChars: 120_000 } }, outcome: 'unverified', background: true }],
    diag: [
      ...[1, 2, 3].map((): any => ({ at, machine: 'm', kind: 'big_output', code: 'Read', target: 'src/big.ts', agent: 'general-purpose', detail: '48k chars (~12k tokens)' })),
      { at, machine: 'm', kind: 'cache_miss', provider: 'claude', agent: 'main', code: 'messages_changed', detail: 'wrote 101k, read 10k' },
      { at, machine: 'm', kind: 'compaction', code: 'auto', detail: 'context 166k → 42k; summary 3000 chars' },
    ],
    since: at - 3_600_000,
    now: at + 60_000,
  });
  assert.match(text, /^# Token burn, last 1 hours/);
  assert.match(text, /## Where to look first\n\n- Helper reports woke the main agent 2 times for 1 messages of yours \(\$3\.00\)/);
  assert.match(text, /- Cache writes are 99% of Opus cost: see Cache misses\./);
  assert.match(text, /1 large output was produced 3 or more times/);
  assert.match(text, /\| sess-aaa \| app \| \$\d+\.\d\d \|/);
  assert.match(text, /\| \d\d:\d\d \| general-purpose \| deepseek-flash \| 40 \| 20k \| 900k \| 30k \| \$0\.02 \| 2\.0m \| unverified \| Read 120k chars in 9 \|/);
  assert.match(text, /\| Read \| src\/big\.ts \| 3 \| 48k chars \(~12k tokens\) \| general-purpose \|/);
  assert.match(text, /Woken by: general-purpose ×2 \(\$3\.00\)/);
  assert.match(text, /\| claude \| main \| messages_changed \| wrote 101k, read 10k \|/);
  assert.match(text, /## Compactions\n\n- \d\d:\d\d auto: context 166k → 42k/);
  assert.match(burnReport({ calls: [], turns: [], helpers: [], diag: [], since: 0 }), /No model calls in this window/);
});

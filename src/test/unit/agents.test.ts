import '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentTracker } from '../../agents';
import { Interactions } from '../../agent/interactions';
import { agentOptions, helperStart } from '../../agent/options';

const describe = (tool: string, input: any) => `${tool}:${input?.file_path ?? input?.description ?? ''}`;
const models: Record<string, string> = { 'quick-helper': 'deepseek-flash' };
const tracker = () => new AgentTracker(describe, (name) => models[name]);
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

test('the plan comes from the main agent\'s to-do list', () => {
  const t = tracker();
  t.startTurn('deepseek-v4-pro');
  t.mainMessage('m1', [toolUse('a', 'TodoWrite', { todos: [{ content: 'Read', status: 'completed', activeForm: 'Reading' }, { content: 'Fix', status: 'in_progress', activeForm: 'Fixing' }] })], { input_tokens: 100, output_tokens: 20 });
  const snap = t.snapshot();
  assert.deepEqual(snap.plan.map((p) => [p.content, p.status]), [['Read', 'completed'], ['Fix', 'in_progress']]);
  assert.equal(snap.agents[0].status, 'running');
  assert.equal(snap.agents[0].model, 'deepseek-v4-pro');
  assert.equal(snap.agents[0].tokens, 120);
});

test('a helper whose own messages never arrive shows the total Claude Code reports', () => {
  const t = tracker();
  t.startTurn('claude-opus-5-5');
  t.mainMessage('m1', [toolUse('call1', 'Agent', { description: 'Scan', subagent_type: 'quick-helper', prompt: '...' })], { input_tokens: 10, cache_read_input_tokens: 9000, output_tokens: 5 });
  t.taskStarted({ task_id: 'task1', tool_use_id: 'call1', description: 'Scan', subagent_type: 'quick-helper', spawn_depth: 1 });
  t.taskProgress({ task_id: 'task1', usage: { total_tokens: 700, tool_uses: 1 } });
  assert.equal(t.snapshot().agents[0].tokens, 15, 'cache re-reads are not new tokens');
  assert.equal(t.snapshot().agents[1].tokens, 700);
});

test('a sub-agent is tracked from start to finish, with its model, steps and tokens', () => {
  const t = tracker();
  t.startTurn('deepseek-v4-pro');
  t.mainMessage('m1', [toolUse('call1', 'Agent', { description: 'Find the bug', subagent_type: 'quick-helper', prompt: '...' })], { input_tokens: 50, output_tokens: 5 });
  t.taskStarted({ task_id: 'task1', tool_use_id: 'call1', description: 'Find the bug', subagent_type: 'quick-helper', spawn_depth: 1 });
  t.subMessage('call1', 's1', [toolUse('r1', 'Read', { file_path: '/a.ts' })], { input_tokens: 400, output_tokens: 10 });
  t.subMessage('call1', 's2', [toolUse('g1', 'Grep', { description: 'look' })], { input_tokens: 500, output_tokens: 10 });
  t.taskProgress({ task_id: 'task1', usage: { total_tokens: 1000, tool_uses: 2 }, summary: 'Searching billing code' });

  let sub = t.snapshot().agents[1];
  assert.equal(t.snapshot().agents.filter((a) => a.status === 'running').length, 2, 'main and the helper are running');
  assert.equal(sub.name, 'quick-helper');
  assert.equal(sub.model, 'deepseek-flash', 'helpers run on their own model');
  assert.equal(sub.description, 'Find the bug');
  assert.deepEqual(sub.steps.map((s) => s.detail), ['Read:/a.ts', 'Grep:look']);
  assert.equal(sub.tokens, 920, 'new tokens from its own messages, not the reported total (cache re-reads included)');
  assert.equal(sub.summary, 'Searching billing code');

  t.taskEnded({ task_id: 'task1', status: 'completed', summary: 'Found it in billing.ts', usage: { total_tokens: 1300, tool_uses: 3 } });
  sub = t.snapshot().agents[1];
  assert.equal(sub.status, 'done');
  assert.equal(sub.tokens, 920);
  assert.equal(sub.toolUses, 3);
  assert.equal(sub.summary, 'Found it in billing.ts');
  assert.ok(sub.endedAt);
  assert.equal(t.snapshot().tokens, 55 + 920);
});

test('without task events, the tool result still ends the sub-agent', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m1', [toolUse('call2', 'Agent', { description: 'Review', subagent_type: 'deep-thinker' })], undefined);
  assert.equal(t.snapshot().agents[1].status, 'running');
  t.mainToolResults([{ type: 'tool_result', tool_use_id: 'call2', is_error: true }]);
  assert.equal(t.snapshot().agents[1].status, 'failed');
  assert.equal(t.snapshot().agents[1].model, undefined, 'unknown helpers inherit the main model (none here)');
});

test('one API message is counted once, even when it arrives in parts', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('same', [], { input_tokens: 100, output_tokens: 10 });
  t.mainMessage('same', [toolUse('x', 'Read', {})], { input_tokens: 100, output_tokens: 10 });
  assert.equal(t.snapshot().agents[0].tokens, 110);
  assert.equal(t.snapshot().agents[0].steps.length, 1);
});

test('stopping marks running helpers stopped; finishing marks them done', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m', [toolUse('c', 'Agent', { description: 'x' })], undefined);
  t.endTurn(true);
  assert.equal(t.snapshot().agents[0].status, 'idle');
  assert.equal(t.snapshot().agents[1].status, 'stopped');
});

test('long step lists keep the latest steps and count the rest', () => {
  const t = tracker();
  t.startTurn();
  for (let i = 0; i < 50; i++) {
    t.mainMessage(`m${i}`, [toolUse(`r${i}`, 'Read', { file_path: `/f${i}` })], undefined);
  }
  const main = t.snapshot().agents[0];
  assert.equal(main.steps.length, 40);
  assert.equal(main.earlierSteps, 10);
  assert.equal(main.steps.at(-1)!.detail, 'Read:/f49');
  assert.equal(main.toolUses, 50);
});

test('a background helper keeps running after the reply, until it really finishes', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m', [toolUse('bg1', 'Agent', { description: 'Count lines', subagent_type: 'quick-helper' })], undefined);
  t.taskStarted({ task_id: 'tb', tool_use_id: 'bg1', description: 'Count lines', subagent_type: 'quick-helper', is_backgrounded: true });
  t.endTurn(false);
  assert.equal(t.snapshot().agents[1].status, 'running', 'still working after the reply ended');
  t.taskEnded({ task_id: 'tb', status: 'completed', summary: '7 lines' });
  assert.equal(t.snapshot().agents[1].status, 'done');
});

test('a helper sent to the background is still running when its Agent call returns', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m', [toolUse('bg2', 'Agent', { description: 'Audit sidebar', subagent_type: 'general-purpose' })], undefined);
  t.mainToolResults([{ type: 'tool_result', tool_use_id: 'bg2', content: [{ type: 'text', text: 'Async agent launched successfully. agentId: a1' }] }]);
  t.taskStarted({ task_id: 'tb2', tool_use_id: 'bg2', description: 'Audit sidebar', subagent_type: 'general-purpose' });
  t.endTurn(false);
  assert.equal(t.snapshot().agents[1].status, 'running');
  assert.equal(t.helpersWorking(), 1);
  t.taskEnded({ task_id: 'tb2', status: 'completed', summary: 'done' });
  assert.equal(t.helpersWorking(), 0);
});

test('a helper moved to the background mid-run is still running when its Agent call returns', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m', [toolUse('fg', 'Agent', { description: 'Plan the refactor', subagent_type: 'Plan' })], undefined);
  t.taskStarted({ task_id: 'tf', tool_use_id: 'fg', description: 'Plan the refactor', subagent_type: 'Plan', is_backgrounded: false });
  t.mainToolResults([{ type: 'tool_result', tool_use_id: 'fg', content: 'The agent is now running in the background. You will be notified when it finishes.' }]);
  t.endTurn(false);
  assert.equal(t.helpersWorking(), 1, 'not "0 running" while it works');
});

test('the live task list reopens a helper wrongly ended, and ends one that crashed without reporting', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m', [toolUse('a1', 'Agent', { description: 'Plan' }), toolUse('a2', 'Agent', { description: 'Scan' }), toolUse('a3', 'Agent', { description: 'Fix' })], undefined);
  t.taskStarted({ task_id: 't1', tool_use_id: 'a1', description: 'Plan' });
  t.taskStarted({ task_id: 't2', tool_use_id: 'a2', description: 'Scan', is_backgrounded: true });
  t.taskStarted({ task_id: 't3', tool_use_id: 'a3', description: 'Fix' });
  t.mainToolResults([{ type: 'tool_result', tool_use_id: 'a1', content: 'some text we did not recognise' }]);
  t.taskEnded({ task_id: 't3', status: 'completed', summary: 'fixed' });
  const now = Date.now();
  t.liveTasks(['t1', 't2', 't3'], now);
  const status = () => t.snapshot().agents.slice(1).map((a) => a.status);
  assert.deepEqual(status(), ['running', 'running', 'done'], 'still live, so running; ended by its own event, so done');

  t.liveTasks(['t1'], now);
  assert.deepEqual(t.supervise(now + 30_000, 600_000, 60_000, 600_000).lost, [], 'gone briefly is not lost');
  const { lost } = t.supervise(now + 61_000, 600_000, 60_000, 600_000);
  assert.deepEqual(lost.map((a) => a.id), ['a2']);
  assert.deepEqual(status(), ['running', 'failed', 'done']);
  assert.match(t.snapshot().agents[2].summary!, /without reporting back/);
});

test('the supervisor reports a silent helper once, again only after it worked and went silent again', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m', [toolUse('s1', 'Agent', { description: 'Slow' })], undefined);
  t.taskStarted({ task_id: 'ts', tool_use_id: 's1', description: 'Slow' });
  const later = Date.now() + 400_000;
  assert.deepEqual(t.supervise(later, 90_000, 60_000, 300_000).stuck.map((a) => a.id), ['s1']);
  assert.equal(t.snapshot().agents[1].status, 'warning', 'the pill warns');
  assert.deepEqual(t.supervise(later, 90_000, 60_000, 300_000).stuck, [], 'said once');
  t.taskProgress({ task_id: 'ts', usage: { total_tokens: 5, tool_uses: 1 } });
  assert.deepEqual(t.supervise(Date.now() + 400_000, 90_000, 60_000, 300_000).stuck.map((a) => a.id), ['s1']);
});

test('helpers die with their process: they show as stopped, the main agent is untouched', () => {
  const t = tracker();
  t.startTurn('claude-opus-5-5');
  t.mainMessage('m', [toolUse('h1', 'Agent', { description: 'Fix x', subagent_type: 'quick-helper' }), toolUse('h2', 'Agent', { description: 'Fix y' })], undefined);
  t.mainToolResults([{ type: 'tool_result', tool_use_id: 'h2', content: 'fixed' }]);
  t.stopHelpers();
  assert.deepEqual(t.snapshot().agents.map((a) => a.status), ['running', 'stopped', 'done']);
  assert.equal(t.helpersWorking(), 0);
});

test('the main agent\'s time is this reply\'s', () => {
  const t = tracker();
  t.startTurn();
  const first = t.snapshot().agents[0].startedAt;
  t.endTurn(false);
  assert.ok(t.snapshot().agents[0].endedAt! >= first);
  t.startTurn();
  assert.equal(t.snapshot().agents[0].endedAt, undefined);
});

test('a reopened chat shows its agents as finished, never still running', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m', [toolUse('c', 'Agent', { description: 'x' })], undefined);
  const saved = t.snapshot();
  const reopened = tracker();
  reopened.load(saved);
  const snap = reopened.snapshot();
  assert.equal(snap.agents[0].status, 'idle');
  assert.equal(snap.agents[1].status, 'stopped');
  reopened.reset();
  assert.equal(reopened.snapshot().agents.length, 1);
});

test('housekeeping tasks are not shown as agents', () => {
  const t = tracker();
  t.taskStarted({ task_id: 'bg', description: 'watch files', task_type: 'monitor', ambient: true });
  t.taskStarted({ task_id: 'sh', description: 'npm test', task_type: 'local_bash' });
  assert.equal(t.snapshot().agents.length, 1);
});

test('a helper keeps the name the main agent gave it, and a message to that name resumes it', () => {
  const t = tracker();
  t.startTurn('deepseek-v4-pro');
  t.mainMessage('m1', [toolUse('n1', 'Agent', { description: 'Bridge the CRM', subagent_type: 'general-purpose', name: 'crm-bridge' }), toolUse('n2', 'Agent', { description: 'Look around', subagent_type: 'Explore' })], undefined);
  t.mainMessage('m2', [toolUse('n3', 'SendMessage', { to: 'crm-bridge', summary: 'Add retries', message: 'Please add retries' })], undefined);
  t.subMessage('n3', 's1', [toolUse('r1', 'Read', { file_path: '/crm.ts' })], undefined);
  t.subMessage('n2', 's2', [toolUse('nested', 'Agent', { description: 'Deeper', subagent_type: 'quick-helper' })], undefined);
  const byId = Object.fromEntries(t.snapshot().agents.map((a) => [a.id, a]));
  assert.equal(byId.n1.label, 'crm-bridge');
  assert.equal(byId.n2.label, undefined, 'unnamed helpers are known by their type');
  assert.equal(byId.n3.label, 'crm-bridge', 'the resumed run belongs to the same agent');
  assert.equal(byId.n3.description, 'Add retries');
  assert.equal(byId.nested.depth, 2);
  assert.equal(byId.nested.model, 'deepseek-flash');
});

test('each helper keeps its own to-do list; the main agent\'s stays the plan', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m1', [toolUse('c1', 'Agent', { description: 'Refactor', subagent_type: 'deep-thinker' })], undefined);
  t.subMessage('c1', 's1', [toolUse('td', 'TodoWrite', { todos: [{ content: 'Split file', status: 'in_progress', activeForm: 'Splitting file' }, { content: 'Run tests', status: 'pending', activeForm: 'Running tests' }] })], undefined);
  const snap = t.snapshot();
  assert.deepEqual(snap.plan, []);
  assert.deepEqual(snap.agents[1].todos!.map((x) => [x.content, x.status]), [['Split file', 'in_progress'], ['Run tests', 'pending']]);
});

test('an agent waiting on the user shows as blocked until answered', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m1', [toolUse('c1', 'Agent', { description: 'Edit', subagent_type: 'quick-helper' })], undefined);
  t.taskStarted({ task_id: 'tk', tool_use_id: 'c1', description: 'Edit', subagent_type: 'quick-helper' });
  t.subMessage('c1', 's1', [toolUse('w1', 'Write', { file_path: '/a.ts' })], undefined);
  t.setBlocked('w1', true);
  let snap = t.snapshot();
  assert.deepEqual(snap.agents.map((a) => a.status), ['running', 'blocked'], 'the permission is for the helper\'s own tool call');
  t.setBlocked(undefined, true);
  assert.equal(t.snapshot().agents[0].status, 'blocked', 'no tool call id means the main agent');
  t.setBlocked('w1', false);
  t.setBlocked(undefined, false);
  snap = t.snapshot();
  assert.deepEqual(snap.agents.map((a) => a.status), ['running', 'running']);
  t.setBlocked('tk', true);
  assert.equal(t.snapshot().agents[1].status, 'blocked', 'a task id works too');
});

test('a silent agent is flagged stalled, and any activity clears it; blocked agents are not stalled', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m1', [toolUse('c1', 'Agent', { description: 'Slow', subagent_type: 'quick-helper' })], undefined);
  t.taskStarted({ task_id: 'tk', tool_use_id: 'c1', description: 'Slow', subagent_type: 'quick-helper' });
  t.setBlocked(undefined, true);
  const later = Date.now() + 120_000;
  assert.equal(t.markStalled(later, 60_000), true);
  assert.deepEqual(t.snapshot().agents.map((a) => a.status), ['blocked', 'warning']);
  assert.equal(t.snapshot().agents[1].stalled, true);
  assert.equal(t.markStalled(later, 60_000), false, 'nothing new to flag');
  t.taskProgress({ task_id: 'tk', usage: { total_tokens: 10, tool_uses: 1 } });
  assert.equal(t.snapshot().agents[1].status, 'running');
  assert.equal(t.markStalled(Date.now(), 60_000), false, 'recent activity is not a stall');
});

test('a failed tool call warns on the agent that made it, until one succeeds', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('m1', [toolUse('b1', 'Bash', { command: 'npm test' }), toolUse('c1', 'Agent', { description: 'x', subagent_type: 'quick-helper' })], undefined);
  t.subMessage('c1', 's1', [toolUse('r1', 'Read', { file_path: '/nope' })], undefined);
  t.subToolResults('c1', [{ type: 'tool_result', tool_use_id: 'r1', is_error: true }]);
  t.mainToolResults([{ type: 'tool_result', tool_use_id: 'b1', is_error: true }]);
  let [main, sub] = t.snapshot().agents;
  assert.deepEqual([main.status, main.failedTool, sub.status, sub.failedTool], ['warning', 'Bash', 'warning', 'Read']);
  t.subMessage('c1', 's2', [toolUse('r2', 'Read', { file_path: '/yes' })], undefined);
  t.subToolResults('c1', [{ type: 'tool_result', tool_use_id: 'r2' }]);
  [main, sub] = t.snapshot().agents;
  assert.equal(sub.status, 'running');
  assert.equal(main.status, 'warning');
});

test('old saved snapshots load, and nothing restored is running, blocked or flagged', () => {
  const old = {
    tokens: 10,
    plan: [{ content: 'Fix', status: 'in_progress' as const }],
    agents: [
      { id: 'main', name: 'Main agent', description: '', status: 'running' as const, startedAt: 1, tokens: 5, toolUses: 0, steps: [], earlierSteps: 0, depth: 0 },
      { id: 'c1', name: 'quick-helper', description: 'x', status: 'blocked' as const, startedAt: 1, tokens: 5, toolUses: 0, steps: [], earlierSteps: 0, depth: 1, blocked: true },
      { id: 'c2', name: 'deep-thinker', description: 'y', status: 'done' as const, startedAt: 1, tokens: 0, toolUses: 0, steps: [], earlierSteps: 0, depth: 1 },
    ],
  };
  const t = tracker();
  t.load(old);
  const snap = t.snapshot();
  assert.deepEqual(snap.agents.map((a) => a.status), ['idle', 'stopped', 'done']);
  assert.equal(snap.agents[1].blocked, undefined);
  assert.equal(snap.plan[0].content, 'Fix');
});

test('only the newest finished helper runs are kept; running ones stay and the token total is unchanged', () => {
  const t = tracker();
  t.startTurn();
  t.mainMessage('long', [toolUse('keep', 'Agent', { description: 'Long job' })], undefined);
  for (let i = 0; i < 40; i++) {
    t.mainMessage(`m${i}`, [toolUse(`c${i}`, 'Agent', { description: `Job ${i}` })], undefined);
    t.subMessage(`c${i}`, `s${i}`, [], { input_tokens: 10, output_tokens: 0 });
    t.mainToolResults([{ type: 'tool_result', tool_use_id: `c${i}` }]);
  }
  const snap = t.snapshot();
  const subs = snap.agents.slice(1);
  assert.equal(subs.length, 31, 'the running helper plus 30 finished runs');
  assert.ok(subs.some((a) => a.id === 'keep' && a.status === 'running'));
  assert.ok(!subs.some((a) => a.id === 'c0'), 'the oldest finished runs went');
  assert.ok(subs.some((a) => a.id === 'c39'));
  assert.equal(snap.tokens, 400, 'dropped runs still count');
  const reopened = tracker();
  reopened.load(snap);
  assert.equal(reopened.snapshot().tokens, 400, 'a reopened chat keeps the total');
});

test('a card whose request was already cancelled settles at once', async () => {
  const posted: any[] = [];
  const cards = new Interactions((m) => posted.push(m), () => undefined, () => [], () => undefined);
  const abort = new AbortController();
  abort.abort();
  const result = await cards.ask('Bash', { command: 'ls' }, { signal: abort.signal });
  assert.equal(result.behavior, 'deny');
  assert.ok(posted.some((m) => m.type === 'permissionResolved'), 'the card is closed');
});

test('a helper refused before it started (no task, no work) is dropped, not shown as failed', () => {
  const t = new AgentTracker(() => '', () => undefined);
  t.startTurn('deepseek-flash');
  t.mainMessage('m1', [{ type: 'tool_use', id: 'call1', name: 'Agent', input: { description: 'Count', subagent_type: 'quick-helper', prompt: 'x' } }], undefined);
  t.mainToolResults([{ type: 'tool_result', tool_use_id: 'call1', is_error: true, content: 'PreToolUse:Agent hook error: Every helper brief needs a scope' }]);
  assert.equal(t.snapshot().agents.filter((a) => a.id === 'call1').length, 0);
});

test('helpers start with the project brief; searchers, which only locate code, do not', async () => {
  const start = (agent_type: string) => helperStart({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type, session_id: 's', transcript_path: '', cwd: '/' } as any, 'BRIEF');
  assert.deepEqual(start('general-purpose'), { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'BRIEF' } });
  assert.deepEqual(start('searcher'), {});
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  const setup: any = { provider: 'claude', cwd: '/repo', hasHelpers: true, sources: {}, onEdit: async () => ({}), onTool: () => undefined, onPreTool: () => ({}), reuse: { server: () => ({}) }, onCompact: () => undefined, afterCompact: () => undefined, focus: () => ({ files: [], words: [] }), onStop: async () => ({}) };
  assert.equal(agentOptions(sdk, setup).hooks?.SubagentStart, undefined, 'no memory, no hook');
  assert.equal(agentOptions(sdk, { ...setup, helperBrief: 'BRIEF' }).hooks?.SubagentStart?.length, 1);
});

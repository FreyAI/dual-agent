import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { claudeQuotaOk, classifyPrompt, currentStint, earlyEscalation, helperRoster, label, ModelChoice, nameDeepSeekModels, route, RouterInput, startsTask } from '../../agent/router';

const NOW = 1_900_000_000_000;
const FLASH: ModelChoice = { provider: 'deepseek', effort: 'flash' };
const PRO: ModelChoice = { provider: 'deepseek', effort: 'thinking' };
const CLAUDE: ModelChoice = { provider: 'claude', effort: 'thinking' };
const calm = { failedChecks: 0, toolErrors: 0, editFailures: 0, turnsOnTask: 1 };

const input = (over: Partial<RouterInput>): RouterInput => ({
  mode: 'auto',
  autoPrimary: 'deepseek',
  configured: { claude: true, deepseek: true },
  blockedUntil: { claude: 0, deepseek: 0 },
  preferred: { claude: 'thinking', deepseek: 'flash' },
  prompt: 'add a parameter to the parser',
  signals: calm,
  contextTokens: 50_000,
  idleMs: 1000,
  now: NOW,
  ...over,
});

const pick = (over: Partial<RouterInput>) => {
  const d = route(input(over));
  return { provider: d.provider, effort: d.effort };
};

test('fixed modes use the preferred effort and never auto-switch', () => {
  assert.deepEqual(pick({ mode: 'claude' }), CLAUDE);
  assert.deepEqual(pick({ mode: 'deepseek', prompt: 'debug this race condition', signals: { ...calm, failedChecks: 5 } }), FLASH);
  assert.deepEqual(pick({ mode: 'deepseek', current: FLASH, preferred: { claude: 'flash', deepseek: 'thinking' } }), PRO, 'a setting change applies at once');
});

test('a provider picked by hand stays even when blocked or not set up', () => {
  assert.deepEqual(pick({ mode: 'claude', blockedUntil: { claude: NOW + 1, deepseek: 0 } }), CLAUDE);
  assert.deepEqual(pick({ mode: 'deepseek', configured: { claude: true, deepseek: false } }), FLASH);
});

test('auto picks by the task: Flash for mechanical, V4 Pro for coding, Claude for hard work when Claude is primary', () => {
  assert.deepEqual(pick({ prompt: 'rename getUser to fetchUser' }), FLASH);
  assert.deepEqual(pick({ prompt: 'add a retry option to the HTTP client' }), PRO);
  assert.deepEqual(pick({ prompt: 'design the architecture for the CRM integration' }), PRO, 'DeepSeek primary: hard work on V4 Pro');
  assert.deepEqual(pick({ autoPrimary: 'claude', prompt: 'design the architecture for the CRM integration' }), CLAUDE);
  assert.deepEqual(pick({ autoPrimary: 'claude', prompt: 'audit the code bases and tell me how you would integrate the CRM' }), PRO, 'everyday words don\'t pick Claude');
  assert.deepEqual(pick({ autoPrimary: 'claude', prompt: 'add a retry option to the HTTP client' }), PRO, 'Claude primary still uses DeepSeek for normal coding');
  const low = route(input({ autoPrimary: 'claude', prompt: 'design the plugin architecture', quota: { status: 'allowed_warning' } }));
  assert.deepEqual({ provider: low.provider, effort: low.effort }, PRO);
  assert.equal(low.reason, 'V4 Pro: hard task (Claude quota low)');
  const off = route(input({ autoPrimary: 'claude', prompt: 'add a flag', quota: { status: 'rejected' }, current: CLAUDE }));
  assert.deepEqual({ provider: off.provider, effort: off.effort, switching: off.switching }, { ...PRO, switching: true }, 'leaves Claude even with a warm cache');
});

test('Claude off: hard work and trouble stay on V4 Pro, and the reason says Claude is off', () => {
  const off = { configured: { claude: false, deepseek: true }, claudeOff: true };
  assert.deepEqual(pick({ ...off, prompt: 'design the plugin architecture' }), PRO);
  assert.deepEqual(pick({ ...off, current: PRO, signals: { ...calm, failedChecks: 3 } }), PRO);
  const left = route(input({ ...off, current: CLAUDE, prompt: 'add a flag' }));
  assert.deepEqual({ provider: left.provider, effort: left.effort }, PRO);
  assert.match(left.reason, /Claude is off/);
});

test('a follow-up like "yes, go ahead" continues on the current model', () => {
  assert.deepEqual(pick({ current: CLAUDE, prompt: 'yes go ahead' }), CLAUDE);
  assert.deepEqual(pick({ current: PRO, prompt: 'continue' }), PRO);
  assert.deepEqual(pick({ current: CLAUDE, prompt: 'ok', quota: { status: 'rejected' } }), PRO, 'unless Claude has to stop');
});

test('Claude pacing: usage may run 10 points ahead of the elapsed window', () => {
  const hour = 3_600_000;
  const window = { windowStart: NOW - 2 * hour, resetsAt: NOW + 2 * hour };
  assert.equal(claudeQuotaOk({ ...window, utilization: 0.55 }, NOW), true);
  assert.equal(claudeQuotaOk({ ...window, utilization: 0.65 }, NOW), false);
  assert.equal(claudeQuotaOk({ windowStart: (NOW - 2 * hour) / 1000, resetsAt: (NOW + 2 * hour) / 1000, utilization: 0.55 }, NOW), true, 'epoch seconds');
  assert.equal(claudeQuotaOk({ utilization: 0.79 }, NOW), true);
  assert.equal(claudeQuotaOk({ utilization: 0.8 }, NOW), false);
  assert.equal(claudeQuotaOk(undefined, NOW), true);
  assert.equal(claudeQuotaOk({ status: 'rejected', resetsAt: NOW - 1 }, NOW), true, 'stale after the reset');
  assert.deepEqual(pick({ autoPrimary: 'claude', prompt: 'design the plugin architecture', quota: { ...window, utilization: 0.9 } }), PRO);
});

test('trouble escalates Flash to V4 Pro to Claude, at once even with a warm cache', () => {
  const failed = { ...calm, failedChecks: 2 };
  const first = route(input({ current: FLASH, signals: failed, prompt: 'rename it' }));
  assert.deepEqual({ provider: first.provider, effort: first.effort, switching: first.switching }, { ...PRO, switching: true });
  assert.equal(first.reason, 'escalated to V4 Pro: checks failed 2 times');
  assert.deepEqual(pick({ current: PRO, signals: { ...calm, toolErrors: 3 } }), CLAUDE);
  assert.deepEqual(pick({ current: PRO, signals: { ...calm, editFailures: 2 } }), CLAUDE);
  assert.deepEqual(pick({ current: PRO, signals: { ...calm, turnsOnTask: 6 } }), CLAUDE);
  assert.deepEqual(pick({ current: PRO, signals: failed, quota: { status: 'rejected' } }), PRO, 'Claude quota low: stay');
  assert.deepEqual(pick({ current: PRO, signals: failed, blockedUntil: { claude: NOW + 1, deepseek: 0 } }), PRO);
  assert.deepEqual(pick({ current: CLAUDE, signals: failed }), CLAUDE, 'already at the top');
});

test('one main model per task: no step down within it, and wording alone never steps up', () => {
  const warm = route(input({ current: PRO, prompt: 'rename foo to bar' }));
  assert.deepEqual({ provider: warm.provider, effort: warm.effort, switching: warm.switching }, { ...PRO, switching: false });
  assert.equal(warm.reason, 'V4 Pro: same task');
  const breakMs = 3 * 60_000;
  assert.deepEqual(pick({ current: PRO, prompt: 'show me the parser', idleMs: breakMs }), PRO, '"show me X" after a short break stays');
  assert.deepEqual(pick({ current: CLAUDE, autoPrimary: 'claude', prompt: 'fix the typo in the README', idleMs: breakMs }), CLAUDE);
  assert.deepEqual(pick({ current: FLASH, prompt: 'add a retry option to the HTTP client' }), FLASH, 'up only on evidence');
  assert.deepEqual(pick({ current: FLASH, prompt: 'design the plugin architecture', idleMs: breakMs }), FLASH);
});

test('a new task (idle past the cache, or a small context, and no pointing back) is routed afresh', () => {
  const later = 6 * 60_000;
  assert.deepEqual(pick({ current: PRO, prompt: 'rename foo to bar', idleMs: later }), FLASH);
  assert.deepEqual(pick({ current: PRO, prompt: 'rename foo to bar', contextTokens: 5000 }), FLASH);
  assert.deepEqual(pick({ current: FLASH, prompt: 'add a retry option to the HTTP client', idleMs: later }), PRO);
  assert.deepEqual(pick({ current: PRO, prompt: 'rename it to bar', idleMs: later }), PRO, 'points back: same task');
  assert.deepEqual(pick({ current: PRO, prompt: 'yes, go ahead', idleMs: later }), PRO);
  assert.equal(startsTask({ prompt: 'show me the parser', idleMs: 0, contextTokens: 90_000 }), true, 'nothing running yet');
  assert.equal(startsTask({ current: PRO, prompt: 'show me the parser', idleMs: later, contextTokens: 90_000 }), true);
  assert.equal(startsTask({ current: PRO, prompt: 'show me the parser', idleMs: 1000, contextTokens: 90_000 }), false);
  assert.equal(startsTask({ current: PRO, prompt: 'now do the same for the lexer', idleMs: later, contextTokens: 90_000 }), false);
});

test('early escalation: plain failures any time, the first steps\' evidence, and a 40-step backstop', () => {
  const quiet = { toolErrors: 0, editFailures: 0, failedChecks: 0, modelCalls: 10, reads: 3, searches: 2, repeatedSearches: 0 };
  const esc = (over: Partial<typeof quiet>, cur = FLASH) => earlyEscalation({ ...quiet, ...over }, cur);
  assert.equal(esc({}), undefined);
  assert.equal(esc({ failedChecks: 2, toolErrors: 2 }), 'checks failed 2 times');
  assert.equal(esc({ editFailures: 2, toolErrors: 2 }), '2 failed edits');
  assert.equal(esc({ toolErrors: 4, modelCalls: 30 }), '4 tool errors');
  assert.equal(esc({ modelCalls: 40 }), '40 steps without finishing');
  assert.equal(esc({ modelCalls: 3, toolErrors: 2, failedChecks: 1 }), '2 tool errors in the first 3 steps');
  assert.equal(esc({ modelCalls: 3, toolErrors: 2 }), '2 tool errors in the first 3 steps', 'most steps failing');
  assert.equal(esc({ modelCalls: 3, repeatedSearches: 2 }), '2 repeated searches in the first 3 steps');
  assert.equal(esc({ modelCalls: 4, reads: 0, searches: 4 }), 'no file read after 4 searches');
  assert.equal(esc({ modelCalls: 3, failedChecks: 1, toolErrors: 2 }, PRO), '2 tool errors in the first 3 steps', 'V4 Pro escalates too');
  assert.equal(esc({ modelCalls: 3, failedChecks: 2, toolErrors: 2 }, CLAUDE), undefined, 'nothing above Claude');
});

test('early escalation waits for evidence and never fires on a clean run', () => {
  const quiet = { toolErrors: 0, editFailures: 0, failedChecks: 0, modelCalls: 1 };
  assert.equal(earlyEscalation({ ...quiet, modelCalls: 2, toolErrors: 2, failedChecks: 1 }, FLASH), undefined, 'too early to judge');
  for (let calls = 1; calls < 40; calls++) {
    assert.equal(earlyEscalation({ ...quiet, modelCalls: calls, reads: calls, searches: calls, toolErrors: 1 }, FLASH), undefined);
  }
  assert.equal(earlyEscalation({ ...quiet, modelCalls: 20, toolErrors: 3, failedChecks: 1 }, FLASH), undefined, 'past the first steps, only plain failures count');
  assert.equal(earlyEscalation({ ...quiet, modelCalls: 3, searches: 4 }, FLASH), 'no file read after 4 searches', 'reads unknown counts as none');
  assert.equal(earlyEscalation({ ...quiet, modelCalls: 40 }, { provider: 'deepseek', effort: 'flash' }), '40 steps without finishing');
});

test('auto with DeepSeek unavailable uses Claude, else the primary', () => {
  assert.deepEqual(pick({ blockedUntil: { claude: 0, deepseek: NOW + 1 } }), CLAUDE);
  assert.deepEqual(pick({ configured: { claude: true, deepseek: false }, quota: { status: 'rejected' } }), CLAUDE, 'low quota beats nothing');
  assert.deepEqual(pick({ configured: { claude: false, deepseek: false } }), FLASH, 'nothing usable: the primary at its preferred effort');
});

test('classifyPrompt', () => {
  assert.equal(classifyPrompt('rename getUser to fetchUser'), 'mechanical');
  assert.equal(classifyPrompt('fix the typo in the README'), 'mechanical');
  for (const p of ['show me the comments in parser.ts', 'list the open ports', 'read config.ts', 'find where users are saved', 'print the version']) {
    assert.equal(classifyPrompt(p), 'normal', p);
  }
  for (const p of ['why does this test fail only on CI?', 'debug the login', 'audit the code bases and tell me how you would integrate those', 'investigate the performance']) {
    assert.equal(classifyPrompt(p), 'normal', p);
  }
  assert.equal(classifyPrompt('add a retry option to the HTTP client'), 'normal');
  assert.equal(classifyPrompt('design the architecture for plugin loading'), 'hard');
  assert.equal(classifyPrompt('rename the queue fields and fix the race condition'), 'hard', 'hard words win');
  assert.equal(classifyPrompt('review the security of the auth flow'), 'hard');
  assert.equal(classifyPrompt('the test is flaky on CI'), 'hard');
  assert.equal(classifyPrompt(`rename ${'x'.repeat(400)}`), 'normal', 'too long to be mechanical');
});

const M = 1_000_000;
/** 70/30 over a 10M usual day: Claude stints of 3.5M, DeepSeek stints of 1.5M. */
const split = (claudeTokens: number, deepseekTokens: number, claudeTarget = 0.7) => ({ claudeTarget, claudeTokens, deepseekTokens, dayTokens: 10 * M });

test('a split takes turns in stints of half each side\'s share of a usual day, the bigger share first', () => {
  assert.deepEqual(currentStint(split(0, 0)), { provider: 'claude', used: 0, size: 3.5 * M });
  assert.equal(currentStint(split(3.4 * M, 0)).provider, 'claude');
  assert.deepEqual(currentStint(split(3.5 * M, 0)), { provider: 'deepseek', used: 0, size: 1.5 * M }, 'Claude used 35%: DeepSeek\'s turn');
  assert.equal(currentStint(split(3.5 * M, 1.4 * M)).provider, 'deepseek');
  const back = currentStint(split(3.6 * M, 1.5 * M));
  assert.equal(back.provider, 'claude', 'DeepSeek used 15%: back to Claude');
  assert.ok(Math.abs(back.used - 0.1 * M) < 1, 'overshoot counts toward the next stint');
  assert.equal(currentStint(split(0, 0, 0.3)).provider, 'deepseek');
  assert.deepEqual(currentStint(split(5 * M, 0, 1)), { provider: 'claude', used: 5 * M, size: 0 }, 'one side only: no rotation');
});

test('every task goes to whoever\'s stint it is, except quick edits, which take Flash in either stint', () => {
  assert.deepEqual(pick({ split: split(M, 0) }), CLAUDE);
  assert.deepEqual(pick({ split: split(M, 0), prompt: 'fix the typo in the README' }), FLASH, 'Claude\'s stint isn\'t spent on typos');
  assert.deepEqual(pick({ split: split(4 * M, 0) }), PRO);
  assert.deepEqual(pick({ split: split(4 * M, 0), prompt: 'fix the typo in the README' }), FLASH);
  assert.equal(route(input({ split: split(M, 0) })).reason, 'Claude: split 70% Claude, stint 1.0M of 3.5M', 'no repeated label');
  assert.equal(route(input({ split: split(4 * M, 0) })).reason, 'V4 Pro: split 70% Claude, DeepSeek stint 0.0M of 1.5M');
});

test('a stint that ended hands over at the next task, not within one', () => {
  const warm = { current: CLAUDE, contextTokens: 80_000, idleMs: 1000 };
  assert.deepEqual(pick({ ...warm, split: split(4 * M, 0) }), CLAUDE);
  assert.deepEqual(pick({ ...warm, split: split(4 * M, 0), prompt: 'yes, go ahead' }), CLAUDE);
  assert.deepEqual(pick({ ...warm, idleMs: 6 * 60_000, split: split(4 * M, 0) }), PRO);
});

test('under a split, trouble still escalates and Claude backs off when its quota runs low', () => {
  assert.deepEqual(pick({ split: split(4 * M, 0), current: PRO, signals: { ...calm, failedChecks: 3 } }), CLAUDE, 'stuck V4 Pro escalates in DeepSeek\'s stint');
  const low = route(input({ split: split(0, 0), quota: { status: 'allowed_warning' } }));
  assert.deepEqual({ provider: low.provider, effort: low.effort }, PRO);
  assert.equal(low.reason, 'V4 Pro: split 70% Claude, Claude stint 0.0M of 3.5M (Claude quota low)');
  const forced = route(input({ split: split(0, 0), current: CLAUDE, quota: { status: 'rejected' } }));
  assert.equal(forced.reason, 'V4 Pro: same task (Claude quota low)', 'the reason given once');
  assert.deepEqual(pick({ split: split(0, 0), configured: { claude: false, deepseek: true }, claudeOff: true }), PRO, '0% (Claude off) never picks Claude');
});

test('delegated work goes to DeepSeek while it is below its share of the split, whichever provider leads', () => {
  const split = (claude: number, deepseek: number, claudeTarget = 0.5) => ({ claudeTarget, claudeTokens: claude, deepseekTokens: deepseek, dayTokens: 0 });
  const work = (main: 'claude' | 'deepseek', i: Partial<Parameters<typeof helperRoster>[1]> = {}) => helperRoster(main, { deepseekReady: true, claudeReady: true, claudeOk: true, ...i }).work;
  assert.equal(work('claude'), 'deepseek', 'no split: always DeepSeek');
  assert.equal(work('claude', { deepseekReady: false }), 'claude', 'no key or DeepSeek down');
  assert.equal(work('claude', { split: split(0, 0) }), 'deepseek', 'a fresh day');
  assert.equal(work('claude', { split: split(80, 20) }), 'deepseek', 'DeepSeek at 20% of a 50% share');
  assert.equal(work('claude', { split: split(45, 55) }), 'claude', 'ahead of its share: Claude helps');
  assert.equal(work('claude', { split: split(48, 52), current: 'deepseek' }), 'deepseek', 'within the margin it stays, so helpers don\'t flip every turn');
  assert.equal(work('claude', { split: split(48, 52), current: 'claude' }), 'claude');
  assert.equal(work('claude', { split: split(10, 0, 1) }), 'claude', '100% Claude');
  assert.equal(work('claude', { split: split(75, 20, 0.7) }), 'deepseek', '70/30: DeepSeek at 21%');
  assert.equal(work('claude', { split: split(66, 34, 0.7) }), 'claude', '70/30: DeepSeek at 34%');
  assert.equal(work('claude', { split: split(66, 34, 0.7), current: 'deepseek' }), 'deepseek', 'unless already helping, within the margin');
  assert.equal(work('deepseek', { split: split(20, 80) }), 'claude', 'a DeepSeek-led chat ahead of its share hands sub-tasks to Claude\'s smaller models');
  assert.equal(work('deepseek', { split: split(80, 20) }), 'deepseek');
  assert.equal(work('deepseek', { split: split(20, 80), claudeReady: false }), 'deepseek', 'Claude not reachable from this chat');
  assert.equal(work('deepseek', { split: split(20, 80), claudeOk: false }), 'deepseek', 'Claude quota low');
});

test('planning follows the delegated-work provider: DeepSeek plans on V4 Pro, Claude on Opus', () => {
  const split = (claude: number, deepseek: number, claudeTarget = 0.5) => ({ claudeTarget, claudeTokens: claude, deepseekTokens: deepseek, dayTokens: 0 });
  const plan = (main: 'claude' | 'deepseek', i: Partial<Parameters<typeof helperRoster>[1]> = {}) => helperRoster(main, { deepseekReady: true, claudeReady: true, claudeOk: true, ...i }).plan;
  assert.equal(plan('claude'), 'deepseek', 'no split: DeepSeek does the delegated work, so it plans on V4 Pro');
  assert.equal(plan('deepseek'), 'deepseek');
  assert.equal(plan('claude', { split: split(0, 0) }), 'deepseek', 'a fresh day');
  assert.equal(plan('claude', { split: split(45, 55) }), 'claude', 'ahead of its share, Claude plans too');
  assert.equal(plan('claude', { claudeOk: false }), 'deepseek');
  assert.equal(plan('deepseek', { claudeReady: false }), 'deepseek');
  assert.equal(plan('claude', { claudeOk: false, deepseekReady: false }), 'claude', 'nothing else to plan on');
});

test('labels name the DeepSeek models in use', () => {
  assert.equal(label({ provider: 'deepseek', effort: 'thinking' }), 'V4 Pro');
  nameDeepSeekModels({ flash: 'V5 Flash', thinking: 'V5 Pro' });
  assert.equal(label({ provider: 'deepseek', effort: 'thinking' }), 'V5 Pro');
  nameDeepSeekModels({ flash: 'DeepSeek Flash', thinking: 'V4 Pro' });
});

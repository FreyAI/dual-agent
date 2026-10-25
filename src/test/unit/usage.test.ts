import '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatUsage, DEFAULT_DAY_TOKENS, MIN_DAY_TOKENS, usualDay } from '../../agent/chatUsage';
import type { ToWebview } from '../../protocol';
import { CallLog, noteFinalOutput, timeline } from '../../metrics/calls';
import { JsonlLog } from '../../jsonl';
import { deepseekDefault, modelTable, parseModels } from '../../models';
import { TokenCounts, UsageLedger, UsageRow, costOf, isDeepSeekPeak, newUsage, priceFor, repoKey, summarize } from '../../usage';

const mu = (input: number, cacheRead: number, output: number, cacheWrite = 0) => ({ inputTokens: input, cacheReadInputTokens: cacheRead, outputTokens: output, cacheCreationInputTokens: cacheWrite });
const row = (over: Partial<UsageRow>): UsageRow => ({ at: Date.UTC(2026, 9, 17, 12), machine: 'mac', session: 's1', repo: 'r', provider: 'deepseek', model: 'deepseek-flash', billing: 'api', input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...over });

test('DeepSeek peak hours: 01-04 and 06-10 UTC on weekdays only', () => {
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 9, 14, 2)), true, 'Wednesday 02:00 UTC');
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 9, 14, 7, 30)), true);
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 9, 14, 5)), false, 'the gap at 05:00');
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 9, 14, 12)), false);
  assert.equal(isDeepSeekPeak(Date.UTC(2026, 9, 17, 2)), false, 'Saturday');
});

test('prices: each model family, most specific first', () => {
  assert.equal(priceFor('deepseek-flash')!.input, 0.3);
  assert.equal(priceFor('deepseek-v4-pro')!.input, 1.32);
  assert.equal(priceFor('claude-opus-5-5')!.input, 4);
  assert.equal(priceFor('claude-opus-4-8')!.input, 5);
  assert.equal(priceFor('claude-haiku-5-5')!.output, 0.5);
  assert.equal(priceFor('claude-sonnet-4-6')!.input, 3);
  assert.equal(priceFor('claude-sonnet-5-5')!.cacheRead, 0.1, 'Sonnet 5.5 reads at 0.05x');
  assert.equal(priceFor('claude-sonnet-5')!.cacheRead, 0.2);
  assert.equal(priceFor('claude-fable-5-1')!.cacheRead, 0.25, 'Fable 5.1 reads at 0.025x');
  assert.equal(priceFor('claude-fable-5')!.cacheRead, 1);
  assert.equal(priceFor('claude-mythos-5')!.cacheRead, 1);
  assert.equal(priceFor('some-unknown-model'), undefined);
});

test('MODELS.md: id lines with tab-indented attributes; prose is skipped; order kept', () => {
  const md = 'Intro: prose.\n\nnew-model:\n\tmatch: new|other\n\tinput: 2\n\n## Heading\n\tstray: ignored\nplain-id:\n\toutput: 1\n';
  assert.deepEqual(parseModels(md), [
    { id: 'new-model', attrs: { match: 'new|other', input: '2' } },
    { id: 'plain-id', attrs: { output: '1' } },
  ]);
  const ids = modelTable().map((m) => m.id);
  assert.equal(ids[0], 'deepseek-flash', 'most specific first');
  assert.equal(deepseekDefault('flash'), 'deepseek-flash');
  assert.equal(deepseekDefault('thinking'), 'deepseek-v4-pro');
  assert.equal(priceFor('claude-mythos-1')!.output, 50, 'a | in match is one pattern');
  assert.equal(priceFor('deepseek-v5-pro-flash')!.offPeakHalf, true);
  assert.equal(priceFor('claude-opus-5-5')!.offPeakHalf, undefined);
});

test('cost: DeepSeek halves off-peak; Claude cache writes cost extra; subscription writes at the 1-hour rate', () => {
  const tokens = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 };
  const peak = costOf({ model: 'deepseek-v4-pro', at: Date.UTC(2026, 9, 14, 2), billing: 'api', ...tokens });
  const off = costOf({ model: 'deepseek-v4-pro', at: Date.UTC(2026, 9, 14, 12), billing: 'api', ...tokens });
  assert.ok(Math.abs(peak - (1.32 + 0.044 + 3.96)) < 1e-9);
  assert.ok(Math.abs(off - peak / 2) < 1e-9);
  const write = { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 };
  assert.equal(costOf({ model: 'claude-opus-5-5', at: 0, billing: 'api', ...write }), 5);
  assert.equal(costOf({ model: 'claude-opus-5-5', at: 0, billing: 'subscription', ...write }), 8);
});

test('running totals become new usage, turn by turn, without counting anything twice', () => {
  const previous = new Map<string, TokenCounts>();
  const first = newUsage({ 'deepseek-v4-pro': mu(15000, 0, 200), 'deepseek-flash': mu(12000, 11000, 70) }, previous, new Map());
  assert.deepEqual(first.get('deepseek-v4-pro'), { input: 15000, cacheRead: 0, cacheWrite: 0, output: 200 });
  const second = newUsage({ 'deepseek-v4-pro': mu(15300, 14800, 260), 'deepseek-flash': mu(12000, 11000, 70) }, previous, new Map());
  assert.deepEqual(second.get('deepseek-v4-pro'), { input: 300, cacheRead: 14800, cacheWrite: 0, output: 60 });
  assert.equal(second.has('deepseek-flash'), false, 'a helper that did nothing this turn adds nothing');
});

test('a resumed process starts from the saved totals, which were already recorded', () => {
  const recorded = new Map([['deepseek-v4-pro', { input: 15300, cacheRead: 14800, cacheWrite: 0, output: 260 }]]);
  const fresh = newUsage({ 'deepseek-v4-pro': mu(15500, 29700, 300) }, new Map(), recorded);
  assert.deepEqual(fresh.get('deepseek-v4-pro'), { input: 200, cacheRead: 14900, cacheWrite: 0, output: 40 });
});

test('a process that starts from zero (no saved totals) is counted from zero', () => {
  const recorded = new Map([['deepseek-v4-pro', { input: 15300, cacheRead: 14800, cacheWrite: 0, output: 260 }]]);
  const fresh = newUsage({ 'deepseek-v4-pro': mu(400, 15000, 50) }, new Map(), recorded);
  assert.deepEqual(fresh.get('deepseek-v4-pro'), { input: 400, cacheRead: 15000, cacheWrite: 0, output: 50 });
});

test('summary: per-model tokens, share of tokens and cost, cache hit rate, billed vs estimated', () => {
  const s = summarize([
    row({ model: 'deepseek-v4-pro', input: 1000, cacheRead: 9000, output: 500 }),
    row({ model: 'deepseek-flash', input: 2000, cacheRead: 2000, output: 500 }),
    row({ model: 'claude-opus-5-5', provider: 'claude', billing: 'subscription', input: 100, cacheRead: 4900, cacheWrite: 0, output: 0 }),
  ]);
  assert.equal(s.tokens, 20000);
  assert.deepEqual(s.models.map((m) => m.model), ['deepseek-v4-pro', 'claude-opus-5-5', 'deepseek-flash']);
  assert.equal(s.models[0].share, 10500 / 20000);
  assert.equal(s.models[0].hitRate, 0.9);
  assert.ok(Math.abs(s.models.reduce((a, m) => a + m.share, 0) - 1) < 1e-9);
  assert.ok(Math.abs(s.models.reduce((a, m) => a + m.costShare, 0) - 1) < 1e-9);
  assert.equal(s.models[1].notional, true);
  assert.ok(s.billedCost < s.cost, 'subscription usage is estimated, not billed');
  assert.equal(s.hitRate, (9000 + 2000 + 4900) / (1000 + 9000 + 2000 + 2000 + 100 + 4900));
});

test('the ledger keeps one file per machine and adds up every machine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-usage-'));
  const mac = new UsageLedger(dir, 'mac');
  mac.record([row({ input: 100, output: 10 })]);
  const linux = new UsageLedger(dir, 'linux-box');
  linux.record([row({ machine: 'linux-box', session: 's9', input: 50, output: 5 })]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['usage-linux-box.jsonl', 'usage-mac.jsonl']);
  mac.reload();
  const all = mac.summary();
  assert.equal(all.machines, 2);
  assert.equal(all.tokens, 165);
  assert.deepEqual(mac.sessionTotals('s1').get('deepseek-flash'), { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 });
  assert.equal(mac.sessionTotals('s9').size, 0, 'another machine\'s session is not this machine\'s');
  fs.appendFileSync(mac.file, '{"broken":');
  mac.reload();
  assert.equal(mac.summary().requests, 2, 'a half-written line is skipped');
});

test('a repo has the same name on every machine: its git remote', () => {
  const make = (url?: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
    if (url) {
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    }
    return dir;
  };
  assert.equal(repoKey(make('https://github.com/FreyAI/deepseek_vs_plugin.git')), 'github.com/freyai/deepseek_vs_plugin');
  assert.equal(repoKey(make('git@github.com:FreyAI/deepseek_vs_plugin.git')), 'github.com/freyai/deepseek_vs_plugin');
  assert.equal(repoKey(make('https://user@github.com/FreyAI/deepseek_vs_plugin')), 'github.com/freyai/deepseek_vs_plugin');
  const plain = make();
  assert.equal(repoKey(plain), path.basename(plain));
  const cached = make('https://github.com/a/one.git');
  assert.equal(repoKey(cached), 'github.com/a/one');
  fs.writeFileSync(path.join(cached, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/a/two.git\n');
  assert.equal(repoKey(cached), 'github.com/a/one', 'read once per folder per session');
});

test('a resumed process whose carried totals count cache reads differently is not counted twice', () => {
  const recorded = new Map<string, TokenCounts>([['deepseek-flash', { input: 1000, cacheRead: 50000, cacheWrite: 0, output: 300 }]]);
  // More input and output than recorded, fewer cache reads: still a carried-over total.
  const fresh = newUsage({ 'deepseek-flash': mu(1500, 49800, 400) }, new Map(), recorded);
  assert.deepEqual(fresh.get('deepseek-flash'), { input: 500, cacheRead: 0, cacheWrite: 0, output: 100 });
});

test('the chat header counts up with each model call, before the turn\'s result', () => {
  const posted: any[] = [];
  const usage = new ChatUsage((m: ToWebview) => posted.push(m), () => '/repo');
  const call = { session: 's1', provider: 'deepseek' as const, agent: 'Main agent', model: 'deepseek-flash', billing: 'api' as const };
  usage.call('m1', call, { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 });
  const first = posted.at(-1).usage;
  assert.deepEqual(first, { input: 150, output: 10, context: 0, cost: first.cost, estimate: first.cost, fresh: 110, cacheRead: 50, burn: { tokens: 110, cost: first.cost }, showCost: false }, 'new tokens leave out cache reads');
  assert.ok(posted.at(-1).usage.cost > 0, 'API calls add their estimated cost');
  // Subscription calls aren't billed per token, but the estimate counts them, live.
  usage.call('s1m', { ...call, billing: 'subscription' }, { input_tokens: 1000, output_tokens: 0 });
  assert.ok(posted.at(-1).usage.estimate > posted.at(-1).usage.cost);
  // The stream's final output count replaces the partial one on the assistant message.
  usage.callOutput('s1m', 400);
  assert.equal(posted.at(-1).usage.output, 10 + 400);
  usage.callOutput('s1m', 3);
  assert.equal(posted.at(-1).usage.output, 10 + 400, 'never goes down');
  // A call's usage repeats on each content block: the latest wins, not the sum.
  usage.call('m1', call, { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 30 });
  usage.call('m2', { ...call, agent: 'helper' }, { input_tokens: 20, output_tokens: 5 });
  assert.equal(posted.at(-1).usage.input + posted.at(-1).usage.output, 150 + 30 + 1000 + 400 + 20 + 5);
  usage.reset();
  usage.show();
  assert.equal(posted.at(-1).usage.input, 0, 'a new chat starts from zero');
});

test('a call\'s final output count from the proxy reaches the header, whether it comes before or after the message', () => {
  const posted: any[] = [];
  const usage = new ChatUsage((m: ToWebview) => posted.push(m), () => '/repo');
  const call = { session: 's1', provider: 'deepseek' as const, agent: 'general-purpose', model: 'deepseek-flash', billing: 'api' as const };
  noteFinalOutput('early-1', 250);
  usage.call('early-1', call, { input_tokens: 10, output_tokens: 0 });
  assert.equal(posted.at(-1).usage.output, 250, 'noted before the message arrived');
  usage.call('late-1', call, { input_tokens: 10, output_tokens: 0 });
  noteFinalOutput('late-1', 90);
  assert.equal(posted.at(-1).usage.output, 340, 'noted after');
  usage.dispose();
  noteFinalOutput('late-1', 900);
  assert.equal(posted.at(-1).usage.output, 340, 'a closed chat stops listening');
});

test('the header\'s burn rate counts the last 10 minutes\' new tokens only', () => {
  const posted: any[] = [];
  const usage = new ChatUsage((m: ToWebview) => posted.push(m), () => '/repo');
  const call = { session: 's1', provider: 'deepseek' as const, agent: 'Main agent', model: 'deepseek-flash', billing: 'api' as const };
  usage.call('b1', call, { input_tokens: 100, cache_read_input_tokens: 9_000, output_tokens: 10 });
  usage.flushCalls();
  usage.show(Date.now() + 11 * 60_000);
  assert.equal(posted.at(-1).usage.burn.tokens, 0, 'older than 10 minutes');
  usage.show();
  assert.equal(posted.at(-1).usage.burn.tokens, 110, 'saved and live calls are not counted twice; cache reads are not new');
  usage.dispose();
});

test('a usual day is the average of last week\'s days with usage, never below the floor', () => {
  const today = new Date(2026, 9, 18).getTime();
  const on = (daysAgo: number, input: number) => row({ at: today - daysAgo * 86_400_000 + 3_600_000, input });
  assert.equal(usualDay([], today), DEFAULT_DAY_TOKENS, 'no history yet');
  assert.equal(usualDay([on(1, 30e6), on(1, 10e6), on(3, 20e6), on(0, 500e6), on(9, 500e6)], today), 30e6, 'today and older days left out');
  assert.equal(usualDay([on(1, 1e6)], today), MIN_DAY_TOKENS);
});

test('the split counts only this repo\'s tokens today, from every machine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-split-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-repo-'));
  const repo = repoKey(cwd);
  const now = Date.now();
  new UsageLedger(dir, 'linux-box').record([row({ at: now, repo, provider: 'claude', input: 5 }), row({ at: now, repo: 'other', provider: 'claude', input: 99 })]);
  new UsageLedger(dir, 'mac').record([row({ at: now, repo, provider: 'deepseek', output: 3 }), row({ at: now - 2 * 86_400_000, repo, input: 40e6 })]);
  const usage = new ChatUsage(() => undefined, () => cwd, new UsageLedger(dir, 'mac'));
  assert.deepEqual(usage.splitTokens(now), { claude: 5, deepseek: 3, day: 40e6 });
  new UsageLedger(dir, 'linux-box').record([row({ at: now, repo, provider: 'claude', input: 10 })]);
  assert.deepEqual(usage.splitTokens(now + 1000), { claude: 5, deepseek: 3, day: 40e6 }, 'reused for 5 s: one turn asks several times');
  assert.deepEqual(usage.splitTokens(now + 6000), { claude: 15, deepseek: 3, day: 40e6 });
});

test('a call saved mid-turn is not saved again by a later block; only its growth is added, not as another call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-calls-'));
  const log = new CallLog(dir, 'mac');
  const usage = new ChatUsage(() => undefined, () => '/repo', undefined, undefined, undefined, log);
  const call = { session: 's1', provider: 'deepseek' as const, agent: 'Main agent', model: 'deepseek-flash', billing: 'api' as const };
  usage.call('m1', call, { input_tokens: 100, output_tokens: 10 });
  usage.flushCalls();
  // The same blocks again (the M1 duplicate), then a block with more output.
  usage.call('m1', call, { input_tokens: 100, output_tokens: 10 });
  usage.flushCalls();
  usage.call('m1', call, { input_tokens: 100, output_tokens: 25 });
  usage.flushCalls();
  log.reload();
  const rows = log.all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.input, r.output, !!r.delta]), [[100, 10, false], [0, 15, true]]);
  const main = timeline(rows, Date.now()).agents[0];
  assert.deepEqual([main.calls, main.input, main.output], [1, 100, 25]);
});

test('identical call rows already saved twice are read once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-calls-'));
  const r = { at: 5, machine: 'mac', session: 's1', repo: 'r', provider: 'deepseek', agent: 'Main agent', model: 'deepseek-flash', billing: 'api', input: 1, cacheRead: 2, cacheWrite: 0, output: 3 };
  fs.writeFileSync(path.join(dir, 'calls-mac.jsonl'), [r, r, { ...r, at: 6 }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  assert.deepEqual(new CallLog(dir, 'mac').all().map((x) => x.at), [5, 6]);
});

test('an append after a line cut short by a crash starts on a new line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-jsonl-'));
  const log = new JsonlLog<{ n: number }>(dir, 'x', 'mac');
  fs.writeFileSync(log.file, '{"n":1}\n{"n":');
  log.append([{ n: 2 }]);
  log.append([{ n: 3 }]);
  assert.equal(fs.readFileSync(log.file, 'utf8'), '{"n":1}\n{"n":\n{"n":2}\n{"n":3}\n');
  log.reload();
  assert.deepEqual(log.all().map((r) => r.n), [1, 2, 3]);
});

/** Bytes fs.readSync returns while `run` runs. */
function bytesRead(run: () => void): number {
  // The module itself: `import * as` gives a read-only view of it.
  const real = require('fs');
  const original = real.readSync;
  let total = 0;
  real.readSync = (...args: unknown[]) => {
    const n = original(...args);
    total += n;
    return n;
  };
  try {
    run();
  } finally {
    real.readSync = original;
  }
  return total;
}

test('jsonl: a reload reads only the new bytes, sees each new row once, and picks up a new machine\'s file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-jsonl-'));
  const mine = new JsonlLog<{ n: number }>(dir, 'x', 'mac');
  const other = new JsonlLog<{ n: number }>(dir, 'x', 'mac');
  mine.append([{ n: 1 }, { n: 2 }]);
  other.append(Array.from({ length: 500 }, (_, i) => ({ n: 100 + i })));
  assert.equal(mine.all().length, 502);
  other.append([{ n: 3 }]);
  mine.append([{ n: 4 }]);
  assert.deepEqual(mine.all().slice(-2).map((r) => r.n), [3, 4], 'this window\'s append reads back the other window\'s row too');
  other.append([{ n: 5 }]);
  mine.reload();
  const read = bytesRead(() => assert.deepEqual(mine.all().slice(-3).map((r) => r.n), [3, 4, 5]));
  assert.ok(read < 600, `read ${read} bytes, not the whole file`);
  assert.equal(mine.all().length, 505, 'nothing counted twice');
  new JsonlLog<{ n: number }>(dir, 'x', 'linux').append([{ n: 9 }]);
  mine.reload();
  assert.equal(mine.all().at(-1)!.n, 9);
});

test('jsonl: appends make the folder when it is missing and check the file end only on the first', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-jsonl-')), 'new', 'usage');
  const log = new JsonlLog<{ n: number }>(dir, 'x', 'mac');
  log.append([{ n: 1 }]);
  assert.equal(bytesRead(() => log.append([{ n: 2 }])), 0);
  fs.rmSync(dir, { recursive: true });
  log.append([{ n: 3 }]);
  assert.deepEqual(log.all().map((r) => r.n), [3]);
});

test('jsonl: a file pruned by another window is read again; a half-written line is read once it ends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-jsonl-'));
  const log = new JsonlLog<{ at: number }>(dir, 'x', 'mac');
  log.append([{ at: 1 }, { at: 2 }, { at: 3 }]);
  assert.equal(log.all().length, 3);
  await new JsonlLog<{ at: number }>(dir, 'x', 'mac').pruneAsync(3, (r) => r.at);
  log.reload();
  assert.deepEqual(log.all().map((r) => r.at), [3]);
  // Pruned, then grown past where this window had read: the changed start gives it away.
  fs.writeFileSync(log.file, `{"at":7}\n{"at":8}\n{"at":9}\n`);
  log.reload();
  assert.deepEqual(log.all().map((r) => r.at), [7, 8, 9]);
  fs.appendFileSync(log.file, '{"at":1');
  log.reload();
  assert.deepEqual(log.all().map((r) => r.at), [7, 8, 9]);
  fs.appendFileSync(log.file, '0}\n');
  log.reload();
  assert.deepEqual(log.all().map((r) => r.at), [7, 8, 9, 10]);
});

test('jsonl: prune keeps rows from the cutoff on, keeps rows appended while it read, and its rows become the cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-jsonl-'));
  const log = new JsonlLog<{ at: number }>(dir, 'x', 'mac');
  fs.writeFileSync(log.file, [...Array.from({ length: 1000 }, (_, i) => ({ at: i })), { at: Number.NaN }].map((r) => JSON.stringify(r)).join('\n') + '\n{"at":');
  // This window appends after the prune has read the file and before it writes.
  const promises = require('fs').promises;
  const readFile = promises.readFile;
  promises.readFile = async (...args: unknown[]) => {
    const buf = await readFile(...args);
    log.append([{ at: 2000 }]);
    return buf;
  };
  try {
    await log.pruneAsync(990, (r) => r.at);
  } finally {
    promises.readFile = readFile;
  }
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 13);
  assert.deepEqual(lines.flatMap((l) => (l.endsWith('}') ? [JSON.parse(l).at] : [])), [...Array.from({ length: 10 }, (_, i) => 990 + i), null, 2000], 'old rows gone, the appended row kept');
  const read = bytesRead(() => assert.deepEqual(log.all().map((r) => r.at).slice(-3), [999, null, 2000]));
  assert.ok(read < 200, `the pruned rows weren't read again (${read} bytes)`);
  assert.equal(log.all().length, 12);
});

test('cache writes are priced by lifetime when the API says: 1-hour at 2x input, 5-minute at 1.25x', () => {
  const base = { at: Date.now(), model: 'claude-opus-5-5', input: 0, cacheRead: 0, output: 0 };
  assert.equal(costOf({ ...base, billing: 'api', cacheWrite: 1e6, cacheWrite1h: 1e6 }), 8, 'an API-key main agent on the 1-hour cache');
  assert.equal(costOf({ ...base, billing: 'subscription', cacheWrite: 1e6, cacheWrite1h: 0 }), 5, 'a subscription helper on the 5-minute cache');
  assert.equal(costOf({ ...base, billing: 'subscription', cacheWrite: 1e6 }), 8, 'old rows keep the old guess');
  assert.equal(costOf({ ...base, billing: 'api', cacheWrite: 1e6 }), 5);
  assert.equal(costOf({ ...base, model: 'deepseek-flash', billing: 'api', cacheWrite: 1e6, cacheWrite1h: 1e6 }), 0, 'DeepSeek writes are free');
  const usage = new ChatUsage(() => undefined, () => '/repo');
  const call = { session: 's1', provider: 'claude' as const, agent: 'Main agent', model: 'claude-opus-5-5', billing: 'api' as const };
  usage.call('o1', call, { input_tokens: 1, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } });
  usage.call('o2', { ...call, agent: 'helper' }, { input_tokens: 1, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 3000 } });
  const { cost } = usage.record({ type: 'result', subtype: 'success', session_id: 's1', modelUsage: { 'claude-opus-5-5': { inputTokens: 2, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 4000 } } } as any, 'claude', false);
  assert.ok(Math.abs(cost - (2 * 4 + 1000 * 8 + 3000 * 5) / 1e6) < 1e-9, `the result's total is split as its calls were: ${cost}`);
  usage.dispose();
});

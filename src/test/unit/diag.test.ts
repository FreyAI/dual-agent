import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { redactSecrets } from '../../text';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiagRow, diag, formatDiag, pruneDiag, recentDiag, resetDiag, savedDiag, setDiagSink, swallowed } from '../../diag/log';
import { diagnose, diagnosisOf, resetDiagnoses, resolved } from '../../diag/rules';
import { diagnosePrompt, failuresReport, gateReport } from '../../diag/report';

beforeEach(() => {
  setDiagSink({ machine: 'test', out: () => undefined });
  resetDiag();
  resetDiagnoses();
});

const row = (r: Partial<DiagRow>): DiagRow => ({ at: Date.now(), machine: 'm', kind: 'api_retry', ...r });

test('diag: a row goes to the output channel and the file, with the cause and no long detail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const lines: string[] = [];
  setDiagSink({ dir, machine: 'mac', out: (l) => lines.push(l) });
  diag({ kind: 'api_retry', provider: 'claude', model: 'opus', agent: 'main', code: 'server_error', status: 529, detail: 'x'.repeat(1000) });
  assert.match(lines[0], /^\[api_retry\] claude\/opus main server_error 529: x+…$/);
  assert.ok(lines[0].length < 400);
  const saved = fs.readFileSync(path.join(dir, 'diag-mac.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(saved[0].status, 529);
  assert.equal(savedDiag().length, 1);
  assert.equal(formatDiag({ kind: 'swallowed', target: 'Sending', detail: 'boom' }), '[swallowed] Sending failed: boom');
});

test('diag: a failing sink never throws, and old rows are pruned', () => {
  setDiagSink({ dir: '/dev/null/nope', machine: 'm', out: () => { throw new Error('closed'); } });
  assert.doesNotThrow(() => swallowed('x', new Error('y')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const old = Date.now() - 100 * 86_400_000;
  fs.writeFileSync(path.join(dir, 'diag-m.jsonl'), `{"at":${old},"machine":"m","kind":"proxy"}\n{"at":${Date.now()},"machine":"m","kind":"proxy"}\n`);
  setDiagSink({ dir, machine: 'm', out: () => undefined });
  pruneDiag();
  assert.equal(fs.readFileSync(path.join(dir, 'diag-m.jsonl'), 'utf8').trim().split('\n').length, 1, 'past the default 90 days');
  pruneDiag(1, Date.now() + 2 * 86_400_000);
  assert.equal(fs.readFileSync(path.join(dir, 'diag-m.jsonl'), 'utf8').trim(), '', 'a shorter retention drops the rest');
});

test('rules: an outage seen by two chats is diagnosed (D2); one chat alone is just a retry', () => {
  const a = row({ session: 'a', provider: 'claude', code: 'server_error' });
  assert.equal(diagnose(a, [a]), undefined);
  const b = row({ session: 'b', provider: 'claude', code: 'overloaded' });
  assert.equal(diagnose(b, [a, b])?.rule, 'D2');
  assert.equal(diagnose(row({ provider: 'claude', status: 422, code: 'unknown' }), [])?.rule, 'D3');
  assert.equal(diagnose(row({ kind: 'failover', code: 'unknown' }), [])?.rule, 'D8');
});

test('rules: the same refusal twice is D1; repeated shell reads are D7; web timeouts D4; bad tool input D5', () => {
  const r = row({ kind: 'refusal', agent: 'h1', code: 'Edit', target: '/r/a.ts' });
  assert.equal(diagnose(r, [r]), undefined);
  assert.equal(diagnose(r, [r, { ...r }])?.rule, 'D1');
  const dump = row({ kind: 'refusal', agent: 'main', code: 'Bash', target: 'cat a', detail: 'Read files with the Read tool' });
  assert.equal(diagnose({ ...dump, target: 'sed b' }, [dump, { ...dump, target: 'sed b' }])?.rule, 'D7');
  assert.equal(diagnose(row({ kind: 'tool_error', code: 'mcp__web__web_search', detail: 'Brave: fetch failed (ENOTFOUND)' }), [])?.rule, 'D4');
  assert.equal(diagnose(row({ kind: 'tool_error', code: 'mcp__code__notes_add', detail: 'body: String must contain at most 1500 character(s)' }), [])?.rule, 'D5');
});

test('rules: each diagnosis is logged once, then its outcome: resolved, or not resolved when it fails again', () => {
  const r = { kind: 'refusal' as const, agent: 'h1', code: 'Edit', target: '/r/a.ts' };
  diag(r);
  const second = diag(r);
  assert.equal(diagnosisOf(second)?.rule, 'D1');
  diag(r);
  const outcomes = () => recentDiag(60_000).filter((x) => x.kind === 'diagnosis').map((x) => x.outcome ?? x.rule);
  assert.deepEqual(outcomes(), ['D1', 'not resolved']);
  resolved('refusal:h1:');
  assert.deepEqual(outcomes(), ['D1', 'not resolved'], 'a diagnosis that failed again is not later called resolved');
  diag({ kind: 'tool_error', code: 'web_search', detail: 'timed out after 15s' });
  resolved('tool:web_search');
  assert.deepEqual(outcomes(), ['D1', 'not resolved', 'D4', 'resolved']);
});

test('report: failures by kind, diagnoses with outcomes, what no rule explains, and a Diagnose prompt', () => {
  const now = Date.now();
  const rows: DiagRow[] = [
    { at: now - 5000, machine: 'm', kind: 'api_retry', session: 's1', provider: 'claude', code: 'server_error', status: 529 },
    { at: now - 4000, machine: 'm', kind: 'diagnosis', rule: 'D2', detail: 'claude is failing for 2 chats', action: 'switching now', target: 'outage:claude' },
    { at: now - 3000, machine: 'm', kind: 'diagnosis', rule: 'D2', target: 'outage:claude', outcome: 'resolved' },
    { at: now - 2000, machine: 'm', kind: 'failover', session: 's1', provider: 'deepseek', code: 'unknown', detail: 'socket closed | weird', action: 'reported to the user' },
    { at: now - 90_000_000, machine: 'm', kind: 'proxy', detail: 'too old' },
  ];
  const md = failuresReport(rows, now - 86_400_000, now);
  assert.match(md, /2 failures across 1 chats/);
  assert.match(md, /\| api_retry \| 1 \| server_error 529 ×1 \|/);
  assert.match(md, /\| D2 \| claude is failing for 2 chats \| switching now \| 1 \| 1 \| 0 \|/);
  assert.match(md, /## Not explained yet\n\n- ×1 socket closed \\\| weird/);
  assert.doesNotMatch(md, /too old/);
  assert.match(failuresReport([], now - 1000, now), /Nothing failed/);
  assert.match(diagnosePrompt(rows.slice(0, 1)), /```\n\d\d:\d\d \[api_retry\] claude server_error 529\n```\nIn two or three sentences/);
});

test('diag: keys and tokens in commands and errors are masked before they are kept', () => {
  resetDiag();
  const row = diag({ kind: 'tool_error', code: 'Bash', target: 'curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x', detail: 'DEEPSEEK_API_KEY=sk-1234567890abcdefgh failed; ghp_abcdefghijklmnopqrstu' }); // gitleaks:allow (fake tokens)
  assert.doesNotMatch(row.target!, /abcdefghijklmnop1234/);
  assert.doesNotMatch(row.detail!, /1234567890abcdefgh|abcdefghijklmnopqrstu/);
  assert.match(row.detail!, /DEEPSEEK_API_KEY=(sk-)?…/);
  assert.equal(redactSecrets('npm test -- --grep token'), 'npm test -- --grep token', 'ordinary words stay');
});

test('report: warnings shown in the chat and edit checks have their own sections and are not counted as failures', () => {
  const at = Date.now();
  const rows: DiagRow[] = [
    { at, machine: 'm', kind: 'notice', level: 'warn', detail: 'Nearing a cost limit: all models: $8.10 of $10.00.' },
    { at, machine: 'm', kind: 'notice', level: 'warn', detail: 'Nearing a cost limit: all models: $8.70 of $10.00.' },
    { at, machine: 'm', kind: 'edit_check', code: 'new_errors', target: 'src/a.ts', detail: 'The edit left 1 new error' },
    { at, machine: 'm', kind: 'launch', level: 'info', detail: 'Starting DeepSeek' },
    { at, machine: 'm', kind: 'cache_miss', level: 'warn', code: 'messages_changed', detail: 'wrote 101k, read 10k' },
    { at, machine: 'm', kind: 'cache_miss', level: 'info', code: 'messages_changed', detail: 'wrote 30k, read 10k; after compaction' },
    { at, machine: 'm', kind: 'cache_miss', level: 'info', code: 'expired', detail: 'wrote 80k, read 0' },
  ];
  const text = failuresReport(rows, at - 3_600_000, at + 1);
  assert.match(text, /## Prompt cache misses\n\n3 misses with a cause; 1 rewrote a large conversation mid-chat \(the costly kind\)\.\nBy cause: messages_changed ×2, expired ×1\.\n- .* messages_changed: wrote 101k, read 10k/);
  assert.match(text, /## Warnings shown in the chat\n\n\| Level \| Count \| Message \|\n\|---\|---\|---\|\n\| warn \| 2 \| Nearing a cost limit: all models: \$8\.70 of \$10\.00\. \|/);
  assert.match(text, /Edits that left new errors: 1\. .*\nMost new errors: src\/a\.ts ×1\./);
  assert.match(text, /Nothing failed\./);
});

test('report: the cost gates are measured from turns, calls and the failure log', () => {
  const at = Date.now();
  const turn = (implicit: boolean, agents = 0): any => ({ at, implicit, tools: agents ? { Agent: { calls: agents, errors: 0, ms: 0, outChars: 0 } } : {}, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0 });
  const call = (agent: string, model: string, t: Partial<{ input: number; cacheRead: number; cacheWrite: number; output: number }>): any => ({ at, machine: 'm', repo: 'r', provider: 'claude', agent, model, billing: 'api', input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...t });
  const lines = gateReport(
    [turn(false, 2), turn(true), turn(false)],
    [call('Main agent', 'claude-opus-5-5', { cacheWrite: 1e6, output: 1e5 }), call('general-purpose', 'deepseek-flash', { cacheRead: 9e5 }), call('general-purpose', 'deepseek-flash', { cacheRead: 9e5 })],
    [
      { at, machine: 'm', kind: 'refusal', agent: 'h1' },
      { at, machine: 'm', kind: 'claims', detail: 'unverified: says it builds' },
      { at, machine: 'm', kind: 'memory', code: 'brief' },
      { at, machine: 'm', kind: 'memory', code: 'held' },
    ],
  ).join('\n');
  assert.match(lines, /\| Automatic turns per user turn \| 0\.50 \(1 \/ 2\) \| ≤ 1 \(2\.25\) \|/);
  assert.match(lines, /\| Cache writes, share of Opus cost \| 71% \(\$5\.00 of \$7\.00\)/);
  assert.match(lines, /\| Helper calls per launch \| 1 \(2 \/ 2\)/);
  assert.match(lines, /\| Refusals per helper launch \| 0\.50/);
  assert.match(lines, /\| Unverified claims \| 1 \|/);
  assert.match(lines, /\| Flash tokens per launch \| 900k/);
  assert.match(lines, /brief sent to 1 helpers, notes shown with 0 file reads, 0 helper notes confirmed, 1 held back/);
  assert.deepEqual(gateReport([], [], []), []);
});

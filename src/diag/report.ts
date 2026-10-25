/**
 * What the failure log says, for people and for the agent: the "Show
 * Failures" report (what failed today, which diagnoses helped, what no rule
 * explains yet) and the Diagnose prompt (one chat's recent rows). Pure.
 */
import { DiagRow, FAILURE_KINDS, formatDiag } from './log';
import type { TurnMetrics } from '../metrics/turns';
import type { CallRow } from '../metrics/calls';
import { costOf } from '../usage';
import { formatTokens } from '../text';

const time = (at: number) => new Date(at).toTimeString().slice(0, 5);
const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const secs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${(ms / 60_000).toFixed(1)}m`);

/**
 * Where the turns' time went: model calls, tools, our hooks, waiting for the
 * user, process starts; plus automatic turns and restarts by reason.
 */
export function timeReport(turns: TurnMetrics[], restarts: DiagRow[]): string[] {
  if (!turns.length) {
    return [];
  }
  const sum = (f: (t: TurnMetrics) => number | undefined) => turns.reduce((n, t) => n + (f(t) ?? 0), 0);
  const total = sum((t) => t.durationMs);
  const share = (ms: number) => `${secs(ms)} (${total ? Math.round((100 * ms) / total) : 0}%)`;
  const toolMs = sum((t) => Object.values(t.tools).reduce((n, s) => n + s.ms, 0));
  const hooks = new Map<string, { calls: number; ms: number }>();
  for (const t of turns) {
    for (const [name, h] of Object.entries(t.hooks ?? {})) {
      const a = hooks.get(name) ?? { calls: 0, ms: 0 };
      hooks.set(name, { calls: a.calls + h.calls, ms: a.ms + h.ms });
    }
  }
  const hookMs = [...hooks.values()].reduce((n, h) => n + h.ms, 0);
  const auto = turns.filter((t) => t.implicit);
  const calls = sum((t) => t.modelCalls);
  const first = turns.filter((t) => t.firstOfProcess && !t.implicit);
  const cacheShare = (ts: TurnMetrics[]) => {
    const input = ts.reduce((n, t) => n + t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite, 0);
    return input ? `${Math.round((100 * ts.reduce((n, t) => n + t.tokens.cacheRead, 0)) / input)}%` : '—';
  };
  const out = [
    '## Where the time went',
    '',
    `${turns.length} turns, ${secs(total)} in all; ${calls} model calls, ${secs(calls ? sum((t) => t.apiMs) / calls : 0)} each on average.`,
    '',
    '| Part | Time |',
    '|---|---|',
    `| Model calls (API time, helpers overlap) | ${share(sum((t) => t.apiMs))} |`,
    `| Tools (helpers included, they overlap) | ${share(toolMs)} |`,
    `| Our hooks | ${share(hookMs)}${hooks.size ? `: ${[...hooks].map(([n, h]) => `${n} ${secs(h.ms)}/${h.calls}`).join(', ')}` : ''} |`,
    `| Waiting for you (cards) | ${share(sum((t) => t.blockedMs))} |`,
    `| Agent process starts | ${share(sum((t) => t.launchMs))} (${sum((t) => t.launches)} starts) |`,
    '',
    `Automatic turns (helper reports): ${auto.length}, ${secs(sum((t) => (t.implicit ? t.durationMs : 0)))}, $${auto.reduce((n, t) => n + t.cost, 0).toFixed(2)}. Turns with retries: ${turns.filter((t) => t.retries).length}.`,
    `Cache read share: ${cacheShare(turns.filter((t) => !t.firstOfProcess))} normally, ${cacheShare(first)} on the first turn after a process start.`,
  ];
  if (restarts.length) {
    const why = new Map<string, number>();
    restarts.forEach((r) => why.set(r.detail ?? '?', (why.get(r.detail ?? '?') ?? 0) + 1));
    out.push(`Restarts: ${restarts.length} (${[...why].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ×${n}`).join('; ')}).`);
  }
  return [...out, ''];
}

/** Spawn tools: a helper launch each. */
const SPAWNS = ['Agent', 'Task'];

/**
 * The plan's gates (reports/Agent memory to cut token burn.md), measured:
 * whether helper reports still wake the main agent, whether cache writes
 * still dominate Opus cost, and whether helpers need fewer steps and
 * refusals, with what project memory gave them. Empty with no turns.
 */
export function gateReport(turns: TurnMetrics[], calls: CallRow[], rows: DiagRow[]): string[] {
  if (!turns.length && !calls.length) {
    return [];
  }
  const user = turns.filter((t) => !t.implicit).length;
  const auto = turns.length - user;
  const opus = calls.filter((c) => /opus/i.test(c.model));
  const opusCost = opus.reduce((n, c) => n + costOf(c), 0);
  const writeCost = opus.reduce((n, c) => n + costOf({ ...c, input: 0, cacheRead: 0, output: 0 }), 0);
  const launches = turns.reduce((n, t) => n + SPAWNS.reduce((m, s) => m + (t.tools[s]?.calls ?? 0), 0), 0);
  const helperCalls = calls.filter((c) => c.agent !== 'Main agent' && !c.delta).length;
  const refusals = rows.filter((r) => r.kind === 'refusal' && r.agent && r.agent !== 'main').length;
  const unverified = rows.filter((r) => r.kind === 'claims' && (r.detail ?? '').startsWith('unverified:')).length;
  const flash = calls.filter((c) => /flash/i.test(c.model)).reduce((n, c) => n + c.input + c.cacheRead + c.cacheWrite + c.output, 0);
  const memory = (code: string) => rows.filter((r) => r.kind === 'memory' && r.code === code).length;
  const per = (n: number, d: number, digits = 1) => (d ? (n / d).toFixed(digits) : '—');
  return [
    '## Cost gates',
    '',
    'The targets come from reports/Agent memory to cut token burn.md; 2026-10-21\'s values are in brackets.',
    '',
    '| Gate | Now | Target |',
    '|---|---|---|',
    `| Automatic turns per user turn | ${per(auto, user, 2)} (${auto} / ${user}) | ≤ 1 (2.25) |`,
    `| Cache writes, share of Opus cost | ${opusCost ? `${Math.round((100 * writeCost) / opusCost)}%` : '—'} ($${writeCost.toFixed(2)} of $${opusCost.toFixed(2)}) | ≤ 25% (48%) |`,
    `| Helper calls per launch | ${per(helperCalls, launches, 0)} (${helperCalls} / ${launches}) | ≤ 30 (~40) |`,
    `| Refusals per helper launch | ${per(refusals, launches, 2)} | < 0.2 |`,
    `| Unverified claims | ${unverified} | 0 (6) |`,
    `| Flash tokens per launch | ${launches ? formatTokens(Math.round(flash / launches)) : '—'} | ≤ 750k (940k) |`,
    '',
    `Project memory: brief sent to ${memory('brief')} helpers, notes shown with ${memory('recall')} file reads, ${memory('confirm')} helper notes confirmed, ${memory('held')} held back after web or tool content.`,
    '',
  ];
}

/** Markdown summary of the rows since `since`, with where the turns' time went and the cost gates when turns and calls are given. */
export function failuresReport(rows: DiagRow[], since: number, now = Date.now(), turns: TurnMetrics[] = [], calls: CallRow[] = []): string {
  const recent = rows.filter((r) => r.at >= since && r.at <= now).sort((a, b) => a.at - b.at);
  const hours = Math.round((now - since) / 3_600_000);
  const failures = recent.filter((r) => FAILURE_KINDS.has(r.kind));
  const window = turns.filter((t) => t.at >= since && t.at <= now);
  const timing = timeReport(window, recent.filter((r) => r.kind === 'relaunch'));
  const gates = gateReport(window, calls.filter((c) => c.at >= since && c.at <= now), recent);
  const out = [`# Dual Agent failures, last ${hours} hours`, '', ...timing, ...gates, ...seenAround(recent)];
  if (!failures.length) {
    return [...out, 'Nothing failed.'].join('\n');
  }

  out.push(`${failures.length} failures across ${new Set(failures.map((r) => r.session).filter(Boolean)).size} chats.`, '', '| What | Count | Most common |', '|---|---|---|');
  const byKind = group(failures, (r) => r.kind);
  for (const [kind, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    const top = [...group(list, (r) => [r.code, r.status].filter((x) => x !== undefined && x !== null).join(' ') || '—')].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
    out.push(`| ${kind} | ${list.length} | ${top.map(([k, l]) => `${cell(k)} ×${l.length}`).join(', ')} |`);
  }

  const diagnoses = recent.filter((r) => r.kind === 'diagnosis');
  const made = diagnoses.filter((r) => !r.outcome);
  if (made.length) {
    out.push('', '## Diagnoses', '', '| Rule | Cause | Action | Times | Resolved | Not resolved |', '|---|---|---|---|---|---|');
    for (const [rule, list] of [...group(made, (r) => r.rule ?? '?')].sort()) {
      const outcomes = diagnoses.filter((r) => r.rule === rule && r.outcome);
      const count = (o: string) => outcomes.filter((r) => r.outcome === o).length;
      out.push(`| ${rule} | ${cell(list.at(-1)!.detail)} | ${cell(list.at(-1)!.action)} | ${list.length} | ${count('resolved')} | ${count('not resolved')} |`);
    }
  }

  // Failures that no rule explains: the next fix comes from here.
  const unexplained = failures.filter((r) => (r.kind === 'api_error' || r.kind === 'failover' || r.kind === 'swallowed') && (r.code === 'unknown' || r.kind === 'swallowed' || !r.code));
  if (unexplained.length) {
    out.push('', '## Not explained yet', '');
    for (const [detail, list] of [...group(unexplained, (r) => `${r.target ? `${r.target}: ` : ''}${r.detail ?? '(no detail)'}`)].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
      out.push(`- ×${list.length} ${cell(detail)}`);
    }
  }

  out.push('', '## Latest', '', '| Time | What | Who | Code | Detail | Target |', '|---|---|---|---|---|---|');
  for (const r of failures.slice(-30).reverse()) {
    const who = [r.provider, r.agent && r.agent !== 'main' ? `helper ${r.agent.slice(0, 8)}` : r.agent].filter(Boolean).join(' ');
    out.push(`| ${time(r.at)} | ${r.kind} | ${cell(who)} | ${cell([r.code, r.status ?? undefined].filter(Boolean).join(' '))} | ${cell(r.detail)} | ${cell(r.target)} |`);
  }
  return out.join('\n');
}

/** What happened around the failures: warnings the chat showed and what the post-edit checks found. */
function seenAround(rows: DiagRow[]): string[] {
  const out: string[] = [];
  const notices = rows.filter((r) => r.kind === 'notice');
  if (notices.length) {
    out.push('## Warnings shown in the chat', '', '| Level | Count | Message |', '|---|---|---|');
    // Messages differ in their numbers ($1.20, 3 retries): grouped without them.
    const byText = group(notices, (r) => `${r.level ?? 'warn'}|${(r.detail ?? '').replace(/[\d.,$%]+/g, '#').slice(0, 90)}`);
    for (const [, list] of [...byText].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
      out.push(`| ${list[0].level ?? 'warn'} | ${list.length} | ${cell(list.at(-1)!.detail)} |`);
    }
    out.push('');
  }
  const edits = rows.filter((r) => r.kind === 'edit_check');
  if (edits.length) {
    const count = (code: string) => edits.filter((r) => r.code === code).length;
    const files = [...group(edits.filter((r) => r.code === 'new_errors'), (r) => r.target ?? '?')].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
    out.push('## Edit checks', '', `Edits that left new errors: ${count('new_errors')}. Edits that copied code or narrated the change: ${count('reuse_or_comments')}.`);
    if (files.length) {
      out.push(`Most new errors: ${files.map(([f, l]) => `${cell(f)} ×${l.length}`).join(', ')}.`);
    }
    out.push('');
  }
  const misses = rows.filter((r) => r.kind === 'cache_miss');
  if (misses.length) {
    const unexpected = misses.filter((r) => r.level === 'warn');
    out.push('## Prompt cache misses', '', `${misses.length} misses with a cause; ${unexpected.length} rewrote a large conversation mid-chat (the costly kind).`);
    out.push(`By cause: ${[...group(misses, (r) => r.code ?? '?')].sort((a, b) => b[1].length - a[1].length).map(([c, l]) => `${cell(c)} ×${l.length}`).join(', ')}.`);
    for (const r of unexpected.slice(-5)) {
      out.push(`- ${time(r.at)} ${cell(r.code)}: ${cell(r.detail)}`);
    }
    out.push('');
  }
  return out;
}

/** The message the Diagnose button sends: this chat's recent failure rows, newest last. */
export function diagnosePrompt(rows: DiagRow[]): string {
  const lines = rows.map((r) => `${time(r.at)} ${formatDiag(r)}`);
  return [
    "Diagnose the failure above from Dual Agent's failure log for this chat (newest last):",
    '```',
    ...lines,
    '```',
    'In two or three sentences, say the most likely cause. If it comes from code or config in this workspace, propose the smallest fix with file:line. If it is the provider, the network or the account, say so and what I can do. Change nothing until I agree.',
  ].join('\n');
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

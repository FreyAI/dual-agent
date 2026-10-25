/**
 * The "Diagnose Token Burn" report: where a window's tokens and money went,
 * from the call, turn and helper logs and the failure log. By chat, by 10
 * minutes, by helper launch, by big tool output, by automatic turn, plus the
 * cache misses, compactions and spikes in between, and what to look at first.
 * The questions it answers took an afternoon of log digging on 2026-10-21. Pure.
 */
import type { CallRow } from '../metrics/calls';
import type { HelperRow } from '../metrics/helpers';
import type { TurnMetrics } from '../metrics/turns';
import type { DiagRow } from './log';
import { costOf } from '../usage';
import { formatTokens } from '../text';

export interface BurnInput {
  calls: CallRow[];
  turns: TurnMetrics[];
  helpers: HelperRow[];
  diag: DiagRow[];
  since: number;
  now?: number;
}

const BUCKET_MS = 10 * 60_000;
const fresh = (c: CallRow) => c.input + c.cacheWrite + c.output;
const all = (c: CallRow) => c.input + c.cacheRead + c.cacheWrite + c.output;
const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);
const day = (at: number) => new Date(at).toISOString().slice(5, 10);
const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}m`);
const isHelper = (c: CallRow) => c.agent !== 'Main agent';

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

interface Spend { calls: number; fresh: number; reads: number; cost: number }
function spend(calls: CallRow[]): Spend {
  return calls.reduce((s, c) => ({ calls: s.calls + (c.delta ? 0 : 1), fresh: s.fresh + fresh(c), reads: s.reads + c.cacheRead, cost: s.cost + costOf(c) }), { calls: 0, fresh: 0, reads: 0, cost: 0 });
}

/** Who spent it: the main agent, or a helper type (with its launch id when known). */
const spender = (c: CallRow) => (isHelper(c) ? `${c.agent}${c.helper ? ` ·${c.helper.slice(-6)}` : ''}` : 'main agent');

export function burnReport(input: BurnInput): string {
  const now = input.now ?? Date.now();
  const inWindow = <T extends { at: number }>(rows: T[]) => rows.filter((r) => r.at >= input.since && r.at <= now);
  const calls = inWindow(input.calls);
  const turns = inWindow(input.turns);
  const helpers = inWindow(input.helpers);
  const diag = inWindow(input.diag);
  const hours = Math.round((now - input.since) / 3_600_000);
  const out = [`# Token burn, last ${hours} hours`, ''];
  if (!calls.length) {
    return [...out, 'No model calls in this window.'].join('\n');
  }
  const total = spend(calls);
  const tokens = calls.reduce((n, c) => n + all(c), 0);
  const helperSpend = spend(calls.filter(isHelper));
  const opus = calls.filter((c) => /opus/i.test(c.model));
  const opusCost = opus.reduce((n, c) => n + costOf(c), 0);
  const opusWrites = opus.reduce((n, c) => n + costOf({ ...c, input: 0, cacheRead: 0, output: 0 }), 0);
  const auto = turns.filter((t) => t.implicit);
  out.push(
    `${total.calls} model calls, ${formatTokens(tokens)} tokens: ${formatTokens(total.fresh)} new and ${formatTokens(total.reads)} cache re-reads (${pct(total.reads, tokens)}). ${money(total.cost)} at API prices; helpers ${money(helperSpend.cost)} (${pct(helperSpend.cost, total.cost)}).`,
    '',
  );

  // Where to look first: the patterns that cost most on 2026-10-21.
  const hints: string[] = [];
  if (auto.length > turns.length - auto.length) {
    hints.push(`Helper reports woke the main agent ${auto.length} times for ${turns.length - auto.length} messages of yours (${money(auto.reduce((n, t) => n + t.cost, 0))}): see Automatic turns.`);
  }
  if (opusCost && opusWrites / opusCost > 0.25) {
    hints.push(`Cache writes are ${pct(opusWrites, opusCost)} of Opus cost: see Cache misses.`);
  }
  if (helperSpend.cost / Math.max(total.cost, 1e-9) > 0.5) {
    hints.push('Helpers spent most of the money: see Helpers.');
  }
  const big = diag.filter((r) => r.kind === 'big_output');
  const reread = [...group(big, (r) => `${r.code}|${r.target}`)].filter(([, l]) => l.length >= 3);
  if (reread.length) {
    hints.push(`${reread.length} large output${reread.length === 1 ? ' was' : 's were'} produced 3 or more times: see Biggest tool outputs.`);
  }
  const spikes = diag.filter((r) => r.kind === 'burn_spike');
  if (spikes.length) {
    hints.push(`${spikes.length} ten-minute spike${spikes.length === 1 ? '' : 's'}: see Spikes.`);
  }
  if (hints.length) {
    out.push('## Where to look first', '', ...hints.map((h) => `- ${h}`), '');
  }

  out.push('## By chat', '', '| Chat | Repo | Cost | New | Re-reads | Helpers | Automatic turns |', '|---|---|---|---|---|---|---|');
  const chats = [...group(calls, (c) => c.session ?? '?')].map(([session, l]) => ({ session, repo: l[0].repo, s: spend(l), h: spend(l.filter(isHelper)) })).sort((a, b) => b.s.cost - a.s.cost);
  for (const c of chats.slice(0, 8)) {
    const autoIn = auto.filter((t) => t.session === c.session);
    out.push(`| ${c.session.slice(0, 8)} | ${cell(c.repo.split('/').slice(-1)[0])} | ${money(c.s.cost)} | ${formatTokens(c.s.fresh)} | ${formatTokens(c.s.reads)} | ${pct(c.h.cost, c.s.cost)} | ${autoIn.length} (${money(autoIn.reduce((n, t) => n + t.cost, 0))}) |`);
  }

  out.push('', '## Busiest 10 minutes', '', '| When | Cost | New | Re-reads | Calls | Top spenders |', '|---|---|---|---|---|---|');
  const buckets = [...group(calls, (c) => String(Math.floor(c.at / BUCKET_MS) * BUCKET_MS))].map(([at, l]) => ({ at: Number(at), l, s: spend(l) }));
  for (const b of buckets.sort((x, y) => y.s.cost - x.s.cost).slice(0, 8).sort((x, y) => x.at - y.at)) {
    const top = [...group(b.l, spender)].map(([who, l]) => [who, spend(l).cost] as const).sort((x, y) => y[1] - x[1]).slice(0, 3);
    out.push(`| ${day(b.at)} ${clock(b.at)} | ${money(b.s.cost)} | ${formatTokens(b.s.fresh)} | ${formatTokens(b.s.reads)} | ${b.s.calls} | ${cell(top.map(([w, c]) => `${w} ${money(c)}`).join(', '))} |`);
  }

  out.push('', '## Helpers', '');
  if (helpers.length) {
    const cost = helpers.reduce((n, h) => n + h.cost, 0);
    out.push(`${helpers.length} launches, ${money(cost)}; ${helpers.filter((h) => h.background).length} in the background. Costliest:`, '', '| Started | Type | Model | Calls | New | Re-reads | Peak context | Cost | Took | Outcome | Biggest tool output |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const h of [...helpers].sort((a, b) => b.cost - a.cost).slice(0, 10)) {
      const tool = Object.entries(h.tools).sort((a, b) => b[1].outChars - a[1].outChars)[0];
      out.push(`| ${clock(h.at)} | ${cell(h.type)} | ${cell(h.model ?? '')} | ${h.calls} | ${formatTokens(h.tokens.input + h.tokens.cacheWrite + h.tokens.output)} | ${formatTokens(h.tokens.cacheRead)} | ${formatTokens(h.peakContext)} | ${money(h.cost)} | ${mins(h.endedAt - h.at)} | ${h.outcome ?? '—'} | ${tool ? `${cell(tool[0])} ${formatTokens(tool[1].outChars)} chars in ${tool[1].calls}` : '—'} |`);
    }
    const byType = [...group(helpers, (h) => h.type)].map(([type, l]) => `${type} ×${l.length}: ${money(l.reduce((n, h) => n + h.cost, 0) / l.length)} and ${Math.round(l.reduce((n, h) => n + h.calls, 0) / l.length)} calls each`);
    out.push('', `Per launch: ${byType.join('; ')}.`);
  } else {
    // Before helper rows existed: launches from the calls' helper ids, else only by type.
    const launches = [...group(calls.filter(isHelper), (c) => c.helper ?? c.agent)].map(([id, l]) => ({ id, type: l[0].agent, s: spend(l) })).sort((a, b) => b.s.cost - a.s.cost);
    out.push('No helper rows in this window (they are written when a helper ends). From the calls:', '', '| Helper | Calls | New | Re-reads | Cost |', '|---|---|---|---|---|');
    for (const l of launches.slice(0, 10)) {
      out.push(`| ${cell(l.type)}${l.id !== l.type ? ` ·${l.id.slice(-6)}` : ''} | ${l.s.calls} | ${formatTokens(l.s.fresh)} | ${formatTokens(l.s.reads)} | ${money(l.s.cost)} |`);
    }
  }
  const unattributed = calls.filter((c) => isHelper(c) && !c.turn && !c.spawnTurn);
  if (unattributed.length) {
    out.push('', `${unattributed.length} helper calls (${money(spend(unattributed).cost)}) came between replies with no launching reply recorded (logged before helper ids were kept).`);
  }

  out.push('', '## Biggest tool outputs', '');
  const tools = new Map<string, { calls: number; chars: number }>();
  for (const t of turns) {
    for (const [name, s] of Object.entries(t.tools)) {
      const a = tools.get(name) ?? { calls: 0, chars: 0 };
      tools.set(name, { calls: a.calls + s.calls, chars: a.chars + s.outChars });
    }
  }
  const byTool = [...tools].filter(([, t]) => t.chars).sort((a, b) => b[1].chars - a[1].chars).slice(0, 6);
  if (byTool.length) {
    out.push(`By tool, what the model read (~4 characters a token): ${byTool.map(([n, t]) => `${n} ${formatTokens(t.chars)} in ${t.calls} (${formatTokens(Math.round(t.chars / Math.max(t.calls, 1)))} each)`).join('; ')}.`, '');
  }
  if (big.length) {
    out.push('| Tool | File or command | Times | Size each | Who |', '|---|---|---|---|---|');
    for (const [, l] of [...group(big, (r) => `${r.code}|${r.target}`)].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
      out.push(`| ${cell(l[0].code)} | ${cell(l[0].target)} | ${l.length} | ${cell(l[0].detail)} | ${cell([...new Set(l.map((r) => r.agent ?? '?'))].join(', '))} |`);
    }
  } else {
    out.push('No single tool result over 20k characters.');
  }

  out.push('', '## Automatic turns', '');
  if (auto.length) {
    const typeOf = new Map(input.helpers.map((h) => [h.id, h.type]));
    const by = [...group(auto, (t) => (t.wokenBy ? (typeOf.get(t.wokenBy) ?? 'a helper') : 'not recorded'))].map(([who, l]) => `${who} ×${l.length} (${money(l.reduce((n, t) => n + t.cost, 0))})`);
    out.push(`${auto.length} turns started by a helper's report, ${money(auto.reduce((n, t) => n + t.cost, 0))}, against ${turns.length - auto.length} of yours. Woken by: ${by.join(', ')}.`);
  } else {
    out.push('None: every helper reported within the reply that started it.');
  }

  const misses = diag.filter((r) => r.kind === 'cache_miss');
  out.push('', '## Cache misses', '');
  if (misses.length) {
    out.push('| Time | Provider | Who | Cause | Detail |', '|---|---|---|---|---|');
    for (const r of misses.slice(-15)) {
      out.push(`| ${clock(r.at)} | ${cell(r.provider)} | ${cell(r.agent)} | ${cell(r.code)} | ${cell(r.detail)} |`);
    }
  } else {
    out.push('None logged.');
  }

  const compactions = diag.filter((r) => r.kind === 'compaction');
  if (compactions.length) {
    out.push('', '## Compactions', '', ...compactions.map((r) => `- ${clock(r.at)} ${cell(r.code)}: ${cell(r.detail)}`));
  }
  if (spikes.length) {
    out.push('', '## Spikes', '', ...spikes.map((r) => `- ${day(r.at)} ${clock(r.at)} ${cell(r.detail)}`));
  }
  out.push('', 'Sources: the calls, turns, helpers and diag logs in the usage folder (dualAgent.usageFolder).');
  return out.join('\n');
}

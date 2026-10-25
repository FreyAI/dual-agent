/**
 * Diagnosis while it runs: every failure row is matched against a small rule
 * table that names the likely cause and what is done about it. A match is
 * itself logged (kind 'diagnosis'), and so is its outcome: 'resolved' once the
 * thing it was about works again, 'not resolved' if the same failure comes
 * back. The rules that work and the failures no rule explains (D8) show in the
 * failures report, so the next fix is chosen from data.
 */
import { DiagRow, diag, onDiag, recentDiag } from './log';

export interface Diagnosis {
  rule: string;
  cause: string;
  action: string;
  /** What the diagnosis is about; a later failure or success for it decides the outcome. */
  key: string;
}

const MINUTE = 60_000;
/** A tool's name without its server prefix: the controller logs "mcp__web__web_search", the tool itself "web_search". */
export const bareTool = (name = '') => name.replace(/^mcp__[^_]+__/, '');
const TRANSIENT = new Set(['server_error', 'overloaded']);
const NETWORK = /timed out|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed|network/i;
const BAD_INPUT = /invalid|validation|expected .* (received|got)|must (be|contain|have)|at (most|least) \d|too (long|many)|required/i;

/** The rule a row matches, given this process's recent rows (which include it). Pure. */
export function diagnose(row: DiagRow, recent: DiagRow[]): Diagnosis | undefined {
  if (row.kind === 'refusal') {
    const same = recent.filter((r) => r.kind === 'refusal' && r.agent === row.agent && r.code === row.code && r.target === row.target && row.at - r.at <= 10 * MINUTE);
    if (same.length >= 2) {
      return { rule: 'D1', cause: `the agent repeated a refused ${row.code} call (${same.length} times)`, action: same.length >= 3 ? 'told to stop and report' : 'refused again with a firmer reason', key: `refusal:${row.agent}:${row.target}` };
    }
    if (/Read tool/.test(row.detail ?? '') && recent.filter((r) => r.kind === 'refusal' && r.agent === row.agent && /Read tool/.test(r.detail ?? '') && row.at - r.at <= 30 * MINUTE).length >= 2) {
      return { rule: 'D7', cause: 'the agent keeps reading files through the shell', action: 'helper briefs carry the rule', key: `dump:${row.agent}` };
    }
    return undefined;
  }
  if ((row.kind === 'api_retry' || row.kind === 'api_error') && (row.status === 400 || row.status === 422 || row.code === 'invalid_request')) {
    return { rule: 'D3', cause: 'the provider rejected the request itself', action: 'not retried (it would resend the same request)', key: `request:${row.provider}` };
  }
  if ((row.kind === 'api_retry' || row.kind === 'api_error') && row.code && TRANSIENT.has(row.code)) {
    const sessions = new Set(recent.filter((r) => (r.kind === 'api_retry' || r.kind === 'api_error') && r.provider === row.provider && r.code && TRANSIENT.has(r.code) && row.at - r.at <= 5 * MINUTE).map((r) => r.session ?? '?'));
    if (sessions.size >= 2) {
      return { rule: 'D2', cause: `${row.provider} is failing for ${sessions.size} chats at once (an outage)`, action: 'switching now instead of after 3 retries', key: `outage:${row.provider}` };
    }
    return undefined;
  }
  const tool = bareTool(row.code);
  if (row.kind === 'tool_error' && tool.startsWith('web_') && NETWORK.test(row.detail ?? '')) {
    return { rule: 'D4', cause: 'a web search provider is unreachable', action: 'that provider rests briefly; the others answer', key: `tool:${tool}` };
  }
  if (row.kind === 'tool_error' && BAD_INPUT.test(row.detail ?? '')) {
    return { rule: 'D5', cause: `the model sent ${tool} input it rejects`, action: 'the error tells the model the limits', key: `tool:${tool}` };
  }
  if ((row.kind === 'api_error' || row.kind === 'failover') && (row.code === 'unknown' || !row.code)) {
    return { rule: 'D8', cause: 'an error no rule explains yet', action: 'kept for a new rule (see Show Failures)', key: `unknown:${row.provider}` };
  }
  return undefined;
}

/** Diagnoses still waiting for an outcome, by key. */
const open = new Map<string, { rule: string; failedAgain: boolean }>();
const byRow = new WeakMap<DiagRow, Diagnosis>();

function onRow(row: DiagRow) {
  if (row.kind === 'diagnosis') {
    return;
  }
  const d = diagnose(row, recentDiag(30 * MINUTE, row.at));
  if (!d) {
    return;
  }
  byRow.set(row, d);
  const prev = open.get(d.key);
  if (prev) {
    if (!prev.failedAgain) {
      prev.failedAgain = true;
      diag({ kind: 'diagnosis', rule: prev.rule, target: d.key, outcome: 'not resolved', session: row.session, turn: row.turn, provider: row.provider });
    }
    return;
  }
  open.set(d.key, { rule: d.rule, failedAgain: false });
  diag({ kind: 'diagnosis', rule: d.rule, detail: d.cause, action: d.action, target: d.key, session: row.session, turn: row.turn, provider: row.provider, agent: row.agent });
}
onDiag(onRow);

/** The diagnosis made for a row just logged, if a rule matched. */
export const diagnosisOf = (row: DiagRow) => byRow.get(row);

/** What a diagnosis was about works again (e.g. a reply finished): its outcome is 'resolved' unless it failed again. */
export function resolved(keyPrefix: string) {
  for (const [key, d] of open) {
    if (key.startsWith(keyPrefix)) {
      open.delete(key);
      if (!d.failedAgain) {
        diag({ kind: 'diagnosis', rule: d.rule, target: key, outcome: 'resolved' });
      }
    }
  }
}

/** Tests: forget open diagnoses. */
export const resetDiagnoses = () => open.clear();

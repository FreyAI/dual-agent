/**
 * The failure log. Every failure the extension sees (API retries and errors,
 * provider switches, tool errors, refusals, report checks, proxy errors,
 * swallowed exceptions) is one row in diag-<machine>.jsonl next to the usage
 * files and one line in the output channel, with its cause. Rows never hold
 * request bodies or keys. Writing never throws: a failure log that fails must
 * not break the reply it describes.
 */
import * as fs from 'fs';
import { JsonlLog } from '../jsonl';
import { errorMessage, redactSecrets, short } from '../text';

export type DiagKind =
  | 'api_retry' | 'api_error' | 'failover' | 'tool_error' | 'refusal' | 'claims' | 'proxy' | 'swallowed'
  // Events, not failures: a diagnosis, an agent restart or start, a warning shown in the chat, a post-edit check's finding,
  // a prompt cache miss and its cause, project memory given to an agent or a note confirmed or held back,
  // a tool result big enough to matter, ten minutes of unusually fast spending, a compaction and what it saved.
  | 'diagnosis' | 'relaunch' | 'launch' | 'notice' | 'edit_check' | 'cache_miss' | 'memory' | 'big_output' | 'burn_spike' | 'compaction';

/** The kinds that are failures; the others record what happened around them. */
export const FAILURE_KINDS: ReadonlySet<DiagKind> = new Set(['api_retry', 'api_error', 'failover', 'tool_error', 'refusal', 'claims', 'proxy', 'swallowed']);

export interface DiagRow {
  at: number;
  machine: string;
  kind: DiagKind;
  session?: string;
  repo?: string;
  provider?: string;
  model?: string;
  /** 'main' or a helper's agent id ('remote' for a Remote Control session). */
  agent?: string;
  /** The reply it happened in (TurnMetrics.turn), to join failures, calls and turns. */
  turn?: string;
  /** How bad: errors and warnings shown in the chat, info for events. Unset on older rows. */
  level?: 'error' | 'warn' | 'info';
  /** The error code (e.g. server_error) or tool name. */
  code?: string;
  /** HTTP status, when there was one. */
  status?: number | null;
  detail?: string;
  /** What failed: a file, tool, provider or code site. */
  target?: string;
  /** A proxy failure on background traffic (not a model call: heartbeats, polls, telemetry). */
  background?: boolean;
  /** A diagnosis row: the rule, what was done, and later whether it helped. */
  rule?: string;
  action?: string;
  outcome?: 'resolved' | 'not resolved';
}

export type DiagInput = Omit<DiagRow, 'at' | 'machine'>;

/** How long rows are kept by default (dualAgent.logRetentionDays): long enough to compare weeks of changes. */
export const LOG_KEEP_DAYS = 90;
const DETAIL_CHARS = 300;
/** Rows of this process kept in memory for diagnosis rules (cross-chat, e.g. an outage seen by two chats). */
const RECENT_ROWS = 300;

let out: (line: string) => void = () => undefined;
let file: JsonlLog<DiagRow> | undefined;
let machine = '';
const recent: DiagRow[] = [];
const listeners = new Set<(row: DiagRow) => void>();

const isRow = (r: unknown): r is DiagRow => !!r && typeof (r as DiagRow).at === 'number' && typeof (r as DiagRow).kind === 'string';

/** Where rows go; called once on activation (tests leave it unset: rows stay in memory). */
export function setDiagSink(opts: { dir?: string; machine: string; out: (line: string) => void }) {
  out = opts.out;
  machine = opts.machine;
  file = opts.dir ? new JsonlLog<DiagRow>(opts.dir, 'diag', opts.machine, isRow) : undefined;
}

/** The output-channel form of a row: "[api_retry] Claude/opus main server_error 529: overloaded (attempt 2)". */
export function formatDiag(r: DiagInput): string {
  const who = [r.provider && (r.model ? `${r.provider}/${r.model}` : r.provider), r.agent].filter(Boolean).join(' ');
  const what = [r.code, r.status ?? undefined].filter((x) => x !== undefined && x !== '').join(' ');
  if (r.kind === 'swallowed') {
    return `[swallowed] ${r.target ?? 'unknown site'} failed: ${r.detail ?? ''}`;
  }
  const head = [`[${r.kind}]`, who, what].filter(Boolean).join(' ');
  const tail = [r.rule && `rule ${r.rule}`, r.action && `→ ${r.action}`, r.outcome].filter(Boolean).join(' ');
  return `${head}${r.detail ? `: ${r.detail}` : ''}${r.target ? ` (${r.target})` : ''}${tail ? ` ${tail}` : ''}`;
}

/** Records one failure. */
export function diag(input: DiagInput): DiagRow {
  // Commands and errors can carry keys: masked before anything is kept.
  const clean = (s: string | undefined, max: number) => (s === undefined ? undefined : short(redactSecrets(s.replace(/\s+/g, ' ').trim()), max));
  const row: DiagRow = { at: Date.now(), machine, ...input, detail: clean(input.detail, DETAIL_CHARS), target: clean(input.target, DETAIL_CHARS) };
  recent.push(row);
  if (recent.length > RECENT_ROWS) {
    recent.splice(0, recent.length - RECENT_ROWS);
  }
  try {
    out(formatDiag(row));
  } catch {
    // The output channel is gone (shutting down).
  }
  try {
    file?.append([row]);
  } catch {
    // An unwritable usage folder is reported by the usage ledger already.
  }
  for (const fn of listeners) {
    try {
      fn(row);
    } catch {
      // A listener's bug must not stop the others.
    }
  }
  return row;
}

/** An exception that was caught and handled: logged so it isn't invisible. */
export const swallowed = (where: string, err: unknown, extra?: Partial<DiagInput>) => diag({ kind: 'swallowed', target: where, detail: errorMessage(err), ...extra });

/** Calls `fn` with every new row; returns the unsubscribe. */
export function onDiag(fn: (row: DiagRow) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** This process's rows from the last `ms`. */
export const recentDiag = (ms: number, now = Date.now()): DiagRow[] => recent.filter((r) => now - r.at <= ms);

/** Every machine's saved rows (for the failures report). */
export function savedDiag(): DiagRow[] {
  file?.reload();
  return file ? [...file.all()] : [...recent];
}

/** Drops this machine's rows older than `days`. */
export function pruneDiag(days = LOG_KEEP_DAYS, now = Date.now()) {
  file?.prune(now - days * 86_400_000, (r) => r.at);
}

/** Tests: forget this process's rows (listeners such as the diagnosis rules stay). */
export function resetDiag() {
  recent.length = 0;
}

/**
 * Cache diagnostics for Claude requests: each request names the previous reply
 * of its conversation (`diagnostics.previous_message_id`), and the API answers
 * with where the prompt prefix diverged. A cache break costs a full rewrite at
 * up to 40x a read (six 75-121k rewrites, $4.43, on 2026-10-21), so each one is
 * logged with its cause instead of guessed at. The body is tagged in place,
 * without parsing it. https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics
 */
import type * as http from 'http';
import type { TappedUsage } from './usageTap';
import { requestMeta } from './server';
import { diag } from '../diag/log';
import { formatTokens } from '../text';

/** A cache write this large with no change found means the entry expired. */
const EXPIRED_WRITE = 20_000;
const MAX_THREADS = 200;

/** The last reply id per conversation: session, agent (main or a helper's id) and model each cache apart. */
const lastReply = new Map<string, string>();
let enabled = true;
/** The API refused the field: off for the rest of the process, whatever the setting says at the next launch. */
let refused = false;

/** dualAgent.cacheDiagnostics. */
export function setCacheDiagnostics(on: boolean) {
  enabled = on;
}

/** For tests: forget a refusal. */
export function resetCacheDiagnostics() {
  refused = false;
  enabled = true;
  lastReply.clear();
}

const FIELD = 'diagnostics';

export interface Tagged {
  body: Buffer;
  /** The field added: an error naming it means the upstream doesn't take it. */
  field: string;
  /** The reply to this request. */
  reply(u: TappedUsage): void;
  /** The API refused the field: stop adding it. */
  rejected(): void;
}

/** `raw` with a diagnostics object added, or undefined for requests that aren't a Claude conversation's. */
export function tagRequest(raw: Buffer, headers: http.IncomingHttpHeaders): Tagged | undefined {
  if (!enabled || refused) {
    return undefined;
  }
  const { model, session } = requestMeta(raw);
  const start = raw.indexOf('{');
  // A JSON object, not already carrying the field.
  if (!model || !/claude/i.test(model) || start < 0 || raw.subarray(0, start).toString('latin1').trim() || raw.includes(`"${FIELD}"`)) {
    return undefined;
  }
  const agent = String(headers['x-claude-code-agent-id'] ?? 'main');
  // Side requests (titles, summaries) on the same model are their own conversations, not the main one's next turn.
  const thread = `${session ?? '?'}|${agent}|${model}|${headers['x-claude-code-request-class'] ?? ''}`;
  const prev = lastReply.get(thread);
  const field = Buffer.from(`"${FIELD}":${JSON.stringify({ previous_message_id: prev ?? null })},`);
  const body = Buffer.concat([raw.subarray(0, start + 1), field, raw.subarray(start + 1)]);
  const compacted = headers['x-claude-code-context-compacted'] !== undefined || headers['x-claude-code-compaction'] !== undefined;
  return {
    body,
    field: FIELD,
    reply: (u) => {
      if (u.id) {
        lastReply.delete(thread);
        lastReply.set(thread, u.id);
        if (lastReply.size > MAX_THREADS) {
          lastReply.delete(lastReply.keys().next().value!);
        }
      }
      const row = missRow(u, !!prev, compacted);
      if (row) {
        diag({ kind: 'cache_miss', provider: 'claude', model, session, agent, ...row });
      }
    },
    rejected: () => {
      refused = true;
    },
  };
}

/** What the log says about a reply's cache use: a cause the API found, or an expired entry; undefined for hits. */
export function missRow(u: TappedUsage, compared: boolean, compacted: boolean): { level: 'info' | 'warn'; code: string; detail: string } | undefined {
  const read = u.usage.cache_read_input_tokens ?? 0;
  const write = u.usage.cache_creation_input_tokens ?? 0;
  const reason = u.diagnostics?.cache_miss_reason;
  // No comparison was made: the first request, a lost fingerprint, or one still pending.
  const code = reason?.type && reason.type !== 'previous_message_not_found' ? reason.type : compared && u.diagnostics === null && write >= EXPIRED_WRITE && read < write ? 'expired' : undefined;
  if (!code) {
    return undefined;
  }
  const edits = (u.appliedEdits ?? []).map((e) => `${e.type}${e.cleared_input_tokens ? ` (cleared ${formatTokens(e.cleared_input_tokens)})` : ''}`);
  const detail = [
    `wrote ${formatTokens(write)}, read ${formatTokens(read)}`,
    reason?.cache_missed_input_tokens ? `~${formatTokens(reason.cache_missed_input_tokens)} after the divergence` : '',
    edits.length ? `edits applied: ${edits.join(', ')}` : '',
    compacted ? 'after compaction' : '',
  ].filter(Boolean).join('; ');
  // Unexpected and costly: a changed prefix mid-conversation that rewrote a lot.
  const level = !compacted && code.endsWith('_changed') && write >= EXPIRED_WRITE ? 'warn' : 'info';
  return { level, code, detail };
}

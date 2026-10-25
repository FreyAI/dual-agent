/**
 * Reads what a /v1/messages reply cost while it streams past: the model that
 * answered and its token counts, from the `message_start` and `message_delta`
 * events (or the whole JSON body when not streamed), with the reply's id, its
 * cache diagnostics and the context edits the API applied. Request bodies are
 * never read here.
 */
import type { ApiUsage } from '../usage';

/** Why the prompt cache missed, when the request asked (proxy/cacheDiag.ts); null while the comparison was pending. */
export interface CacheDiagnostics { cache_miss_reason: { type: string; cache_missed_input_tokens?: number } | null }

export interface TappedUsage {
  model: string;
  usage: ApiUsage;
  id?: string;
  diagnostics?: CacheDiagnostics | null;
  /** Server-side context edits applied to this request (e.g. clear_tool_uses). */
  appliedEdits?: { type: string; cleared_input_tokens?: number }[];
}

/** Non-streamed replies past this are not parsed (their usage is lost, the reply isn't). */
const MAX_JSON = 8 * 1024 * 1024;

export function usageTap(streamed: boolean, done: (u: TappedUsage) => void) {
  let model = '';
  let id: string | undefined;
  let diagnostics: TappedUsage['diagnostics'];
  let appliedEdits: TappedUsage['appliedEdits'];
  let usage: ApiUsage = {};
  let pending = '';
  let size = 0;
  const merge = (u: ApiUsage | undefined) => {
    for (const [k, v] of Object.entries(u ?? {})) {
      if (typeof v === 'number') {
        (usage as Record<string, number>)[k] = v;
      }
    }
  };
  const message = (m: any) => {
    model = m?.model ?? model;
    id = m?.id ?? id;
    diagnostics = m?.diagnostics ?? diagnostics;
    appliedEdits = m?.context_management?.applied_edits ?? appliedEdits;
    merge(m?.usage);
  };
  const event = (line: string) => {
    if (!line.startsWith('data:') || !/"message_(start|delta)"/.test(line)) {
      return;
    }
    try {
      const d = JSON.parse(line.slice(5));
      if (d.type === 'message_start') {
        message(d.message);
      } else {
        appliedEdits = d.context_management?.applied_edits ?? appliedEdits;
        merge(d.usage);
      }
    } catch {
      // A malformed event: the counts so far stand.
    }
  };
  return {
    push(chunk: Buffer) {
      size += chunk.length;
      if (!streamed) {
        if (size <= MAX_JSON) {
          pending += chunk.toString('utf8');
        }
        return;
      }
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(event);
    },
    end() {
      if (streamed) {
        event(pending);
      } else if (size <= MAX_JSON) {
        try {
          message(JSON.parse(pending));
        } catch {
          // Not JSON: nothing to record.
        }
      }
      if (model) {
        done({ model, usage, ...(id ? { id } : {}), ...(diagnostics !== undefined ? { diagnostics } : {}), ...(appliedEdits ? { appliedEdits } : {}) });
      }
    },
  };
}

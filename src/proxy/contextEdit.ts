/**
 * Anthropic's server-side context editing for Claude sessions: old tool
 * results are cleared by the API once the input passes `trigger`, keeping the
 * last few, and only when at least `clearAtLeast` tokens go so the prompt
 * cache isn't broken for small gains. Claude Code itself sends only
 * clear_thinking; this merges tool clearing into its edits.
 * Anthropic measured -84% tokens on a 100-turn eval and +29% task performance.
 */
import type { AnthropicRequest } from './mask';

export interface ToolClearing {
  trigger: number;
  keep: number;
  clearAtLeast: number;
}

/** Each clear rewrites (re-caches) everything after the first cleared result, so clear rarely and in big batches. */
export const DEFAULT_TOOL_CLEARING: ToolClearing = { trigger: 100_000, keep: 6, clearAtLeast: 40_000 };

type Edit = { type: string; [k: string]: unknown };

export function withToolClearing(body: AnthropicRequest, opts: ToolClearing = DEFAULT_TOOL_CLEARING): AnthropicRequest {
  const current = (body as { context_management?: { edits?: Edit[] } }).context_management;
  // Only requests Claude Code already sends with context management (and its beta header); side requests stay as they are.
  if (!current) {
    return body;
  }
  const edits = (current?.edits ?? []).filter((e) => e.type !== 'clear_tool_uses_20250919');
  const clearing: Edit = {
    type: 'clear_tool_uses_20250919',
    trigger: { type: 'input_tokens', value: opts.trigger },
    keep: { type: 'tool_uses', value: opts.keep },
    clear_at_least: { type: 'input_tokens', value: opts.clearAtLeast },
  };
  // The API applies clear_thinking first when both are present.
  const ordered = [...edits.filter((e) => e.type.startsWith('clear_thinking')), clearing, ...edits.filter((e) => !e.type.startsWith('clear_thinking'))];
  return { ...body, context_management: { ...(current ?? {}), edits: ordered } } as AnthropicRequest;
}

/** How the agent's tool calls and finished replies are described in the chat. */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { PROVIDER_LABELS, ProviderId } from '../providers';
import { short } from '../text';
import { inputTokens } from '../usage';
import { TurnMetrics, inputSide } from '../metrics/turns';

/** Permission-card titles for this extension's own tools, which read better than their MCP names. */
const TITLES: Record<string, string> = {
  mcp__reuse__repo_import: 'Import code into this project?',
};

export function permissionTitle(toolName: string, fallback?: string): string {
  return TITLES[toolName] ?? fallback ?? `Allow ${toolName}?`;
}

/** One line for a tool call: its command, path, pattern or query. */
export function describeToolInput(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'TodoWrite' && Array.isArray(obj.todos)) {
    const done = obj.todos.filter((t: { status?: string }) => t?.status === 'completed').length;
    return `Plan: ${done}/${obj.todos.length} done`;
  }
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'symbol', 'description']) {
    if (typeof obj[key] === 'string') {
      return short(obj[key] as string, 400);
    }
  }
  return short(JSON.stringify(obj), 400);
}

/** What an edit or write would change, shown in the permission card. */
export function previewToolInput(input: Record<string, unknown>): string | undefined {
  if (typeof input.new_string === 'string') {
    const old = typeof input.old_string === 'string' ? input.old_string : '';
    const lines = [...old.split('\n').map((l) => `- ${l}`), ...input.new_string.split('\n').map((l) => `+ ${l}`)];
    return short(lines.join('\n'), 1500);
  }
  if (typeof input.content === 'string') {
    return short(input.content, 1500);
  }
  return undefined;
}

/** The error text a failed result carries, or a successful result's text. */
export function resultErrorText(result?: SDKResultMessage): string {
  if (!result) {
    return '';
  }
  return result.subtype === 'success' ? result.result : result.errors.join('; ');
}

/**
 * The line under a finished reply: provider, tokens (every model, helpers
 * included), cache share, cost when paid per token, tools, first token, time.
 */
export function summarize(provider: ProviderId, interrupted: boolean, result: SDKResultMessage | undefined, paysPerToken: boolean, metrics?: TurnMetrics): string {
  const parts = [PROVIDER_LABELS[provider]];
  if (interrupted) {
    parts.push('stopped');
  }
  const input = metrics ? inputSide(metrics.tokens) : result ? inputTokens(result.usage) : 0;
  const output = metrics ? metrics.tokens.output : (result?.usage.output_tokens ?? 0);
  if (input || output) {
    parts.push(`${input.toLocaleString()} in / ${output.toLocaleString()} out tokens`);
  }
  if (metrics && input && metrics.tokens.cacheRead) {
    parts.push(`${Math.round((metrics.tokens.cacheRead / input) * 100)}% cached`);
  }
  // This turn's cost from our price table. Claude Code's total_cost_usd is a
  // running session total and prices unknown models (DeepSeek) as Opus.
  if (paysPerToken && metrics && metrics.cost > 0) {
    parts.push(`$${metrics.cost.toFixed(4)}`);
  }
  if (metrics?.helperCalls) {
    parts.push(`helpers ${metrics.helperCalls} call${metrics.helperCalls === 1 ? '' : 's'}`);
  }
  const tools = metrics ? Object.values(metrics.tools) : [];
  const calls = tools.reduce((n, t) => n + t.calls, 0);
  const failed = tools.reduce((n, t) => n + t.errors, 0);
  if (calls) {
    parts.push(`${calls} tool${calls === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}`);
  }
  if (metrics?.ttftMs !== undefined) {
    parts.push(`first token ${(metrics.ttftMs / 1000).toFixed(1)}s`);
  }
  if (metrics?.unverified) {
    // Claims (tests pass, builds) with no run since the last edit: said here instead of sending the agent back.
    parts.push('not verified');
  }
  const ms = metrics?.durationMs ?? result?.duration_ms;
  if (ms !== undefined) {
    parts.push(`${(ms / 1000).toFixed(1)}s`);
  }
  return parts.join(' · ');
}

/** Shared helpers for the in-process MCP tools (web, code). */
import { errorMessage } from './text';
import { diag } from './diag/log';

export const reply = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], isError });

/** A tool's error message for the model, also logged as a tool_error row. */
export function toolFailed(tool: string, err: unknown): string {
  const message = errorMessage(err);
  diag({ kind: 'tool_error', code: tool, detail: message });
  return message;
}

/** A tool handler that returns its text, or the error as an error result (logged when `tool` is named). */
export const guarded =
  <A>(run: (args: A, extra?: unknown) => Promise<string> | string, tool?: string) =>
  async (args: A, extra?: unknown) => {
    try {
      return reply(await run(args, extra));
    } catch (err) {
      return reply(tool ? toolFailed(tool, err) : errorMessage(err), true);
    }
  };

/** The tool_use id Claude Code sends with each MCP call, to tie a call to the agent that made it. */
export const toolUseIdOf = (extra: unknown): string | undefined => {
  const id = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.['claudecode/toolUseId'];
  return typeof id === 'string' ? id : undefined;
};

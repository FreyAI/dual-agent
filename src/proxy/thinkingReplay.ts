/**
 * DeepSeek in thinking mode, with tools, rejects a request whose history has
 * an assistant turn without its thinking block: 400 "The `content[].thinking`
 * in the thinking mode must be passed back", and every later request in that
 * session fails the same way (Cline #14965). Turns written with thinking off
 * (Flash, before a switch to Thinking) or saved without it have none, so they
 * get a short placeholder. Measured 2026-10-20: missing → 400, placeholder → 200.
 * Not an empty string: many empty turns teach the model to stop reasoning
 * (claude-code-router #1378).
 */
import type { AnthropicRequest, Block } from './mask';

export const MISSING_THINKING = '(Earlier reasoning was not kept.)';

const placeholder = (): Block => ({ type: 'thinking', thinking: MISSING_THINKING, signature: '' });

/**
 * The request with a placeholder thinking block wherever one is missing, or
 * undefined when none was. Claude's `redacted_thinking` (history from a Claude
 * turn) is replaced on every request: DeepSeek has no such type (422, measured).
 */
export function keepThinking(body: AnthropicRequest): AnthropicRequest | undefined {
  if (!body.messages?.length) {
    return undefined;
  }
  const thinking = body.thinking as { type?: string } | undefined;
  const needed = thinking?.type !== 'disabled' && Array.isArray(body.tools) && body.tools.length > 0;
  let changed = false;
  const messages = body.messages.map((m) => {
    if (m.role !== 'assistant') {
      return m;
    }
    let content: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (content.some((b) => b?.type === 'redacted_thinking')) {
      content = content.map((b) => (b?.type === 'redacted_thinking' ? placeholder() : b));
      changed = true;
    } else if (needed && !content.some((b) => b?.type === 'thinking')) {
      content = [placeholder(), ...content];
      changed = true;
    } else {
      return m;
    }
    return { ...m, content };
  });
  return changed ? { ...body, messages } : undefined;
}

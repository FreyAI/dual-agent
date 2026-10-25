/**
 * Observation masking for Anthropic Messages requests, for providers without
 * server-side context editing (DeepSeek). Old tool results become a short
 * placeholder; tool calls and reasoning stay ("The Complexity Trap", arXiv 2508.21433).
 */

export interface MaskOptions {
  /** Most recent tool results always kept verbatim. */
  keepRecent: number;
  /** Masked set only grows in steps of this size, so the cached prefix stays stable. */
  batch: number;
  /** Results shorter than this are cheaper to keep than to re-run. */
  minChars: number;
}

export const DEFAULT_MASK: MaskOptions = { keepRecent: 8, batch: 10, minChars: 400 };

export type Block = { type: string; [key: string]: unknown };
export interface Message { role: string; content: string | Block[]; [key: string]: unknown }
export interface AnthropicRequest { messages?: Message[]; [key: string]: unknown }
export interface MaskResult { body: AnthropicRequest; maskedCount: number; savedChars: number }

const PREFIX = '[Old tool output';

export const placeholder = (lines: number, chars: number): string =>
  `${PREFIX} (${lines} lines, ${chars} chars) cleared to save context. Re-run the tool if you need it again.]`;

const toolResults = (m: Message): Block[] =>
  m.role === 'user' && Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'tool_result') : [];

/** Non-text blocks (images) count by serialized size so screenshots qualify as large. */
function measure(content: unknown): { text: string; chars: number } {
  if (typeof content === 'string') return { text: content, chars: content.length };
  if (!Array.isArray(content)) return { text: '', chars: 0 };
  const texts: string[] = [];
  let chars = 0;
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text);
      chars += b.text.length;
    } else {
      chars += JSON.stringify(b ?? null).length;
    }
  }
  return { text: texts.join('\n'), chars };
}

/** Index below which tool results may be masked; a pure function of the request (stateless proxy). */
export function maskBoundary(total: number, opts: MaskOptions): number {
  const batch = Math.max(1, Math.floor(opts.batch));
  return Math.floor(Math.max(0, total - opts.keepRecent) / batch) * batch;
}

/** Returns a new body with old, large tool results replaced; the input is never mutated. */
export function maskOldToolResults(body: AnthropicRequest, opts: Partial<MaskOptions> = {}): MaskResult {
  const o = { ...DEFAULT_MASK, ...opts };
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const boundary = maskBoundary(msgs.reduce((n, m) => n + toolResults(m).length, 0), o);
  if (!boundary) return { body, maskedCount: 0, savedChars: 0 };

  let lastUser = -1;
  msgs.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
  let index = 0;
  let maskedCount = 0;
  let savedChars = 0;
  const messages = msgs.map((m, i) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b?.type !== 'tool_result') return b;
      if (index++ >= boundary || i === lastUser) return b;
      const { text, chars } = measure(b.content);
      if (chars < o.minChars || text.startsWith(PREFIX)) return b;
      const note = placeholder(text ? text.split('\n').length : 0, chars);
      maskedCount++;
      savedChars += chars - note.length;
      changed = true;
      return { ...b, content: [{ type: 'text', text: note }] };
    });
    return changed ? { ...m, content } : m;
  });
  return maskedCount ? { body: { ...body, messages }, maskedCount, savedChars } : { body, maskedCount: 0, savedChars: 0 };
}

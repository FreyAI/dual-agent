/**
 * Claude Code adds tools mid-conversation as `tool_addition` blocks carrying a
 * full `tool_definition`. DeepSeek only accepts a `tool_reference` there and
 * answers 422 ("unknown variant `tool_definition`"). Claude Code falls back by
 * itself only on Anthropic's wording of that error, so the proxy does what the
 * fallback would: declare the tool in tools[] (deferred, so it loads by
 * reference) and point to it by name.
 *
 * It also writes `tool_removal` blocks when an inline tool goes away (e.g. the
 * claude.ai connectors after a switch from Claude), which DeepSeek has no type
 * for at all. Those are dropped, along with additions of tools removed for
 * good, so DeepSeek never sees a tool it can't call.
 */
import type { AnthropicRequest, Block } from './mask';

interface ToolDef { name?: unknown; [key: string]: unknown }
type ToolRef = { type?: string; name?: unknown; definition?: ToolDef };

const toolOf = (b: Block) => b?.tool as ToolRef | undefined;
const nameOf = (t: ToolRef | undefined) => (t?.type === 'tool_definition' ? t.definition?.name : t?.name);

/** The request with inline tools reshaped for DeepSeek, or undefined when there were none. */
export function declareInlineTools(body: AnthropicRequest): AnthropicRequest | undefined {
  // The tools still present after every addition and removal, in order.
  const live = new Map<unknown, ToolDef | undefined>();
  let found = false;
  for (const m of body.messages ?? []) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      const t = toolOf(b);
      if (b?.type === 'tool_addition') {
        found = true;
        live.set(nameOf(t), t?.type === 'tool_definition' ? t.definition : live.get(nameOf(t)));
      } else if (b?.type === 'tool_removal') {
        found = true;
        live.delete(nameOf(t));
      }
    }
  }
  if (!found) {
    return undefined;
  }
  const messages = body.messages!.flatMap((m) => {
    if (!Array.isArray(m.content) || !m.content.some((b: Block) => b?.type === 'tool_addition' || b?.type === 'tool_removal')) {
      return [m];
    }
    const content = m.content.flatMap((b: Block) => {
      if (b?.type === 'tool_removal' || (b?.type === 'tool_addition' && !live.has(nameOf(toolOf(b))))) {
        return [];
      }
      const t = toolOf(b);
      return t?.type === 'tool_definition' && typeof t.definition?.name === 'string' ? [{ ...b, tool: { type: 'tool_reference', name: t.definition.name } }] : [b];
    });
    return content.length ? [{ ...m, content }] : [];
  });
  const tools = Array.isArray(body.tools) ? [...(body.tools as ToolDef[])] : [];
  const names = new Set(tools.map((t) => t.name));
  for (const def of live.values()) {
    if (typeof def?.name === 'string' && !names.has(def.name)) {
      names.add(def.name);
      tools.push({ ...def, defer_loading: true });
    }
  }
  return { ...body, messages, tools };
}

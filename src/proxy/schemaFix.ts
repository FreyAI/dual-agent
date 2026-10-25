/**
 * DeepSeek compiles tool-schema `pattern`s with a regex engine that has no
 * `\0`: a claude.ai connector's Artifact tool (`^[^\0]*$`) got 400 "is not a
 * regex" (2026-10-20). `\x00` is the same character in both engines.
 */
import type { AnthropicRequest } from './mask';

/** The request with patterns DeepSeek can compile, or undefined when none needed it. */
export function fixPatterns(body: AnthropicRequest): AnthropicRequest | undefined {
  if (!Array.isArray(body.tools)) {
    return undefined;
  }
  let changed = false;
  const fix = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(fix);
    }
    if (!v || typeof v !== 'object') {
      return v;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (k !== 'pattern' || typeof x !== 'string') {
        return [k, fix(x)];
      }
      const p = x.replace(/\\0(?![0-7])/g, '\\x00');
      changed ||= p !== x;
      return [k, p];
    }));
  };
  const tools = fix(body.tools) as unknown[];
  return changed ? { ...body, tools } : undefined;
}

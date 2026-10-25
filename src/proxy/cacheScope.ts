/**
 * DeepSeek keeps a separate KV cache per `metadata.user_id`, and Claude Code
 * puts its session id there, so every new chat or relaunch paid full price for
 * the system prompt and tools again. Measured on deepseek-flash (2026-10-20):
 * a 6k-token prefix read 5,888 tokens from cache under the same user_id and 0
 * under another. One stable id lets every session share the cached prefix.
 */
import type { AnthropicRequest } from './mask';

/** Matches DeepSeek's user_id format ([a-zA-Z0-9_-]+). */
export const CACHE_USER_ID = 'dual-agent';

/** The request with the stable user_id, or undefined when there was none or it already had it. */
export function stableUserId(body: AnthropicRequest): AnthropicRequest | undefined {
  const meta = body.metadata as { user_id?: unknown } | undefined;
  if (meta?.user_id === undefined || meta.user_id === CACHE_USER_ID) {
    return undefined;
  }
  return { ...body, metadata: { ...meta, user_id: CACHE_USER_ID } };
}

/**
 * `bytes` (the JSON of `body`) with the stable user_id patched in place, as cacheDiag tags requests,
 * instead of serialising the whole conversation again for one field on every DeepSeek request.
 * Serialised again only when the field isn't found as written.
 */
export function stableUserIdBytes(bytes: Buffer, body: AnthropicRequest): Buffer {
  const id = (body.metadata as { user_id?: unknown } | undefined)?.user_id;
  if (id === undefined || id === CACHE_USER_ID) {
    return bytes;
  }
  // The value holds the session id, so nothing else in the body reads the same.
  const field = Buffer.from(`"user_id":${JSON.stringify(id)}`);
  const at = bytes.lastIndexOf(field);
  if (at < 0) {
    return Buffer.from(JSON.stringify(stableUserId(body)));
  }
  return Buffer.concat([bytes.subarray(0, at), Buffer.from(`"user_id":"${CACHE_USER_ID}"`), bytes.subarray(at + field.length)]);
}

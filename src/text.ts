/** Small string helpers used across the extension. */

/** `s` cut to at most `max` characters, ending in "…" when cut. */
export const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** An error's message, for logs and notices. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  // Node's fetch says only "fetch failed"; the reason (ENOTFOUND, ECONNRESET, a TLS error) is in `cause`.
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const why = cause && (cause.code ?? cause.message);
  return why && !err.message.includes(why) ? `${err.message} (${why})` : err.message;
}

/** Runs of whitespace collapsed to single spaces, trimmed. */
export const collapseSpace = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Key-shaped values (API keys, tokens, passwords) masked, for text kept in logs. */
const SECRETS: [RegExp, string][] = [
  [/\b(sk-ant-[\w-]{6})[\w-]{10,}/g, '$1…'],
  [/\b(sk-|ghp_|gho_|github_pat_|xox[abp]-|AKIA|AIza|tvly-|hf_)[\w-]{12,}/g, '$1…'],
  [/\b(Bearer\s+)[\w.~+/=-]{12,}/gi, '$1…'],
  [/\b([\w-]*(?:api[_-]?key|token|secret|password|passwd)[\w-]*\s*[=:]\s*["']?)[^\s"']{6,}/gi, '$1…'],
];
export const redactSecrets = (s: string) => SECRETS.reduce((t, [re, to]) => t.replace(re, to), s);
/** Holds a key-shaped value (sk-…, ghp_…, a bearer token); "token: string" in prose about code doesn't count. */
export const hasKeyShapedValue = (s: string) => SECRETS.slice(0, 3).some(([re]) => new RegExp(re.source, re.flags.replace('g', '')).test(s));

/** 950, 12k, 1.25M: as the chat panel shows token counts (media/chat/core.js formatTokens). */
export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  }
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/**
 * What to do when a provider fails: retry it (up to three times), switch to
 * the other provider, or report the error. Pure decisions, so the controller
 * only carries them out.
 */
import type { ProviderId } from '../providers';

/** Failures that retrying won't fix. */
const PERMANENT = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'model_not_found', 'cloud_credential_error'];

/**
 * Failures that mean "this provider can't serve you right now", as opposed to
 * a problem with the request itself. Only these trigger an automatic switch.
 */
const FALLBACK = new Set([...PERMANENT, 'rate_limit', 'overloaded', 'server_error', 'network', 'startup']);
const PERMANENT_SET = new Set(PERMANENT);
/** Failures a retry on the same provider won't fix: these switch at once (a bad request would resend the same body). */
const NO_RETRY = new Set([...PERMANENT, 'rate_limit', 'invalid_request', 'max_output_tokens']);

/** Whether a retry on the same provider could help. */
export const canRetry = (code: string) => !NO_RETRY.has(code);

/** Retries on the same provider before switching to the other one. */
export const MAX_RETRIES = 3;
/** The wait before each retry. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export const ERROR_DESCRIPTIONS: Record<string, string> = {
  authentication_failed: 'not signed in or the key was rejected',
  oauth_org_not_allowed: 'this account is not allowed to use Claude Code',
  account_on_hold: 'the account is on hold',
  verification_required: 'the account needs verification',
  billing_error: 'out of credit or a billing problem',
  rate_limit: 'usage limit reached',
  overloaded: 'the service is overloaded',
  server_error: 'the service returned an error',
  network: 'the connection to it timed out',
  model_not_found: 'the model name was not recognized',
  invalid_request: 'the request was rejected',
  max_output_tokens: 'the reply hit the output limit',
  cloud_credential_error: 'the cloud credentials were rejected',
  startup: 'the agent could not start',
};

export const describeError = (code: string) => ERROR_DESCRIPTIONS[code] ?? code;

/** The code an HTTP status means, for errors Claude Code reports as unknown. */
export function statusCode(status: number | null | undefined, noResponse = false): string | undefined {
  if (status === 400 || status === 422) {
    return 'invalid_request';
  }
  if (status === 401) {
    return 'authentication_failed';
  }
  // DeepSeek's "Insufficient Balance": retrying can't top it up.
  if (status === 402) {
    return 'billing_error';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  if (status === 529) {
    return 'overloaded';
  }
  if ((status && status >= 500) || (!status && noResponse)) {
    return 'server_error';
  }
  return undefined;
}

/** Claude Code reports another provider's errors (e.g. DeepSeek's 422) as unknown; the status, or "API Error: n" in the text, says what it is. */
export function errorCode(code: string | undefined, text = '', status?: number | null, noResponse = false): string {
  if (code && code !== 'unknown') {
    return code;
  }
  const fromText = /\bAPI Error: (\d{3})\b/.exec(text)?.[1];
  return statusCode(status ?? (fromText ? Number(fromText) : undefined), noResponse) ?? 'unknown';
}

/** The HTTP status in an error's text ("API Error: 529 …"), if any. */
export const statusIn = (text: string | undefined) => {
  const m = /\bAPI Error: (\d{3})\b/.exec(text ?? '');
  return m ? Number(m[1]) : undefined;
};

/** Sent to the next provider when the previous one stopped partway. */
export const CONTINUE_PROMPT = 'The previous provider stopped partway through this task. Continue it from where it left off.';
/** Sent on a retry or switch when the message already reached the model, so it is in the conversation once. */
export const ANSWER_PROMPT = 'The previous attempt failed with an error before answering. Answer my last message.';
/** Sent on a retry when the failed attempt had already done some of the work. */
export const RETRY_PROMPT = 'The previous attempt failed with an error partway through this task. Continue it from where it left off.';

/** The parts of a failed turn the decision depends on. */
export interface FailedTurn {
  provider: ProviderId;
  code: string;
  producedOutput: boolean;
  fallbackUsed: boolean;
  freshRetryUsed: boolean;
  /** The conversation was resumed from another provider or model. */
  resumedAcross: boolean;
  /** Retries already made on this provider for this message. */
  retries: number;
}

export type Recovery =
  | { kind: 'freshRetry' }
  | { kind: 'retry'; attempt: number; continuing: boolean }
  | { kind: 'switch'; to: ProviderId; continuing: boolean }
  | { kind: 'report' };

/**
 * After a turn failed: retry the same provider up to three times, then switch
 * to the other one (in any mode, once per message), then tell the user. Usage
 * limits and account problems switch at once, since retrying can't fix them.
 */
export function recover(turn: FailedTurn, otherConfigured: boolean): Recovery {
  // This provider refused history written by the other one (e.g. Claude-only thinking blocks).
  if (turn.resumedAcross && !turn.producedOutput && !turn.freshRetryUsed && turn.code === 'invalid_request') {
    return { kind: 'freshRetry' };
  }
  if (!NO_RETRY.has(turn.code) && turn.retries < MAX_RETRIES) {
    return { kind: 'retry', attempt: turn.retries + 1, continuing: turn.producedOutput };
  }
  if (!turn.fallbackUsed && otherConfigured) {
    // Work already done is in the resumed conversation, so the next provider carries on.
    return { kind: 'switch', to: turn.provider === 'claude' ? 'deepseek' : 'claude', continuing: turn.producedOutput };
  }
  return { kind: 'report' };
}

/**
 * Whether to stop Claude Code's own retries now. Errors retrying can't fix stop
 * at once in every mode. In auto mode the other provider is a better bet than
 * waiting: usage limits switch at once, outages after a few tries.
 */
export function stopRetrying(code: string, attempt: number, canSwitch: boolean): boolean {
  if (PERMANENT_SET.has(code)) {
    return true;
  }
  const transient = code === 'overloaded' || code === 'server_error' || code === 'network';
  return canSwitch && FALLBACK.has(code) && !(transient && attempt < 3);
}

/** When a failed provider may be tried again. */
export function pauseUntil(resetsAt: number | undefined, cooldownMinutes: number, now = Date.now()): number {
  if (resetsAt) {
    // Accept either epoch seconds or epoch milliseconds.
    return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  }
  return now + cooldownMinutes * 60_000;
}

/** What the user can do about a failure, appended to the error notice. */
export function hint(provider: ProviderId, code: string): string {
  if (provider === 'claude' && code === 'authentication_failed') {
    return ' Run "Dual Agent: Sign In to Claude", or set a DeepSeek key so auto mode can fall back.';
  }
  if (provider === 'deepseek' && (code === 'authentication_failed' || code === 'startup')) {
    return ' Check your key with "Dual Agent: Set DeepSeek API Key".';
  }
  if (provider === 'deepseek' && code === 'model_not_found') {
    return ' Check the "dualAgent.deepseek.model" setting.';
  }
  return '';
}

/**
 * An advisor for a fast main agent: DeepSeek Flash works, V4 Pro advises at
 * the points that decide a task (the plan, being stuck, before "done"). After
 * Aider's architect/editor split (+5 points) and Anthropic's advisor tool
 * (+2.7 points, -11.9% cost). DeepSeek has no server-side advisor, so this is
 * our own tool: one uncached call with the brief the agent writes, which is
 * why it asks for a compact one.
 */
import type * as Sdk from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { z } from 'zod';
import { guarded } from '../mcp';
import { short } from '../text';

export const ADVISOR_TOOL = 'mcp__advisor__ask_advisor';

/** Added to the main agent's rules when the advisor is on. */
export const ADVISOR_RULE =
  'Advisor: ask_advisor consults a stronger model. Call it when planning a change across several files, after two failed attempts at the same problem, and before declaring a hard task done. Give it a compact brief: the goal, what you found (file:line), what you tried and the exact errors, and your question. It sees only what you send.';

const SYSTEM =
  'You advise a coding agent that does the work. Answer its question directly: the likely cause or the plan, the specific files and steps, and what to check. Be concrete and brief (under 300 words). Say so when the brief lacks what you need.';

export interface AdvisorCall {
  /** Anthropic-compatible base URL, e.g. https://api.deepseek.com/anthropic. */
  baseUrl: string;
  key: string;
  model: string;
  timeoutMs?: number;
}

/** One question to the advisor model; the answer's text. */
export async function askAdvisor(call: AdvisorCall, question: string, context: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${call.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': call.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: call.model,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `${question}\n\n${context}` }],
    }),
    signal: AbortSignal.timeout(call.timeoutMs ?? 120_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`advisor HTTP ${res.status}: ${short(text, 200)}`);
  }
  const body = JSON.parse(text) as { content?: { type: string; text?: string }[] };
  const answer = (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  if (!answer) {
    throw new Error('the advisor gave no answer');
  }
  return answer;
}

export function createAdvisorServer(sdk: typeof Sdk, call: AdvisorCall) {
  const ask = sdk.tool(
    'ask_advisor',
    'Consult a stronger model on a plan, a stuck problem, or before finishing a hard task. It sees only what you send: give the goal, findings with file:line, attempts and exact errors (under ~2,000 words).',
    {
      question: z.string().min(3).describe('What you want advice on'),
      context: z.string().max(16_000).describe('Goal, findings (file:line), what you tried, exact errors'),
    },
    guarded(({ question, context }: { question: string; context: string }) => askAdvisor(call, question, context), 'ask_advisor'),
  );
  return sdk.createSdkMcpServer({ name: 'advisor', version: '1.0.0', timeout: 150_000, tools: [ask] });
}

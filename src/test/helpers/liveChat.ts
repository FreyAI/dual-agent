/**
 * A chat against the real providers for the live tests: sends a message, waits
 * for the reply, answers cards the way the test asks, and keeps the log.
 */
import { fakeSecrets } from './vscodeStub';
import { AgentController, ToWebview } from '../../agentController';
import { Credentials } from '../../providers';
import type { TurnMetrics } from '../../metrics/turns';

export interface LiveTurn {
  reply: string;
  providers: string[];
  notices: string[];
  /** Tool calls made this turn, by name. */
  tools: string[];
  summary: string;
  posted: ToWebview[];
  /** Metrics from this turn's 'done' message, when it carried them. */
  metrics?: TurnMetrics;
}

export interface LiveChatOptions {
  /** Answer permission cards with Allow. */
  allow?: boolean;
  /** Approve plan cards. */
  approvePlans?: boolean;
  /** Answer the agent's questions with each question's first option. */
  answerQuestions?: boolean;
  secrets?: Record<string, string>;
  /** How long ask() waits for a reply to finish (default 5 minutes). */
  timeoutMs?: number;
  /** Skip the console echo (the eval prints its own progress). */
  quiet?: boolean;
}

/** Starts a headless controller in `project`, driven by ask(). */
export function liveChat(project: string, opts: LiveChatOptions = {}) {
  const posted: ToWebview[] = [];
  const log: string[] = [];
  const controller: AgentController = new AgentController(
    new Credentials(fakeSecrets(opts.secrets ?? {}) as any),
    {
      append() {},
      appendLine: (l: string) => {
        log.push(l);
        if (!opts.quiet) console.log(`    [log] ${l.slice(0, 300)}`);
      },
    } as any,
    (m) => {
      posted.push(m);
      if (!opts.quiet && (m.type === 'permission' || m.type === 'question' || m.type === 'planReview')) {
        const card = m as { title?: string; preview?: string };
        console.log(`    [card] ${m.type}: ${card.title ?? ''}${card.preview ? `\n      ${card.preview.slice(0, 500).replace(/\n/g, '\n      ')}` : ` ${JSON.stringify(m).slice(0, 200)}`}`);
      }
      if (m.type === 'permission' && opts.allow) {
        setTimeout(() => controller.answerPermission(m.id, 'allow'), 10);
      }
      if (m.type === 'question' && opts.answerQuestions) {
        const answers = Object.fromEntries(m.questions.map((q) => [q.question, q.options[0]?.label ?? '']));
        setTimeout(() => controller.answerQuestion(m.id, { answers }), 10);
      }
      if (m.type === 'planReview' && opts.approvePlans) {
        setTimeout(() => controller.decidePlan(m.id, true), 10);
      }
    },
    () => {},
    () => project,
  );

  /** Waits until no reply is running. */
  const idle = async (ms = 300_000) => {
    const end = Date.now() + ms;
    while (controller.busy) {
      if (Date.now() > end) {
        throw new Error(`still busy after ${Math.round(ms / 60_000)} minutes`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  /**
   * Waits for a message the agent may only send in a later reply, e.g. after a
   * background helper finishes and Claude Code starts a follow-up on its own.
   */
  const until = async <T extends ToWebview>(pred: (m: ToWebview) => m is T, ms = 480_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const found = posted.find(pred);
      if (found) {
        return found;
      }
      if (Date.now() > end) {
        throw new Error(`not seen within ${Math.round(ms / 60_000)} minutes; messages: ${[...new Set(posted.map((m) => m.type))].join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  /** Sends a message and returns that turn once it (and any fallback) is done. */
  const ask = async (text: string, extra: { includeEditor?: boolean; display?: string } = {}): Promise<LiveTurn> => {
    const mark = posted.length;
    await controller.send({ text, attachments: [], includeEditor: !!extra.includeEditor, display: extra.display });
    await idle(opts.timeoutMs);
    const turn = posted.slice(mark);
    const result: LiveTurn = {
      reply: turn.filter((m) => m.type === 'delta').map((m: any) => m.text).join('').trim(),
      providers: turn.filter((m) => m.type === 'assistantStart').map((m: any) => m.provider),
      notices: turn.filter((m) => m.type === 'notice').map((m: any) => `${m.level}: ${m.text}`),
      tools: turn.filter((m) => m.type === 'tool').map((m: any) => m.name),
      summary: (turn.filter((m) => m.type === 'done').at(-1) as any)?.summary ?? '',
      posted: turn,
      metrics: (turn.filter((m) => m.type === 'done').at(-1) as any)?.metrics,
    };
    if (!opts.quiet) console.log(
      `    ${result.providers.join(' → ')}: "${result.reply.slice(0, 160).replace(/\n/g, ' ')}"  (${result.summary})` +
        (result.tools.length ? `\n    tools: ${result.tools.join(', ')}` : '') +
        (result.notices.length ? `\n    notices: ${result.notices.join(' | ')}` : ''),
    );
    return result;
  };
  return { controller, ask, idle, until, posted, log };
}

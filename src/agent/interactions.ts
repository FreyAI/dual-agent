/**
 * The cards that wait for the user: permission to run a tool, the agent's
 * questions, and plan review. Each card is a pending promise the SDK's
 * canUseTool callback waits on, settled by the user's answer or by a cancel.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { PermissionDecision, ToWebview } from '../protocol';
import { QuestionAnswers, answeredInput, normalizeQuestions } from '../questions';
import { describeToolInput, permissionTitle, previewToolInput } from './present';
import { resolvedPath } from '../paths';

/** Tools that write files; their writes into a plans folder are the plan. */
export const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit'];

const EDITED_PLAN = 'The user edited the plan. Follow this plan instead:\n';

/** The plan the user edited, as numbered lines; rides in decidePlan's feedback on an approve. */
export function editedPlanText(steps: string[]): string {
  const clean = steps.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return EDITED_PLAN + clean.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

type PlanDecision = { approve: boolean; feedback?: string };

export class Interactions {
  private permissions = new Map<string, (decision: PermissionDecision) => void>();
  /** Called with undefined when the request is cancelled. */
  private questions = new Map<string, (reply: QuestionAnswers | undefined) => void>();
  private plans = new Map<string, (decision: PlanDecision | undefined) => void>();
  /** The plan file the agent wrote this turn: Claude Code keeps the plan in a file, not in ExitPlanMode's input. */
  private planFile?: string;
  /** What the agent has written this turn, the plan's last resort. */
  private turnText = '';
  private turnStartedAt = 0;

  constructor(
    private readonly post: (msg: ToWebview) => void,
    private readonly log: (line: string) => void,
    /** Claude Code's plans folders (main and keyless config). */
    private readonly planDirs: () => string[],
    /** The user approved a plan: leave plan mode. */
    private readonly onPlanApproved: () => void,
    /** What a permission card shows for a tool, when the tool knows better than its raw input. */
    private readonly preview: (tool: string, input: Record<string, unknown>) => string | undefined = () => undefined,
  ) {}

  /** Forgets the previous turn's plan and text. */
  startTurn() {
    this.planFile = undefined;
    this.turnText = '';
    this.turnStartedAt = Date.now();
  }

  noteText(text: string) {
    this.turnText += text;
  }

  noteToolUse(name: string, input: Record<string, unknown>) {
    const file = input.file_path;
    if (EDIT_TOOLS.includes(name) && typeof file === 'string' && file.endsWith('.md') && this.planDirs().map(resolvedPath).includes(resolvedPath(path.dirname(file)))) {
      this.planFile = file;
    }
  }

  /** The canUseTool callback: questions and plans get their own cards, everything else a permission card. */
  ask(toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; title?: string }): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') {
      return this.askQuestions(input, opts.signal);
    }
    if (toolName === 'ExitPlanMode') {
      return this.reviewPlan(input, opts.signal);
    }
    const id = randomUUID();
    this.post({
      type: 'permission',
      id,
      title: permissionTitle(toolName, opts.title),
      detail: describeToolInput(toolName, input),
      preview: this.preview(toolName, input) ?? previewToolInput(input),
      canAlways: !!opts.suggestions?.length,
    });
    return this.pending(this.permissions, id, opts.signal, 'deny', (decision: PermissionDecision) => {
      this.post({ type: 'permissionResolved', id, decision });
      return decision === 'deny'
        ? { behavior: 'deny', message: 'The user declined this action.' }
        : { behavior: 'allow', updatedInput: input, updatedPermissions: decision === 'always' ? opts.suggestions : undefined };
    });
  }

  answerPermission(id: string, decision: PermissionDecision) {
    this.permissions.get(id)?.(decision);
  }

  /** A card of our own (not the agent's): the option the user picked or typed, or undefined when skipped or cancelled (Stop). */
  choose(question: string, header: string, options: { label: string; description: string }[]): Promise<string | undefined> {
    const questions = [{ question, header, options, multiSelect: false }];
    const id = randomUUID();
    this.post({ type: 'question', id, questions });
    return this.pending(this.questions, id, new AbortController().signal, undefined, (reply: QuestionAnswers | undefined) => {
      const answer = reply?.answers[question]?.trim() || undefined;
      this.post({ type: 'questionResolved', id, questions, answers: answer ? reply!.answers : undefined, skipped: !answer });
      return answer;
    });
  }

  /** The user's choices for a question card, or undefined to skip it. */
  answerQuestion(id: string, reply: QuestionAnswers | undefined) {
    this.questions.get(id)?.(reply);
  }

  decidePlan(id: string, approve: boolean, feedback?: string) {
    this.plans.get(id)?.({ approve, feedback });
  }

  /** Cancels every open card (the turn ended or was stopped). */
  cancelAll() {
    [...this.permissions.values()].forEach((settle) => settle('deny'));
    [...this.questions.values()].forEach((settle) => settle(undefined));
    [...this.plans.values()].forEach((settle) => settle(undefined));
  }

  /** A card is waiting for the user. */
  get waiting(): boolean {
    return this.permissions.size + this.questions.size + this.plans.size > 0;
  }

  /** Registers a card and resolves once, with the user's answer or `onCancel` when aborted. */
  private pending<D, R = PermissionResult>(cards: Map<string, (d: D) => void>, id: string, signal: AbortSignal, onCancel: D, settle: (d: D) => R) {
    return new Promise<R>((resolve) => {
      const done = (d: D) => {
        if (cards.delete(id)) {
          resolve(settle(d));
        }
      };
      cards.set(id, done);
      if (signal.aborted) {
        done(onCancel);
        return;
      }
      signal.addEventListener('abort', () => done(onCancel), { once: true });
    });
  }

  /**
   * Shows the agent's questions as a card and waits for the user's choices.
   * The answers go back inside the tool input, which is how AskUserQuestion
   * receives them; just allowing the tool would leave it with no answer.
   */
  private askQuestions(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const parsed = normalizeQuestions(input);
    if ('error' in parsed) {
      this.log(`AskUserQuestion input unusable (${parsed.error}): ${JSON.stringify(input).slice(0, 500)}`);
      return Promise.resolve({
        behavior: 'deny',
        message: `The question could not be shown to the user: ${parsed.error}. Ask again with AskUserQuestion using {"questions":[{"question":"...?","header":"short","multiSelect":false,"options":[{"label":"...","description":"..."},{"label":"...","description":"..."}]}]}, or ask in plain text.`,
      });
    }
    const { questions } = parsed;
    const id = randomUUID();
    this.post({ type: 'question', id, questions });
    return this.pending(this.questions, id, signal, undefined, (reply: QuestionAnswers | undefined) => {
      const answered = !!reply && questions.some((q) => reply.answers[q.question]?.trim());
      this.post({ type: 'questionResolved', id, questions, answers: answered ? reply!.answers : undefined, skipped: !answered });
      return answered
        ? { behavior: 'allow', updatedInput: answeredInput(input, questions, reply!) }
        : { behavior: 'deny', message: 'The user chose not to answer. Continue with your best judgment, or ask in plain text if you must.' };
    });
  }

  /**
   * The plan to show for approval. ExitPlanMode's input no longer carries it:
   * Claude Code has the agent write it to a file in a plans folder. Use, in
   * order: a plan in the input (older versions), the plan file the agent wrote
   * this turn, a plan file written since the turn began, then the reply text.
   */
  private findPlan(input: Record<string, unknown>): string {
    if (typeof input.plan === 'string' && input.plan.trim()) {
      return input.plan;
    }
    const read = (file: string | undefined) => {
      try {
        return file ? fs.readFileSync(file, 'utf8').trim() : '';
      } catch {
        return '';
      }
    };
    const recent = this.planDirs()
      .flatMap((dir) => {
        try {
          return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
        } catch {
          return [];
        }
      })
      .map((f) => {
        try {
          return { f, t: fs.statSync(f).mtimeMs };
        } catch {
          // Deleted between listing and reading.
          return { f, t: 0 };
        }
      })
      .filter((x) => x.t >= this.turnStartedAt)
      .sort((a, b) => b.t - a.t)[0]?.f;
    return read(this.planFile) || read(recent) || this.turnText.trim() || '(The agent did not write its plan down. Send it back and ask it to describe the plan.)';
  }

  /** Plan mode's "ready to start?" step: show the plan, approve it or send feedback. */
  private reviewPlan(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const plan = this.findPlan(input);
    const id = randomUUID();
    this.post({ type: 'planReview', id, plan });
    return this.pending(this.plans, id, signal, undefined, (decision: PlanDecision | undefined) => {
      const approved = !!decision?.approve;
      const feedback = decision?.feedback?.trim() || undefined;
      const edited = approved && feedback?.startsWith(EDITED_PLAN.trim()) ? feedback : undefined;
      this.post({ type: 'planResolved', id, plan: edited ? edited.slice(EDITED_PLAN.length) : plan, approved, feedback: edited ? undefined : feedback });
      if (approved) {
        this.onPlanApproved();
        // Allow can't carry text to the agent, so an edited plan goes back as a message on a denied call; plan mode is already left.
        return edited
          ? { behavior: 'deny', message: `The user approved the plan with edits and plan mode is off, so start now; do not call ExitPlanMode again. ${edited}` }
          : { behavior: 'allow', updatedInput: input };
      }
      return {
        behavior: 'deny',
        message: feedback ? `The user wants changes to the plan before you start: ${feedback}` : 'The user is not ready to start yet. Keep planning; do not make changes.',
      };
    });
  }
}

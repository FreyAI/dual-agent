/**
 * Questions the agent asks the user (Claude Code's AskUserQuestion tool).
 *
 * The tool reaches the extension as a permission request. Allowing it is not
 * enough: the user's choices must go back in the tool input as `answers`
 * (question text -> chosen label, several labels comma-separated), or the
 * agent hears "no answer". Models, DeepSeek especially, don't always produce
 * the exact shape, so questions are normalized before they're shown.
 */

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** What the chat sends back: one answer per question text, and optional notes. */
export interface QuestionAnswers {
  answers: Record<string, string>;
  notes?: Record<string, string>;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** The "Other" choice is the chat's own; a model-supplied one would be a duplicate. */
const isOther = (label: string) => /^(other|something else|none of (the|these) ?(above)?)\b/i.test(label);

function option(raw: unknown): QuestionOption | undefined {
  if (typeof raw === 'string') {
    return raw.trim() ? { label: raw.trim(), description: '' } : undefined;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const label = text(o.label ?? o.title ?? o.name ?? o.value ?? o.text);
    if (!label) {
      return undefined;
    }
    const preview = text(o.preview);
    return { label, description: text(o.description ?? o.desc ?? o.detail), ...(preview ? { preview } : {}) };
  }
  return undefined;
}

/** A short chip label from the question when the model gave none (max 12 characters, like the tool asks). */
function headerFrom(question: string): string {
  const words = question.replace(/[?.!:]+$/, '').split(/\s+/).filter((w) => !/^(which|what|how|do|does|should|would|you|we|the|a|an|to|i|is|are|for|of|your)$/i.test(w));
  const h = (words.slice(0, 2).join(' ') || 'Question').slice(0, 12);
  return h[0].toUpperCase() + h.slice(1);
}

/**
 * Turns whatever the model sent into 1–4 well-formed questions with 2–4
 * options each, or an explanation of what was wrong.
 */
export function normalizeQuestions(input: unknown): { questions: Question[] } | { error: string } {
  let raw: unknown = input && typeof input === 'object' ? (input as Record<string, unknown>).questions : undefined;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: 'the questions were not valid JSON' };
    }
  }
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    raw = [raw];
  }
  if (!Array.isArray(raw) || !raw.length) {
    return { error: 'no questions were given' };
  }
  const questions: Question[] = [];
  const seen = new Set<string>();
  for (const q of raw.slice(0, 4)) {
    if (!q || typeof q !== 'object') {
      continue;
    }
    const r = q as Record<string, unknown>;
    const question = text(r.question ?? r.text ?? r.prompt);
    if (!question || seen.has(question)) {
      continue;
    }
    const labels = new Set<string>();
    const options = (Array.isArray(r.options) ? r.options : [])
      .map(option)
      .filter((o): o is QuestionOption => !!o && !isOther(o.label) && !labels.has(o.label) && !!labels.add(o.label))
      .slice(0, 4);
    if (options.length < 2) {
      continue;
    }
    seen.add(question);
    questions.push({
      question,
      header: (text(r.header) || headerFrom(question)).slice(0, 12),
      options,
      multiSelect: r.multiSelect === true || r.multiSelect === 'true' || r.multi_select === true,
    });
  }
  if (!questions.length) {
    return { error: 'each question needs a question text and at least two options' };
  }
  return { questions };
}

/** The tool input with the user's answers filled in, as Claude Code expects. */
export function answeredInput(input: Record<string, unknown>, questions: Question[], reply: QuestionAnswers): Record<string, unknown> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const a = reply.answers[q.question]?.trim();
    if (a) {
      answers[q.question] = a;
    }
  }
  const annotations: Record<string, { notes: string }> = {};
  for (const [question, notes] of Object.entries(reply.notes ?? {})) {
    if (notes.trim() && questions.some((q) => q.question === question)) {
      annotations[question] = { notes: notes.trim() };
    }
  }
  return {
    ...input,
    // Send back the cleaned questions, so the answers' keys match them exactly.
    questions,
    answers,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}

/** Told to the agent so it asks with the tool, in the right shape, rather than in its reply. */
export const QUESTION_INSTRUCTIONS = `When you need the user to choose between options, call the AskUserQuestion tool instead of writing the choices in your reply. Its input is {"questions": [{"question": "...?", "header": "max 12 chars", "multiSelect": false, "options": [{"label": "1-5 words", "description": "what choosing it means"}, ...]}]}: 1-4 questions, each with 2-4 options. Don't add an "Other" option; the user can always type their own answer. Never print this JSON in your message.`;

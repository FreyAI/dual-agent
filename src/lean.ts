/**
 * Token discipline for the agents: terse replies, lean coding habits, compact
 * helper reports, and compression of memory files (CLAUDE.md and the like).
 */
import * as path from 'path';

export type ReplyStyle = 'off' | 'lite' | 'full' | 'ultra';

const REPLY_CORE = `# Reply style: terse
Replies cost tokens and are read in a narrow panel, so say each thing once and plainly.
- Lead with the answer; the reason and the next step come after it. Skip openers, sign-offs, recaps of what you just said and softening words.
- Prefer common words. Well-known abbreviations (API, URL, CI) are fine; don't coin new ones.
- Copy code, commands, file paths, names, numbers and error messages exactly; for an error, quote only the line that matters. To show a change, give the edited lines with a line or two around them, not the whole file.
- Keep every negation and limit (not, never, no, only, except). If shortening a sentence could change its meaning, leave it whole.
- Stay quiet through routine tool calls: one line before a long run, one when the plan changes, one with the outcome.
- Don't mention the style itself or decorate replies with tables or emoji they don't need. Answer in the language the user writes in.
Write normally for security or data-loss warnings, actions that can't be undone (ask first), steps whose order matters, questions to the user, and a user who seems lost. Files you write (code, comments, commit messages, docs, memory files) follow their usual conventions; leave existing comments as they are.`;

const REPLY_LEVELS: Record<Exclude<ReplyStyle, 'off'>, string> = {
  lite: 'Level: lite. Normal sentences with the padding removed.',
  full: 'Level: full. Sentence fragments are fine and articles can go, as long as each line reads cleanly the first time. E.g. "Off-by-one in `paginate()`: loop stops at `len - 1`. Fix below."',
  ultra: 'Level: ultra. The shortest form that stays clear: single words where they work, nothing repeated, no wrap-up. Keep words like "then" and "before" when order matters. E.g. "Done. Tests pass."',
};

/** System-prompt text for the chosen reply style; empty when it is off. */
export function replyStyleInstructions(style: ReplyStyle): string {
  return style === 'off' ? '' : `${REPLY_CORE}\n${REPLY_LEVELS[style] ?? REPLY_LEVELS.full}`;
}

/**
 * Coding habits that keep the work, and the context it fills, small, and the
 * code reusable. Sources for each rule are in reports/Efficient coding rules.md.
 */
export function leanWorkflowInstructions(helpers: boolean): string {
  return [
    '# Working efficiently',
    'Tool output is most of a task\'s cost: spend tokens on the change, not around it.',
    'Reuse: before writing a function, type, constant or component, search (code_map, then Grep). Import what fits; extend what almost fits in its own module; never a parallel file or near-copy. Types, constants and schemas have one home. Follow nearby patterns and names; no new libraries unless asked. No abstractions for one-time use; extract on the third copy (propose it if out of scope). Before finishing, run find_duplicates on files you created or heavily changed.',
    'Reading: narrow down (code_map/Grep/Glob → code_outline → ~100-line Reads), starting from names, errors and tests the task mentions. Grep for literal text; code_definition and code_references for symbols, and trust them. Read the tests of code you touch. Before renaming, deleting or changing a signature: code_references plus Grep. Odd code exists for a reason: check git log -L or blame first. Note files and lines that matter; never re-read unchanged files or claim things about code you haven\'t opened. Batch independent calls; keep command output short (quiet flags, tail, grep FAIL|ERROR).',
    SHARED_NOTES_RULE,
    helpers ? DELEGATION_INSTRUCTIONS : undefined,
    'Changing: unknown cause → evidence before edits, one mechanism must explain it. Fix at the narrowest layer that owns the bug; no drive-by cleanup or renames. Features: define done, build one complete narrow path, skip unrequested options. Targeted edits, whole-file rewrites only for new or mostly changed files. After edits: code_problems or the fast lint/type check, then affected tests. Plan only when the diff takes more than a sentence; after two failed fixes, re-plan.',
    'New projects: use the ecosystem\'s generator; then layout → interfaces → failing tests → implementation, one thin path first.',
    'Tests: from requirements, one behavior each, confirm they fail first when behavior is specified. Never weaken, skip or special-case tests; if one looks wrong, say why. Report pass/fail/not run exactly; stop when criteria pass.',
    'Comments: only why and constraints, briefly; never narrate code or the edit; don\'t touch comments on unchanged code; match the file\'s density.',
    'Reviews: does the change belong? Main part first, design issues first; bar = better code health. One line per finding: `path:L42: 🔴 bug|🟡 risk|🔵 nit|❓ q: problem. Fix.`; flag duplication; security and architecture get a paragraph.',
    'Commits: Conventional Commits, `type(scope): imperative summary` ≤72 chars; body only for a non-obvious why, breaking change, migration or security fix; follow the repo\'s convention.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Orchestrator-worker delegation, after Anthropic's multi-agent research system
 * (parallel helpers with self-contained briefs, effort scaled to the task) and
 * Cognition's "Don't build multi-agents" (parallel writers conflict; share the
 * context). Helpers run on cheaper models, so delegating also saves tokens.
 */
export const DELEGATION_INSTRUCTIONS =
  'Delegating: when a task has 2+ independent parts (separate files or modules, research plus code, several questions), plan them with TodoWrite, then start helpers for those parts in ONE message (parallel Agent calls with run_in_background: false, so you wait and their reports come back together in this turn; run_in_background: true only for jobs over ~5 minutes, since each background report starts another turn of yours) and do the part that needs this conversation yourself. Each brief stands alone and is sized to finish in about 30 steps: pick the helper (subagent_type) for the job, then give the goal, files and lines already known (notes_add them first so every helper can notes_read them), conventions and constraints, the done check, and two required lines: "Edit only: <files or globs>" (or "Edit only: none" for research) and "Read first: <files, optionally file:lines>". Edits outside the scope are refused and reports are capped at ~1,500 tokens, so give each helper only the files its job needs. Parallel helpers never edit the same file; dependent steps stay in order; you integrate, review the diff and run the tests. Cost: every new helper re-reads its brief and files at full price, so delegate only parts worth that (not single lookups), start only a few at once (a limit is enforced) and the next ones as those finish, give one helper related work instead of several small ones, and use isolation: "worktree" only when two helpers must edit the same files (worktree helpers cannot share a cache). After starting background helpers, end your turn: each reports back when it finishes; do not wait, sleep or poll. When a helper reports while others are still running, answer in one line (what it did, any blocker) and end the turn; review the diffs and run the tests once, after the last one reports, unless a report changes what the others should do (each early review re-reads this whole conversation). searcher: locate code fast, returns paths with line ranges only; quick-helper: search, read, summarize, run commands, well-specified edits; deep-thinker: hard diagnosis or design. Do single lookups and one-file changes yourself.';

/** Claude as the main agent: its tokens are the dear ones, so it leads and the helpers (DeepSeek, or Sonnet/Haiku) do the work. */
export const LEAD_RULE =
  'Leading: your helpers run on much cheaper models than you (DeepSeek, or Sonnet/Haiku), so your own steps are the costly ones. Plan, then delegate every well-defined part: changes in named files, test and build runs, searches and reading across the code, summaries. Keep for yourself the decisions, the briefs, integration and the final review of diffs and test results.';

/** In every agent's rules: reports are checked against the work (agent/verify.ts), and the user relies on them. */
export const VERIFY_RULE =
  'Test every change you made, not just one: run the full suite, or tests that cover each changed part, and add a test for each new behavior including its failure path. Code you write fails safe: errors at boundaries (I/O, network, parsing, processes) are handled with timeouts and clear messages, never swallowed. Read failures in tool output even when the exit code is 0 (pipes hide it). Report only what you did and checked: name the tests or build you ran and their result; say plainly what you did not run, verify or finish ("not tested live", "not built"). Mark a to-do completed only when it is done and checked. Never pass on a helper\'s "done" without checking its diff or test run.';

/**
 * Agents share one notes board (code tools), so each one doesn't rebuild the same picture of the code.
 * Commands and pitfalls change what agents do; overviews of how code flows cost tokens and don't (arXiv 2602.11988).
 */
export const SHARED_NOTES_RULE =
  "Shared notes: before exploring an area, notes_read it. When you learn something another agent would otherwise get wrong or work out again, notes_add it in 1-3 lines with its files and kind: a command that worked (and what it writes), a gotcha, a decision the code doesn't show, or where something lives. No overviews of how code flows; a failure only as a one-line gotcha (what looked right, what is true), never as steps to repeat. A helper's note stays a proposal until a build or test it ran passes; notes_add the same title to confirm one you checked. Facts about the user and how they like to work go in Claude Code's own memory, not in notes.";

/** Added to helper agents' prompts: their reports are read by the main agent, not a person. */
export const HELPER_REPORT_INSTRUCTIONS =
  'Your report goes to the main agent, not to a person: give findings, file paths with line numbers and exact error lines. ' +
  'No preamble, no recap, no restating the job; fragments are fine. Quote code only when the main agent needs the exact text.';

export const QUICK_HELPER_LEAN =
  "Do only the job you are given; don't fix or improve anything else. Find code with code_map, Grep or Glob, use code_outline before opening a large file, and read the ranges you need.";
export const DEEP_THINKER_LEAN =
  "Separate the observed symptom from the inferred cause, rank hypotheses by evidence, and don't conclude until one mechanism explains the evidence. Report the cause and the proof.";

// ---------------------------------------------------------------------------
// Memory-file compression

const PROSE_EXTENSIONS = new Set(['', '.md', '.markdown', '.mdc', '.txt']);
const SECRET_NAME = /(^|[._-])(env|secrets?|credentials?|netrc|tokens?|keys?|passwords?)([._-]|$)/i;

/** Why a file can't be compressed, or undefined when it can. */
export function compressRefusal(file: string): string | undefined {
  const name = path.basename(file);
  if (SECRET_NAME.test(name)) {
    return `${name} looks like it holds secrets, so it won't be sent to the model.`;
  }
  if (/\.original\.[^.]+$/i.test(name)) {
    return `${name} is a backup of a compressed file.`;
  }
  if (!PROSE_EXTENSIONS.has(path.extname(name).toLowerCase())) {
    return `${name} isn't a prose file. Only Markdown and text files (.md, .mdc, .txt, no extension) are compressed.`;
  }
  return undefined;
}

/** The message that asks the agent to compress `file` in place. */
export function compressPrompt(file: string, backup: string): string {
  return `Compress the memory file ${file} in place, so every future session that loads it uses fewer input tokens. The original is backed up at ${backup}; don't touch the backup.

Rules:
- Cut what carries no information: articles where the sentence still reads, padding words, polite phrases, softeners ("perhaps consider") and linking words that add nothing ("moreover", "also note that").
- Prefer the shorter phrasing ("so that" → "so", "is able to" → "can", "a number of" → "several"). Turn advice into direct instructions; fragments are fine. Combine bullets that repeat each other, and keep a single example where several make the same point.
- Leave untouched: fenced code blocks and \`inline code\`, links and URLs, file paths, commands, names of tools, libraries, projects and people, dates, versions, numbers, environment variables, and every negation or limit (not, never, no, only, except).
- Keep the layout: heading text exactly, list nesting and numbering, table columns, and any front matter.
- Don't add notes about this task to the file.

Write the whole result with one Write call, then reply with one line: the size before and after.`;
}

export interface CompressionCheck {
  /** Things that changed but must not have. */
  problems: string[];
  before: number;
  after: number;
}

const FENCE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
const INLINE_CODE = /`[^`\n]+`/g;
const URL = /https?:\/\/[^\s)>\]"'`]+/g;
const HEADING = /^#{1,6}[ \t]+.+$/gm;

/** Checks a compressed file against its original: code, URLs and headings must survive unchanged. */
export function checkCompression(original: string, compressed: string): CompressionCheck {
  const problems: string[] = [];
  const fences = (s: string) => s.match(FENCE) ?? [];
  const before = fences(original);
  const after = fences(compressed);
  if (before.length !== after.length || before.some((block, i) => block !== after[i])) {
    problems.push(`code blocks changed (${before.length} before, ${after.length} after, or their contents differ)`);
  }
  // Inline code and URLs outside fences; fences were compared whole above.
  const prose = (s: string) => s.replace(FENCE, '');
  const missing = (re: RegExp, label: string) => {
    const kept = new Set(prose(compressed).match(re) ?? []);
    const lost = [...new Set(prose(original).match(re) ?? [])].filter((x) => !kept.has(x));
    if (lost.length) {
      problems.push(`${label} missing: ${lost.slice(0, 5).join(', ')}${lost.length > 5 ? ` and ${lost.length - 5} more` : ''}`);
    }
  };
  missing(INLINE_CODE, 'inline code');
  missing(URL, 'URLs');
  const headings = (s: string) => (prose(s).match(HEADING) ?? []).map((h) => h.trim());
  const hb = headings(original);
  const ha = headings(compressed);
  if (hb.length !== ha.length || hb.some((h, i) => h !== ha[i])) {
    problems.push('headings changed');
  }
  return { problems, before: original.length, after: compressed.length };
}

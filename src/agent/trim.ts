/**
 * Trims tool output before the model sees it. A passing test run or a huge
 * grep costs tens of thousands of tokens that the model skims once and then
 * pays for on every later turn; failures plus the summary, or the head and
 * tail plus a file to Read, carry the same information. The controller calls
 * this from a PostToolUse hook and returns the result as `updatedToolOutput`,
 * so built-in tools keep their output shape. Pure apart from the spill file.
 */
import * as fs from 'fs';
import * as path from 'path';
import { writeAtomic } from '../memory/files';
import { BUILD_COMMAND, TEST_COMMAND } from './verify';

export interface TrimResult {
  output: unknown;
  savedChars: number;
  note?: string;
}

/** Read already caps and pages its output; the rest return little or echo the model's own input. */
const NEVER = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'TodoWrite', 'Agent', 'Task', 'ExitPlanMode']);
const DEFAULT_MAX = 8_000;
const KEEP = 3_000;
const CONDENSE_MIN = 2_000;
const CONDENSE_MAX = 4_000;

/** A failure block: its first line, how many lines it may span (0 = drop it), and an optional last line. */
interface Block {
  start: RegExp;
  lines: number;
  end?: RegExp;
}

const BLOCKS: Block[] = [
  { start: /^\s*FAIL(\s|$)/, lines: 15 }, // jest/vitest file or test, go package
  { start: /^\s*● Console/, lines: 0 }, // jest console logs: ends the block above, kept out
  { start: /^\s*●\s/, lines: 20 }, // jest failure detail
  { start: /^\s*[×✗✕✘]\s/, lines: 1 }, // vitest/jest/swift-testing failed test
  { start: /^\s*✖\s/, lines: 12 }, // node:test spec reporter
  { start: /^\s*not ok \d+/, lines: 30, end: /^\s*\.\.\.\s*$/ }, // TAP with its YAML diagnostics
  { start: /^\s*\d+ failing\s*$/, lines: 40 }, // mocha
  { start: /^(FAILED|ERROR)\s/, lines: 1 }, // pytest
  { start: /^E\s{2,}\S/, lines: 1 }, // pytest assertion detail
  { start: /^_{3,} .+ _{3,}$|^=+ short test summary info =+$/, lines: 1 }, // pytest headers
  { start: /^\S+\.py:\d+: \w/, lines: 1 }, // pytest failure location
  { start: /^\s*--- FAIL/, lines: 8 }, // go test
  { start: /^panic:/, lines: 10 }, // go
  { start: /^failures:\s*$/, lines: 40, end: /^test result:/ }, // cargo
  { start: /:\d+(:\d+)?: error:|^error(\[\w+\])?:/, lines: 3 }, // swift, xcodebuild, clang, rustc
  { start: /\b(Test Case|Test Suite) '.*' failed|^Testing failed:/, lines: 1 }, // XCTest
  { start: /\berror TS\d+:/, lines: 1 }, // tsc
  { start: /^npm ERR!/, lines: 1 },
  { start: /\b[A-Z]\w*Error:\s/, lines: 6 }, // generic stack head
];

/** Final counts and verdicts: kept even when everything passed. */
const SUMMARY = new RegExp(
  [
    /^\s*(Tests?|Test Suites|Test Files|Snapshots)\b:?\s+\d/, // jest, vitest
    /^[#ℹ]\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s+\d+/, // node:test
    /\b\d+ (passed|failed|passing|failing|pending|skipped|errors?)\b/, // pytest, mocha
    /\b(BUILD|TEST) (SUCCEEDED|FAILED)\b/,
    /^Ran \d+ tests?/,
    /^(OK|FAILED)\b( \(.*\))?$/, // unittest
    /^test result:/, // cargo
    /^ok\s+\S+\s+(\d[\d.]*s|\(cached\))/, // go package
    /\bExecuted \d+ tests?|Test run with \d+ tests?/, // XCTest, swift-testing
    /^Found \d+ errors?/, // tsc
  ]
    .map((r) => r.source)
    .join('|'),
);

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const startsBlock = (line: string) => BLOCKS.find((b) => b.start.test(line));

/** `text` cut to about `maxChars`: its head and tail on line boundaries, with the gap marked. */
export function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const budget = Math.max(maxChars - 40, 2);
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  let head = text.slice(0, headLen);
  const nl = head.lastIndexOf('\n');
  if (nl > headLen / 2) {
    head = head.slice(0, nl);
  }
  let tail = tailLen > 0 ? text.slice(-tailLen) : '';
  const nl2 = tail.indexOf('\n');
  if (nl2 >= 0 && nl2 < tailLen / 2) {
    tail = tail.slice(nl2 + 1);
  }
  return `${head}\n… [${text.length - head.length - tail.length} chars omitted] …\n${tail}`;
}

/**
 * A test or build run's output cut to its failure blocks and summary lines
 * (summary only when all passed); undefined for other commands or when
 * nothing recognisable is found.
 */
export function condenseTestOutput(command: string, text: string): string | undefined {
  if (!TEST_COMMAND.test(command) && !BUILD_COMMAND.test(command)) {
    return undefined;
  }
  const lines = text.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const block = startsBlock(lines[i]);
    if (!block || !block.lines) {
      keep[i] ||= !block && SUMMARY.test(lines[i]);
      continue;
    }
    keep[i] = true;
    for (let j = i + 1; j < Math.min(i + block.lines, lines.length); j++) {
      if (block.end?.test(lines[j])) {
        keep[j] = true;
        break;
      }
      if (startsBlock(lines[j]) || SUMMARY.test(lines[j])) {
        break;
      }
      keep[j] = true;
    }
  }
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (i > 0 && !keep[i - 1] && out.length) {
        out.push('…');
      }
      out.push(line);
    }
  });
  const kept = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return kept ? headTail(kept, CONDENSE_MAX) : undefined;
}

/** The text a tool returned and how to put trimmed text back in the same shape. */
interface View {
  text: string;
  rebuild: (text: string) => unknown;
}

interface TextBlock {
  type: 'text';
  text: string;
}
const isTextBlock = (b: unknown): b is TextBlock => !!b && (b as TextBlock).type === 'text' && typeof (b as TextBlock).text === 'string';

/** MCP content blocks: the first text block gets the trimmed text, other text blocks go, images stay. */
function blocksView(blocks: unknown[]): View | undefined {
  const texts = blocks.filter(isTextBlock);
  if (!texts.length) {
    return undefined;
  }
  return {
    text: texts.map((b) => b.text).join('\n'),
    rebuild: (text) => blocks.flatMap((b) => (b === texts[0] ? [{ ...texts[0], text }] : isTextBlock(b) ? [] : [b])),
  };
}

function textView(output: unknown): View | undefined {
  if (typeof output === 'string') {
    return { text: output, rebuild: (t) => t };
  }
  if (Array.isArray(output)) {
    return blocksView(output);
  }
  if (!output || typeof output !== 'object') {
    return undefined;
  }
  const o = output as Record<string, unknown>;
  if (typeof o.stdout === 'string') {
    if (o.isImage === true) {
      return undefined; // stdout is image data
    }
    const stderr = typeof o.stderr === 'string' ? o.stderr : '';
    return {
      text: o.stdout && stderr ? `${o.stdout}\n${stderr}` : o.stdout || stderr,
      rebuild: (t) => ({ ...o, stdout: t, ...('stderr' in o ? { stderr: '' } : {}) }),
    };
  }
  if (Array.isArray(o.content)) {
    const view = blocksView(o.content);
    return view && { text: view.text, rebuild: (t) => ({ ...o, content: view.rebuild(t) }) };
  }
  const content = typeof o.content === 'string' ? o.content : '';
  const files = Array.isArray(o.filenames) && o.filenames.every((f) => typeof f === 'string') ? (o.filenames as string[]).join('\n') : '';
  if (content && content.length >= files.length) {
    return { text: content, rebuild: (t) => ({ ...o, content: t }) };
  }
  return files ? { text: files, rebuild: (t) => ({ ...o, filenames: t.split('\n') }) } : undefined;
}

/** Writes the full text to `<dir>/<tool>-<now>.txt` (a suffix if taken) and returns the path. */
function spill(dir: string, tool: string, now: number, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${tool.replace(/[^\w.-]+/g, '_')}-${now}`);
  let file = `${base}.txt`;
  for (let k = 2; fs.existsSync(file); k++) {
    file = `${base}-${k}.txt`;
  }
  writeAtomic(file, text);
  return file;
}

/** The output the model should see instead; undefined = leave the output alone. Never throws. */
export function trimToolOutput(
  tool: string,
  input: Record<string, unknown> | undefined,
  output: unknown,
  opts: { spillDir: string; now?: number; maxChars?: number },
): TrimResult | undefined {
  try {
    const view = NEVER.has(tool) ? undefined : textView(output);
    if (!view) {
      return undefined;
    }
    const max = opts.maxChars ?? DEFAULT_MAX;
    const now = opts.now ?? Date.now();
    const command = tool === 'Bash' && typeof input?.command === 'string' ? input.command : '';
    let text: string | undefined;
    let note: string | undefined;
    const condensed = command && view.text.length > CONDENSE_MIN ? condenseTestOutput(command, view.text) : undefined;
    if (condensed && condensed.length < view.text.length * 0.8) {
      const file = spill(opts.spillDir, tool, now, view.text);
      text = `[Dual Agent trimmed this output to failures and the summary; full output: ${file}]\n${condensed}`;
      note = 'Test/build output trimmed to failures and the summary';
    } else if (view.text.length > max) {
      const file = spill(opts.spillDir, tool, now, view.text);
      text = `${headTail(view.text, Math.min(KEEP, max))}\n[Full output (${view.text.length} chars) saved to ${file}; Read it with offset/limit or Grep it]`;
      note = `Long ${tool} output saved to a file`;
    }
    const savedChars = text === undefined ? 0 : view.text.length - text.length;
    return text !== undefined && savedChars > 0 ? { output: view.rebuild(text), savedChars, note } : undefined;
  } catch {
    return undefined;
  }
}

/** Deletes saved outputs older than `maxAgeMs`; best effort (they're only a convenience copy). */
export function pruneSpill(dir: string, maxAgeMs: number, now = Date.now()) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // Gone already, or unreadable: leave it.
      }
    }
  } catch {
    // No folder yet.
  }
}

/**
 * Runs after each Write/Edit/MultiEdit (a PostToolUse hook) and tells the agent
 * about two things prompt rules alone don't reliably stop: blocks it just wrote
 * that duplicate code elsewhere, and comments that narrate the edit. Only the
 * code just written is checked, so pre-existing issues aren't raised.
 */
import * as fs from 'fs';
import { Target, indexWindows, refreshIndex, resolveTarget } from './repoIndex';
import { findDuplicates } from './analysis';

/** Comment lines that describe the change instead of the code. */
const NARRATION =
  /^\s*(?:\/\/|#|\*|\/\*|--)\s*(?:(?:added|changed|updated|modified|fixed|removed|replaced|refactored|moved|renamed)(?:\s*:|\s+(?:to|the|a|an|new|this|that|missing|support|logic|check|handling|call|import|code|for|in)\b)|now\s+(?:uses|returns|handles|supports|calls)\b|new:)|\b(?:as requested|per (?:the )?user|previously (?:used|was|this))\b/i;

export interface EditInput {
  file_path?: string;
  content?: string;
  new_string?: string;
  edits?: { new_string?: string }[];
}

/** Each piece of text the tool wrote: the whole file for Write, every replacement for the edits. */
function writtenPieces(tool: string, input: EditInput): string[] {
  if (tool === 'Write') {
    return [input.content ?? ''];
  }
  if (tool === 'MultiEdit') {
    return (input.edits ?? []).map((e) => e.new_string ?? '');
  }
  return [input.new_string ?? ''];
}

/** The 1-based line range each written piece now occupies in the file; undefined for pieces not found. */
function writtenRanges(text: string, pieces: string[], whole: boolean): ([number, number] | undefined)[] {
  return pieces.map((piece) => {
    const at = whole ? 0 : text.indexOf(piece);
    if (at < 0 || !piece) {
      return undefined;
    }
    const first = text.slice(0, at).split('\n').length;
    return [first, first + piece.split('\n').length - 1];
  });
}

/**
 * Feedback for the agent about an edit it just made, or undefined when there's
 * nothing to say. `reported` remembers duplicates already raised this chat.
 */
export async function checkEdit(root: string, tool: string, input: EditInput, reported: Set<string>): Promise<string | undefined> {
  const pieces = writtenPieces(tool, input).filter((p) => p.trim());
  if (!input.file_path || !pieces.length) {
    return undefined;
  }
  const notes: string[] = [];

  const narration = pieces.flatMap((p) => p.split('\n')).filter((l) => NARRATION.test(l)).map((l) => l.trim());
  if (narration.length) {
    notes.push(
      `Comments describe the edit rather than the code: ${narration.slice(0, 3).map((l) => JSON.stringify(l)).join(', ')}. ` +
        'Remove them or say why the code is this way; the change itself belongs in the commit message.',
    );
  }

  let at: Target | undefined;
  let text: string | undefined;
  try {
    // A file in another git repo is compared with that repo; one in no repo isn't checked.
    at = resolveTarget(root, input.file_path);
    text = at.inRepo && !at.isDir ? await fs.promises.readFile(at.abs, 'utf8') : undefined;
  } catch {
    // Deleted or unreadable since the edit: nothing to compare.
  }
  const ranges = text === undefined ? [] : writtenRanges(text, pieces, tool === 'Write').filter((r) => r !== undefined);
  if (at && ranges.length) {
    const rel = at.rel;
    // Only the edited file is re-read when the index is warm, and the window map is kept between edits.
    const files = await refreshIndex(at.root, [at.abs]);
    const fresh = findDuplicates(files, rel, 8, await indexWindows(at.root)).filter((d) => {
      const key = `${d.file}|${d.other}|${d.otherStart}`;
      if (reported.has(key) || !ranges.some(([a, b]) => d.start <= b && d.end >= a)) {
        return false;
      }
      reported.add(key);
      return true;
    });
    if (fresh.length) {
      const where = fresh.slice(0, 5).map((d) => `L${d.start}-${d.end} = ${d.other} L${d.otherStart}-${d.otherEnd}`);
      notes.push(`Code you just wrote in ${rel} duplicates existing code: ${where.join('; ')}. Reuse it: call or extend the existing code, or move the shared part into one function both places call.`);
    }
  }
  return notes.join('\n') || undefined;
}

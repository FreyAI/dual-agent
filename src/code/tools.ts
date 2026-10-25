/**
 * The code tools the agents get, served in-process to Claude Code as an MCP
 * server named "code": code_map (what the repository already defines, so the
 * agent reuses it instead of writing it again), find_duplicates (blocks copied
 * between files), and navigation through VS Code's language servers
 * (code_outline, code_definition, code_references, code_problems), and a
 * notes board every agent shares (notes_read, notes_add), so helpers don't
 * each rediscover the same code. Paths may be absolute or ~: one in another
 * git repo is answered from that repo's own index.
 */
import type * as Sdk from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { z } from 'zod';
import { guarded, toolUseIdOf } from '../mcp';
import { Target, indexRepo, indexWindows, relPath as toRel, resolveTarget } from './repoIndex';
import { Focus, duplicatesReport, findDuplicates, mapReport, rankSymbols } from './analysis';
import { Place, definition, outline, problems, references } from './lsp';
import { NOTE_KINDS, NoteWriter, findNotes, upsertNote } from '../memory/memory';
import { hasKeyShapedValue } from '../text';

const TOOLS = ['code_map', 'find_duplicates', 'code_outline', 'code_definition', 'code_references', 'code_problems', 'notes_read', 'notes_add'];
export const CODE_TOOL_NAMES = TOOLS.map((t) => `mcp__code__${t}`);
const NOTE_MAX = 1500;
/** find_duplicates on a folder checks at most this many files. */
export const FOLDER_FILES_CAP = 200;
const PATH_HELP = 'relative to the workspace, or absolute/~ for another repo';

/** notes_add `files` as a list; models also send it as a JSON array string or a comma list. */
export function noteFiles(files: string[] | string | undefined): string[] {
  if (typeof files !== 'string') {
    return files ?? [];
  }
  try {
    const parsed = JSON.parse(files);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // Not JSON: a comma (or newline) separated list.
  }
  return files.split(/[,\n]/).map((f) => f.trim()).filter(Boolean);
}

/**
 * Who made a notes_add call: by whom, and the mark that holds the note as a proposal (a helper's id, or a
 * reason) with what to tell the agent; no mark: shared at once.
 */
export type NoteAuthor = (toolUseId: string | undefined) => { by: NoteWriter; helper?: string; reply?: string };

/** Why a note can't be saved: notes are read by every agent and session, and memory is a known way to plant instructions or leak keys. */
export function noteRefusal(text: string): string | undefined {
  if (hasKeyShapedValue(text) || /(^|[\s/`'"])(credentials\/|\.env\b|id_rsa|\.ssh\/)/.test(text)) {
    return 'Notes must not hold keys, tokens, passwords or credential paths: they are shared with every agent and session. Leave the secret out.';
  }
  return undefined;
}

/** `focus` names the files the agent edited or the user has open and the prompt's words, to rank code_map toward them. */
export function createCodeServer(sdk: typeof Sdk, root: () => string, focus?: () => Required<Focus>, author: NoteAuthor = () => ({ by: 'main' })) {
  const annotations = { readOnlyHint: true };
  /** Where a path is; the workspace when none is given. */
  const target = (p?: string) => resolveTarget(root(), p ?? '.');
  const fileTarget = (p: string) => {
    const t = target(p);
    if (t.isDir) {
      throw new Error(`${p} is a folder; give a file.`);
    }
    return t;
  };
  /** Answers about another repo say which, since their paths are relative to it. */
  const labelled = async (t: Target, answer: string | Promise<string>) => (t.root === root() ? answer : `(in ${t.root})\n${await answer}`);

  const codeMap = sdk.tool(
    'code_map',
    'Definitions in this repo (functions, classes, types, constants) with file, line, signature; [n] = files using it. Query it before writing a helper, type or component, then reuse or extend. No query: overview of the most used definitions.',
    {
      query: z.string().optional().describe('Words for what you are looking for, e.g. "parse date" or "retry backoff". Matches names and file paths.'),
      path: z.string().optional().describe(`Only this folder or file, ${PATH_HELP}`),
    },
    guarded(async ({ query, path: under }: { query?: string; path?: string }) => {
      const t = target(under);
      const f = focus?.();
      const files = f?.files.map((p) => toRel(t.root, p));
      const ranked = rankSymbols(await indexRepo(t.root), query, t.rel || undefined, { files, words: f?.words });
      if (!ranked.length) {
        return query ? `No definitions match "${query}"${under ? ` under ${under}` : ''}. Nothing to reuse by that name; search with Grep for other wording before writing it.` : `No source files found${under ? ` under ${under}` : ''}.`;
      }
      return labelled(t, mapReport(ranked, query));
    }, 'code_map'),
    { annotations },
  );

  const duplicates = sdk.tool(
    'find_duplicates',
    'Blocks of code that appear twice, in a file, a folder or the whole repo. Run it on files you created or heavily changed; replace copies with one shared function.',
    {
      path: z.string().optional().describe(`File or folder to check, ${PATH_HELP}. Omit to scan the whole repository.`),
      min_lines: z.number().int().min(4).max(200).optional().describe('Smallest block to report, in non-trivial lines (default 8)'),
    },
    guarded(async ({ path: file, min_lines }: { path?: string; min_lines?: number }) => {
      const t = target(file);
      const files = await indexRepo(t.root);
      let check: string | string[] | undefined;
      let note = '';
      if (!t.isDir) {
        if (!files.some((f) => f.rel === t.rel)) {
          throw new Error(`${file} isn't an indexed source file (unknown language, ignored by git, or too large).`);
        }
        check = t.rel;
      } else if (t.rel) {
        const under = files.filter((f) => f.rel.startsWith(`${t.rel}/`)).map((f) => f.rel);
        if (!under.length) {
          throw new Error(`No indexed source files under ${file}.`);
        }
        check = under.slice(0, FOLDER_FILES_CAP);
        if (under.length > FOLDER_FILES_CAP) {
          note = `\n(Checked the first ${FOLDER_FILES_CAP} of ${under.length} files under ${file}; pass a subfolder for the rest.)`;
        }
      }
      const found = findDuplicates(files, check, min_lines ?? 8, await indexWindows(t.root));
      if (!found.length) {
        return labelled(t, `${check ? `No duplicated blocks in ${typeof check === 'string' ? check : `${check.length} files under ${t.rel}`}.` : 'No duplicated blocks found.'}${note}`);
      }
      return labelled(t, duplicatesReport(found) + note);
    }, 'find_duplicates'),
    { annotations },
  );

  const place = {
    symbol: z.string().min(1).describe('The identifier, e.g. "parseConfig" or "UserStore"'),
    path: z.string().optional().describe(`File it appears in, ${PATH_HELP}. Omit to look the name up across the workspace.`),
    line: z.number().int().min(1).optional().describe('1-based line it appears on (from Grep, code_map or code_outline)'),
  };
  const lookup = (tool: string, run: (root: string, p: Place) => Promise<string>) =>
    guarded((p: Place) => {
      if (!p.path) {
        return run(root(), p);
      }
      const t = fileTarget(p.path);
      return labelled(t, run(t.root, { ...p, path: t.rel }));
    }, tool);

  const codeOutline = sdk.tool(
    'code_outline',
    "A file's classes, functions and types with line ranges (language server). Use before reading a large file; then Read only the ranges you need.",
    { path: z.string().min(1).describe(`File, ${PATH_HELP}`) },
    guarded(({ path: file }: { path: string }) => {
      const t = fileTarget(file);
      return labelled(t, outline(t.root, t.rel));
    }, 'code_outline'),
    { annotations },
  );

  const codeDefinition = sdk.tool(
    'code_definition',
    'Where a symbol is defined, with its signature and doc comment (language server; exact, follows imports). Use instead of grepping for definitions.',
    place,
    lookup('code_definition', definition),
    { annotations },
  );

  const codeReferences = sdk.tool(
    'code_references',
    'Every use of a symbol, by file, with the enclosing function (language server). Use before changing a signature, type or behavior. Skips comments and strings: also Grep before a rename or delete.',
    { ...place, context: z.number().int().min(0).max(3).optional().describe('Lines of code to show around each use (default 0); 2 usually saves opening the files') },
    lookup('code_references', references),
    { annotations },
  );

  const codeProblems = sdk.tool(
    'code_problems',
    "The editor's current errors and warnings for a file or the workspace: a quick check after edits.",
    { path: z.string().optional().describe(`File, ${PATH_HELP}. Omit for every file the editor has checked.`) },
    guarded(({ path: file }: { path?: string }) => {
      if (!file) {
        return problems(root());
      }
      const t = fileTarget(file);
      return labelled(t, problems(t.root, t.rel));
    }, 'code_problems'),
    { annotations },
  );

  const notesRead = sdk.tool(
    'notes_read',
    'Project notes shared by every agent and session: build/test commands that worked, gotchas, decisions, where things live. Read before exploring an area; a note says when its files changed since it was checked.',
    {
      query: z.string().optional().describe('Words to match, e.g. "auth token refresh". Omit for all notes.'),
      path: z.string().optional().describe('A file or folder in another repo, to read that repo\'s notes (default: the workspace)'),
    },
    guarded(({ query, path: at }: { query?: string; path?: string }) => findNotes(target(at).root, query), 'notes_read'),
    { annotations },
  );

  const notesAdd = sdk.tool(
    'notes_add',
    `Save, in 1-3 lines with its files, what another agent would otherwise get wrong or work out again: a command that worked, a gotcha, a decision the code doesn't show, or where something lives. No overviews of how code flows, no task progress. Same title replaces the note. Limits: title 3-120 chars, body up to ${NOTE_MAX} chars (longer is cut), up to 20 files.`,
    {
      title: z.string().min(3).max(120).describe('Short topic, e.g. "Payment retries"'),
      body: z.string().min(3).describe(`The note, up to ${NOTE_MAX} characters`),
      kind: z.enum(NOTE_KINDS).optional().describe('command | gotcha | decision | map (where something lives)'),
      files: z.union([z.array(z.string()), z.string()]).optional().describe('Files it is about (a list), relative to the repo the note is for'),
      path: z.string().optional().describe('A file or folder in another repo, to save the note in that repo (default: the workspace)'),
    },
    guarded(({ title, body, kind, files, path: at }: { title: string; body: string; kind?: (typeof NOTE_KINDS)[number]; files?: string[] | string; path?: string }, extra?: unknown) => {
      const refused = noteRefusal(`${title}\n${body}`);
      if (refused) {
        throw new Error(refused);
      }
      const repo = target(at).root;
      const cut = body.length > NOTE_MAX;
      const who = author(toolUseIdOf(extra));
      const saved = upsertNote(repo, { title, body: cut ? body.slice(0, NOTE_MAX) : body, kind, files: noteFiles(files).map((f) => toRel(repo, f)), updated: new Date().toISOString().slice(0, 10), by: who.by, pending: who.helper });
      if (saved === 'kept') {
        return `A note titled "${title}" already exists and only the main agent can replace it; save yours under a new title, or put the change in your report.`;
      }
      const pending = who.helper ? ` ${who.reply ?? 'It stays a proposal until a build or test you run passes, or the main agent saves it.'}` : '';
      return `Saved "${title}"${repo === root() ? '' : ` in ${repo}`}${cut ? ` (body cut to ${NOTE_MAX} of ${body.length} characters; keep notes short)` : ''}.${pending}`;
    }, 'notes_add'),
  );

  return sdk.createSdkMcpServer({
    name: 'code',
    version: '1.0.0',
    // In-process tool calls are unbounded otherwise; a stuck language server must not stall the agent.
    timeout: 60_000,
    tools: [codeMap, duplicates, codeOutline, codeDefinition, codeReferences, codeProblems, notesRead, notesAdd],
  });
}

/**
 * Project memory that survives sessions, in the spirit of Claude Code's auto
 * memory and Cline's memory bank: a handoff (the latest session or compaction
 * summaries) and short notes, both plain Markdown under `.dual-agent/memory`
 * that a person can read and edit. Each session gets the note titles and a
 * pointer to the handoff; the full text is read on demand. Helpers get a
 * short brief of the checked commands and gotchas instead.
 *
 * Writes are gated on outcomes (storing everything scored 3.7-12 points below
 * a fixed memory, arXiv 2505.16067): a helper's note waits until its report
 * passes the claims check, and build and test commands are recorded only when
 * they succeed. Notes cite files and are checked against them when read, as
 * Copilot's memory does; unused ones move to an archive, never rewritten whole.
 * Evidence: reports/Agent memory to cut token burn.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collapseSpace, hasKeyShapedValue, redactSecrets, short } from '../text';
import { Conventions, commandsLine, loadConventions } from './conventions';
import { readText, readTextOrUndefined, stripControl, workFolder, workPath, writeAtomic } from './files';

/** What a note is: agents act on commands and gotchas; overviews cost tokens without speeding file discovery (arXiv 2602.11988). */
export const NOTE_KINDS = ['command', 'gotcha', 'decision', 'map'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
/** main: the main agent; helper: a helper (pending until its report checks out); auto: recorded by Dual Agent. */
export type NoteWriter = 'main' | 'helper' | 'auto';

export interface MemoryNote {
  title: string;
  body: string;
  /** Workspace-relative paths the note is about; it's pruned once they're all gone and it's stale. */
  files: string[];
  /** ISO date. */
  updated: string;
  kind?: NoteKind;
  by?: NoteWriter;
  /** The helper whose note it is, until its report passes the claims check. Pending notes aren't injected anywhere. */
  pending?: string;
  /** ISO time it was last checked: its files unchanged when read, or the command succeeded. */
  verified?: string;
  /** Times it was read. */
  uses?: number;
  /** ISO time it was last read or shown beside a file: a note in use isn't retired. */
  used?: string;
}

const HANDOFF = 'handoff.md';
const NOTES = 'notes.md';
/** Notes retired by disuse: kept for a person to read, never injected or searched. */
const ARCHIVE = 'notes-archive.md';
const MAX_HANDOFF_CHARS = 4096;
/** Agents share the notes board, so it holds more than the primer shows (titles only there). */
const MAX_NOTES_CHARS = 32_768;
const MAX_NOTE_FILES = 20;
/** Files larger than this aren't ours (or are corrupt) and are ignored. */
const MAX_READ_BYTES = 256 * 1024;
const DAY_MS = 24 * 3600 * 1000;
/** A note whose files are all missing is dropped only after this long, so a branch checkout doesn't erase it. */
const STALE_MS = 14 * DAY_MS;
/** Unused and unchecked this long, a note moves to the archive (a judgement call: nothing measures the right figure). */
const UNUSED_MS = 30 * DAY_MS;
/** A helper's note its report never confirmed is dropped after this long. */
const PENDING_MS = 7 * DAY_MS;
/** `API_KEY=… npm test`: the command is fine, the value must not be stored. */
const SECRET_ASSIGNMENT = /\b\w*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)\w*=\S/i;
/** The most recorded commands kept: the newest successes. */
const MAX_COMMANDS = 12;
/** The helpers' brief: about 500 tokens, sent on each helper's first call and cached after. */
const HELPER_BRIEF_CHARS = 2000;
const HANDOFF_HEAD = '# Handoff\n<!-- Dual Agent: summaries of recent sessions, newest first. -->\n';
const NOTES_HEAD = '# Project notes\n<!-- Dual Agent project memory: one section per note. Safe to edit by hand. -->\n';
const ARCHIVE_HEAD = '# Archived project notes\n<!-- Dual Agent: notes unused for 30 days. Not shown to agents; move one back to notes.md to restore it. -->\n';

/** `<root>/.dual-agent/memory`; created on the first write. */
export const memoryDir = (root: string) => workPath(root, 'memory');

/** Text as stored: control characters stripped, and lines that would start a new section demoted. */
const cleanBody = (s: string) => stripControl(s).replace(/^#{1,2} /gm, '### ').trim();
const cleanLine = (s: string) => collapseSpace(stripControl(s));

/** `## heading` sections of a memory file; text before the first is ignored. */
function sections(text: string | undefined): { heading: string; body: string }[] {
  if (!text) {
    return [];
  }
  return stripControl(text)
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const nl = part.indexOf('\n');
      return nl < 0 ? { heading: part.trim(), body: '' } : { heading: part.slice(0, nl).trim(), body: part.slice(nl + 1).trim() };
    })
    .filter((s) => s.heading);
}

const render = (head: string, parts: string[]) => [head, ...parts].join('\n');

/** How a memory file is read: strictly before a rewrite, leniently for display. */
type Reader = (file: string, maxBytes: number) => string | undefined;

/** The handoff sections, newest first, as stored. */
const handoffSections = (root: string, read: Reader = readText) => sections(read(path.join(memoryDir(root), HANDOFF), MAX_READ_BYTES)).map((s) => `## ${s.heading}\n${s.body}\n`);

/**
 * Records a session or compaction summary. Older summaries are kept, newest
 * first, until the file reaches its cap; a summary over the cap alone is cut.
 */
export function saveHandoff(root: string, summary: string, now = new Date()) {
  // Prompts and compaction summaries can quote keys; the handoff is read by later sessions.
  const body = cleanBody(redactSecrets(summary));
  if (!body) {
    return;
  }
  const head = `## ${now.toISOString()}\n`;
  const newest = `${head}${short(body, MAX_HANDOFF_CHARS - HANDOFF_HEAD.length - head.length - 2)}\n`;
  const kept = [newest];
  let size = HANDOFF_HEAD.length + newest.length + 1;
  for (const old of handoffSections(root)) {
    size += old.length + 1;
    if (size > MAX_HANDOFF_CHARS) {
      break;
    }
    kept.push(old);
  }
  writeAtomic(path.join(workFolder(root, 'memory'), HANDOFF), render(HANDOFF_HEAD, kept));
}

/** The kept summaries, newest first, or undefined when there are none. */
export function loadHandoff(root: string): string | undefined {
  const text = handoffSections(root, readTextOrUndefined).join('\n').trim();
  return text || undefined;
}

const titleKey = (title: string) => cleanLine(title).toLowerCase();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The header lines of a note, in order; notes written before some existed just lack them. */
const FIELD = /^(Updated|Files|Kind|By|Pending|Verified|Uses|Used): *(.*)$/;

function readNotes(root: string, read: Reader = readText, file = NOTES): MemoryNote[] {
  return sections(read(path.join(memoryDir(root), file), MAX_READ_BYTES)).map(({ heading, body }) => {
    const note: MemoryNote = { title: heading, body: '', files: [], updated: '' };
    const lines = body.split('\n');
    for (let m; lines.length && (m = FIELD.exec(lines[0])); lines.shift()) {
      const value = m[2].trim();
      if (m[1] === 'Updated') {
        note.updated = value;
      } else if (m[1] === 'Files') {
        note.files = value.split(',').map((f) => f.trim()).filter(Boolean);
      } else if (m[1] === 'Kind') {
        note.kind = (NOTE_KINDS as readonly string[]).includes(value) ? (value as NoteKind) : undefined;
      } else if (m[1] === 'By') {
        note.by = value === 'helper' || value === 'auto' ? value : 'main';
      } else if (m[1] === 'Pending') {
        note.pending = value || undefined;
      } else if (m[1] === 'Verified') {
        note.verified = value || undefined;
      } else if (m[1] === 'Used') {
        note.used = value || undefined;
      } else {
        note.uses = Number(value) || 0;
      }
    }
    note.body = lines.join('\n').trim();
    return note;
  });
}

function renderNote(n: MemoryNote): string {
  return [
    `## ${n.title}`,
    `Updated: ${n.updated}`,
    ...(n.files.length ? [`Files: ${n.files.join(', ')}`] : []),
    ...(n.kind ? [`Kind: ${n.kind}`] : []),
    ...(n.by ? [`By: ${n.by}`] : []),
    ...(n.pending ? [`Pending: ${n.pending}`] : []),
    ...(n.verified ? [`Verified: ${n.verified}`] : []),
    ...(n.uses ? [`Uses: ${n.uses}`] : []),
    ...(n.used ? [`Used: ${n.used}`] : []),
    '',
    n.body,
    '',
  ].join('\n');
}

/**
 * Writes the notes newest first. Past the cap the oldest go to the archive
 * (from the archive itself, they're dropped); the newest always stays, cut if need be.
 */
function writeNotes(root: string, notes: MemoryNote[], file = NOTES, head = NOTES_HEAD) {
  const sorted = [...notes].sort((a, b) => b.updated.localeCompare(a.updated));
  const parts: string[] = [];
  const over: MemoryNote[] = [];
  let size = head.length;
  for (const n of sorted) {
    let part = renderNote(n);
    if (!parts.length && size + part.length + 1 > MAX_NOTES_CHARS) {
      part = renderNote({ ...n, body: short(n.body, Math.max(1, n.body.length - (size + part.length + 1 - MAX_NOTES_CHARS))) });
    }
    if (over.length || size + part.length + 1 > MAX_NOTES_CHARS) {
      over.push(n);
      continue;
    }
    parts.push(part);
    size += part.length + 1;
  }
  writeAtomic(path.join(workFolder(root, 'memory'), file), render(head, parts));
  if (over.length && file === NOTES) {
    writeNotes(root, [...over.filter((n) => !n.pending), ...readNotes(root, readText, ARCHIVE)], ARCHIVE, ARCHIVE_HEAD);
  }
}

/**
 * Adds a note, or replaces the one with the same title (case and spacing
 * ignored). Another note with the same body is dropped as a duplicate. A
 * helper's note is pending until its report checks out, and a helper never
 * replaces or drops anyone else's note: 'kept' says the title was taken.
 */
export function upsertNote(root: string, note: MemoryNote, now = new Date()): 'saved' | 'kept' | 'empty' {
  const title = short(cleanLine(note.title).replace(/^#+\s*/, ''), 200);
  const body = cleanBody(note.body);
  if (!title || !body) {
    return 'empty';
  }
  const files = [...new Set(note.files.map(cleanLine).map((f) => f.replace(/,/g, '')).filter(Boolean))].slice(0, MAX_NOTE_FILES);
  const updated = /^\d{4}-\d{2}-\d{2}/.test(note.updated) ? cleanLine(note.updated) : isoDay(now);
  const key = titleKey(title);
  const notes = readNotes(root);
  const same = notes.find((n) => titleKey(n.title) === key);
  // A proposal (a helper's, or any note written after reading web or tool content) never replaces another note.
  const proposal = !!note.pending;
  if (proposal && same && same.pending !== note.pending) {
    return 'kept';
  }
  // A proposal's duplicate body doesn't remove the note it repeats.
  const others = notes.filter((n) => titleKey(n.title) !== key && (proposal || n.body !== body));
  const written: MemoryNote = {
    title,
    body,
    files,
    updated,
    kind: note.kind ?? same?.kind,
    by: note.by,
    pending: note.pending,
    // Written by the main agent or Dual Agent with the cited files in view: checked now. A note citing no file was checked against nothing.
    verified: proposal ? undefined : (note.verified ?? (files.length ? now.toISOString() : undefined)),
    uses: same?.uses,
    used: same?.used,
  };
  writeNotes(root, [written, ...others]);
  return 'saved';
}

/** A finished helper's report checked out: its pending notes become ordinary ones. Returns how many. */
export function confirmNotes(root: string, helper: string, now = new Date()): number {
  const notes = readNotes(root);
  let confirmed = 0;
  for (const n of notes) {
    if (n.pending === helper) {
      n.pending = undefined;
      n.verified = now.toISOString();
      confirmed++;
    }
  }
  if (confirmed) {
    writeNotes(root, notes);
  }
  return confirmed;
}

/** What a recorded command is called: the command without its output plumbing (| tail, 2>&1), and the folder it ran in. */
export function commandCore(command: string): { run: string; dir?: string } {
  let run = command.trim().replace(/\s+/g, ' ');
  const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/.exec(run);
  const dir = cd?.[1].replace(/^["']|["']$/g, '');
  if (cd) {
    run = run.slice(cd[0].length);
  }
  run = run
    .replace(/\s*\|\s*(tail|head|grep|sed|cat|tee|less|awk)\b.*$/, '')
    .replace(/\s*[12]?>&[12]/g, '')
    .replace(/\s*;?\s*echo .*\$\?.*$/, '')
    .trim();
  return { run, dir };
}

/**
 * Records a build or test command that just succeeded (exit 0, no failure in
 * its output), with no model call: helpers get it in their brief instead of
 * working it out again. One note per command; the newest MAX_COMMANDS stay.
 */
export function recordCommand(root: string, command: string, now = new Date()): boolean {
  const { run, dir } = commandCore(command);
  // A key in the command would reach every helper's brief.
  if (run.length < 3 || run.length > 200 || hasKeyShapedValue(command) || SECRET_ASSIGNMENT.test(command)) {
    return false;
  }
  const rel = dir ? (path.isAbsolute(dir) ? path.relative(root, dir) : dir) : '';
  if (rel.startsWith('..')) {
    return false;
  }
  const title = `Command: ${run}${rel && rel !== '.' ? ` (in ${rel})` : ''}`;
  const notes = readNotes(root);
  const same = notes.find((n) => titleKey(n.title) === titleKey(title));
  // Once a day is enough: every test run would otherwise rewrite the file.
  if (same?.verified?.startsWith(isoDay(now))) {
    return false;
  }
  const body = `\`${rel && rel !== '.' ? `cd ${rel} && ` : ''}${run}\` succeeded on ${isoDay(now)}. Build and test output folders may be written by any agent.`;
  upsertNote(root, { title, body, files: [], updated: isoDay(now), kind: 'command', by: 'auto', verified: now.toISOString() }, now);
  const commands = readNotes(root).filter((n) => n.kind === 'command' && n.by === 'auto');
  if (commands.length > MAX_COMMANDS) {
    const drop = new Set(commands.sort((a, b) => (b.verified ?? '').localeCompare(a.verified ?? '')).slice(MAX_COMMANDS).map((n) => n.title));
    writeNotes(root, readNotes(root).filter((n) => !drop.has(n.title)));
  }
  return true;
}

const existingFiles = (root: string, n: MemoryNote) => n.files.filter((f) => fs.existsSync(path.resolve(root, f)));
const filesMissing = (root: string, n: MemoryNote) => n.files.length > 0 && !existingFiles(root, n).length;
const isStale = (n: MemoryNote, now: Date) => now.getTime() - Date.parse(n.updated) > STALE_MS;
/** When it was last written or checked against its files. */
const lastChecked = (n: MemoryNote) => Math.max(Date.parse(n.updated) || 0, Date.parse(n.verified ?? '') || 0);
/** When it was last written, checked or used: what retirement goes by. */
const lastTouched = (n: MemoryNote) => Math.max(lastChecked(n), Date.parse(n.used ?? '') || 0);

/** Whether a cited file changed after the note was last checked (being read doesn't check it): then the note may no longer hold. */
export function filesChanged(root: string, n: MemoryNote): boolean {
  const since = lastChecked(n);
  return n.files.some((f) => {
    try {
      return fs.statSync(path.resolve(root, f)).mtimeMs > since;
    } catch {
      return false;
    }
  });
}

/**
 * Tidies the notes: a helper's note its report never confirmed goes after a
 * week; a note whose files are all gone (two weeks on, as another branch may
 * still have them) or that nobody used or checked for 30 days moves to the
 * archive; deleted files are forgotten from notes that keep some. Notes about
 * no file are kept while used. Returns how many left notes.md.
 */
export function pruneNotes(root: string, now = new Date()): number {
  const notes = readNotes(root);
  let removed = 0;
  let changed = false;
  const kept: MemoryNote[] = [];
  const archived: MemoryNote[] = [];
  for (const n of notes) {
    if (n.pending) {
      if (now.getTime() - Date.parse(n.updated) > PENDING_MS) {
        removed++;
      } else {
        kept.push(n);
      }
      continue;
    }
    const existing = existingFiles(root, n);
    if (n.files.length && !existing.length) {
      if (isStale(n, now)) {
        archived.push(n);
      } else {
        kept.push(n);
      }
      continue;
    }
    if (!n.verified && !n.uses && !n.used) {
      // Written before use was tracked: its 30 days start now, not from its last edit.
      kept.push({ ...n, files: existing, verified: now.toISOString() });
      changed = true;
      continue;
    }
    if (now.getTime() - lastTouched(n) > UNUSED_MS) {
      archived.push(n);
      continue;
    }
    changed ||= existing.length !== n.files.length;
    kept.push({ ...n, files: existing });
  }
  if (archived.length) {
    writeNotes(root, [...archived, ...readNotes(root, readText, ARCHIVE)], ARCHIVE, ARCHIVE_HEAD);
  }
  removed += archived.length;
  if (removed || changed) {
    writeNotes(root, kept);
  }
  return removed;
}

/** What an agent is told about a note before relying on it. */
function caveats(root: string, n: MemoryNote): string[] {
  const recorded = n.kind === 'command' && n.by === 'auto';
  return [
    ...(n.pending ? ['a proposal, not confirmed yet'] : []),
    ...(filesMissing(root, n)
      ? ['its files are gone']
      : filesChanged(root, n)
        ? ['its files changed since it was checked: read them before relying on it; if it no longer holds, save the correction with notes_add or say so in your report']
        : !n.files.length && !recorded && !n.pending
          ? ['cites no files, so nothing checks it: confirm before relying on it']
          : []),
  ];
}

/** A note as agents read it: no bookkeeping lines. */
function noteForAgent(root: string, n: MemoryNote): string {
  const flags = caveats(root, n);
  return [`## ${n.title}`, ...(n.files.length ? [`Files: ${n.files.join(', ')}`] : []), ...(flags.length ? [`(${flags.join('; ')})`] : []), '', n.body, ''].join('\n');
}

/** Read notes count as used; those whose files didn't change count as checked. A failed write only costs the bookkeeping. */
function markRead(root: string, titles: Set<string>, now: Date) {
  try {
    const notes = readNotes(root);
    for (const n of notes) {
      if (titles.has(n.title)) {
        n.uses = (n.uses ?? 0) + 1;
        n.used = now.toISOString();
        // Only a note with files can be checked against them; reading one about no file checks nothing.
        if (!n.pending && n.files.length && !filesChanged(root, n) && !filesMissing(root, n)) {
          n.verified = now.toISOString();
        }
      }
    }
    writeNotes(root, notes);
  } catch {
    // Reading the notes was the job; their counters can wait for the next read.
  }
}

/**
 * Notes matching every word of `query` (title, body or files), newest first,
 * in full within `maxChars`: what agents read before exploring an area. Each
 * says if its files changed since it was checked (Copilot's verify-on-read).
 */
export function findNotes(root: string, query = '', maxChars = 6000, now = new Date()): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = readNotes(root, readTextOrUndefined).filter((n) => {
    const hay = `${n.title}\n${n.body}\n${n.files.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  if (!hits.length) {
    return query ? `No notes about "${query}". After you learn how it works, add one with notes_add.` : 'No notes yet. Add what you learn with notes_add.';
  }
  const out: string[] = [];
  const shown = new Set<string>();
  let size = 0;
  for (const n of hits) {
    const part = noteForAgent(root, n);
    if (size + part.length > maxChars) {
      out.push(`(${hits.length - out.length} more; narrow the query.)`);
      break;
    }
    out.push(part);
    shown.add(n.title);
    size += part.length;
  }
  markRead(root, shown, now);
  return out.join('\n');
}

/** Confirmed notes that cite `file` (workspace-relative), for an agent about to read it; undefined when none. Shown notes count as used. */
export function notesForFile(root: string, file: string, maxChars = 800, now = new Date()): string | undefined {
  const notes = readNotes(root, readTextOrUndefined).filter((n) => !n.pending && n.files.includes(file));
  if (!notes.length) {
    return undefined;
  }
  markRead(root, new Set(notes.map((n) => n.title)), now);
  const text = notes.map((n) => `- ${n.title}: ${cleanLine(n.body)}${filesChanged(root, n) ? ' (files changed since it was checked)' : ''}`).join('\n');
  return short(`Project notes about ${file}:\n${text}`, maxChars);
}

/** Commands agents ran successfully, newest first (the first backticked part of each recorded note). */
export function recordedCommands(root: string): string[] {
  return readNotes(root, readTextOrUndefined)
    .filter((n) => n.kind === 'command' && n.by === 'auto')
    .sort((a, b) => (b.verified ?? b.updated).localeCompare(a.verified ?? a.updated))
    .map((n) => /`([^`]+)`/.exec(n.body)?.[1] ?? '')
    .filter(Boolean);
}

/** The project's check commands: detected, hand-edited in conventions.md, or recorded. `persist` false never writes the file. */
export function loadProjectConventions(root: string, persist = true): Conventions {
  return loadConventions(root, recordedCommands(root), persist);
}

const projectCommandsLine = (root: string) => commandsLine(loadProjectConventions(root));

/**
 * The brief every helper starts with: the commands seen to succeed here and
 * the gotchas, confirmed only. Named commands change what agents run (uv: 1.6
 * uses per task when named, under 0.01 when not, arXiv 2602.11988); overviews
 * don't help. Built once per agent process so its bytes, and the cache built on
 * them, stay the same for every helper. Undefined when there is nothing to say.
 */
export function helperBrief(root: string, maxChars = HELPER_BRIEF_CHARS): string | undefined {
  const notes = readNotes(root, readTextOrUndefined).filter((n) => !n.pending && !filesMissing(root, n));
  const commands = notes.filter((n) => n.kind === 'command').sort((a, b) => (b.verified ?? b.updated).localeCompare(a.verified ?? a.updated));
  const gotchas = notes.filter((n) => n.kind === 'gotcha');
  const projectLine = projectCommandsLine(root);
  if (!commands.length && !gotchas.length && !projectLine) {
    return undefined;
  }
  const lines = ['Project memory (checked in earlier sessions; may be out of date).'];
  const add = (line: string) => {
    if (lines.join('\n').length + line.length + 1 <= maxChars) {
      lines.push(line);
    }
  };
  if (projectLine) {
    add(projectLine);
  }
  if (commands.length) {
    add('Build and test commands that succeeded here:');
    commands.forEach((n) => add(`- ${short(cleanLine(n.body.split('\n')[0]), 220)}`));
  }
  if (gotchas.length) {
    add('Gotchas:');
    gotchas.forEach((n) => add(`- ${n.title}: ${short(cleanLine(n.body.split('\n')[0]), 180)}${n.files.length ? ` (${n.files.slice(0, 2).join(', ')})` : ''}`));
  }
  return lines.length > 1 ? lines.join('\n') : undefined;
}

/**
 * What to tell the agent at session start: the notes (titles with the first
 * line of each body) within `maxChars`, and where the handoff is. The handoff
 * itself isn't sent, so sessions that don't continue earlier work don't pay
 * for it. Undefined when there's no memory.
 */
export function memoryPrimer(root: string, maxChars = 1600): string | undefined {
  const hasHandoff = loadHandoff(root) !== undefined;
  const all = readNotes(root, readTextOrUndefined).filter((n) => !n.pending);
  // Recorded commands go to helpers; listed here they'd crowd out the decisions (claude-mem#3274).
  const recorded = all.filter((n) => n.kind === 'command' && n.by === 'auto').length;
  const notes = all.filter((n) => !(n.kind === 'command' && n.by === 'auto'));
  const projectLine = projectCommandsLine(root);
  if (!hasHandoff && !all.length && !projectLine) {
    return undefined;
  }
  const parts = ['Project memory from earlier sessions (it may be out of date; check before relying on it).'];
  if (projectLine) {
    parts.push(projectLine);
  }
  if (recorded) {
    // By file, not tool: notes_read exists only with the lean workflow's code tools.
    parts.push(`${recorded} build/test command${recorded === 1 ? '' : 's'} that succeeded here are in .dual-agent/memory/${NOTES} (titles start "Command:").`);
  }
  if (hasHandoff) {
    parts.push(`Summaries of recent sessions are in .dual-agent/memory/${HANDOFF}; read it only when the request continues earlier work.`);
  }
  if (notes.length) {
    const noteLines = [`Notes (${notes.length}, full text in .dual-agent/memory/${NOTES}):`];
    let size = parts.join('\n').length + noteLines[0].length + 1;
    for (const n of notes) {
      const line = `- ${n.title}: ${short(cleanLine(n.body.split('\n')[0]), 120)}${n.files.length ? ` (${n.files.slice(0, 3).join(', ')})` : ''}${filesMissing(root, n) ? ' (files missing)' : filesChanged(root, n) ? ' (files changed since)' : ''}`;
      if (size + line.length + 1 > maxChars) {
        break;
      }
      noteLines.push(line);
      size += line.length + 1;
    }
    parts.push(noteLines.join('\n'));
  }
  return short(parts.join('\n'), maxChars);
}

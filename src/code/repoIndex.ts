/**
 * A light index of the repository for the code tools: the definitions each
 * source file holds (found with per-language patterns, not a parser), the
 * identifiers it uses, and hashes of its normalized line windows for spotting
 * copied blocks. Entries are cached per file, rebuilt when the file changes, and
 * saved to .dual-agent/index so a new session starts warm.
 *
 * Ranking definitions by how many other files use them follows Aider's repo map
 * (https://github.com/Aider-AI/aider, Apache-2.0); the code here is new.
 */
import type * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvedPath } from '../paths';
import { workFolder, workPath, writeAtomic } from '../memory/files';
import { repoRootOf } from '../agent/scope';

export interface CodeSymbol {
  name: string;
  kind: string;
  /** 1-based. */
  line: number;
  signature: string;
}

interface Window {
  hash: string;
  /** First and last line the window covers, 1-based. */
  start: number;
  end: number;
}

export interface IndexedFile {
  /** Relative to the root, with forward slashes. */
  rel: string;
  symbols: CodeSymbol[];
  idents: Set<string>;
  windows: Window[];
}

type Pattern = [RegExp, string];

const ID = '[A-Za-z_$][\\w$]*';
const JS: Pattern[] = [
  [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})`), 'function'],
  [new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${ID})`), 'class'],
  [new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+(${ID})`), 'interface'],
  [new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+(${ID})\\s*(?:<[^=]*>)?\\s*=`), 'type'],
  [new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+(${ID})`), 'enum'],
  [new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|${ID})\\s*(?::[^=]+)?=>`), 'function'],
  [new RegExp(`^export\\s+(?:const|let)\\s+(${ID})`), 'const'],
  [new RegExp(`^\\s+(?!private\\b)(?:(?:public|protected|static|async|readonly|override|get|set)\\s+)*(${ID})\\s*(?:<[^>()]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^{;=]+)?\\{\\s*$`), 'method'],
];
const PY: Pattern[] = [
  [/^(?:async\s+)?def\s+([A-Za-z]\w*)/, 'function'],
  [/^\s+(?:async\s+)?def\s+([A-Za-z]\w*)/, 'method'],
  [/^\s*class\s+([A-Za-z]\w*)/, 'class'],
  [/^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=/, 'const'],
];
const GO: Pattern[] = [
  [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'],
  [/^type\s+([A-Za-z_]\w*)/, 'type'],
  [/^(?:const|var)\s+([A-Z]\w*)\s/, 'const'],
];
const RUST: Pattern[] = [
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, 'function'],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type|union)\s+([A-Za-z_]\w*)/, ''],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z_][A-Z0-9_]*)/, 'const'],
];
const JVM: Pattern[] = [
  [/^\s*(?:@\w+\s+)*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial|inline|value|enum|annotation)\s+)*(class|interface|enum|record|struct|object|protocol|trait|extension)\s+([A-Za-z_]\w*)/, ''],
  [/^\s*(?:(?:public|protected|internal|static|override|open|suspend|inline|operator|infix|mutating|class)\s+)*(?:fun|func|def)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, 'function'],
  [/^\s+(?:(?:public|protected|internal|static|final|abstract|override|virtual|async|synchronized|default)\s+)+[\w<>[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/, 'method'],
];
const RUBY: Pattern[] = [
  [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, 'method'],
  [/^\s*(class|module)\s+([A-Z]\w*(?:::\w+)*)/, ''],
];
const PHP: Pattern[] = [
  [/^\s*(?:(?:public|protected|static|abstract|final)\s+)*function\s+([A-Za-z_]\w*)/, 'function'],
  [/^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/, ''],
];
const C: Pattern[] = [
  [/^(?:typedef\s+)?(struct|class|enum|union)\s+([A-Za-z_]\w*)\s*(?:final\s*)?[{:]/, ''],
  [/^#define\s+([A-Za-z_]\w*)/, 'macro'],
  [/^(?!\s|#|typedef\b|return\b|else\b)(?:[\w:*&<>,]+\s+)+\**([A-Za-z_]\w*(?:::~?\w+)*)\s*\([^;]*$/, 'function'],
];
const SHELL: Pattern[] = [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, 'function']];

const LANGUAGES: Record<string, Pattern[]> = {};
const assign = (exts: string, patterns: Pattern[]) => exts.split(' ').forEach((e) => (LANGUAGES[e] = patterns));
assign('.ts .tsx .mts .cts .js .jsx .mjs .cjs .vue .svelte', JS);
assign('.py .pyi', PY);
assign('.go', GO);
assign('.rs', RUST);
assign('.java .kt .kts .cs .scala .swift .dart', JVM);
assign('.rb', RUBY);
assign('.php', PHP);
assign('.c .h .cc .cpp .cxx .hpp .hh', C);
assign('.sh .bash .zsh', SHELL);

const KEYWORDS = new Set(
  'if else for while do switch case catch try return new function constructor super this typeof await yield import export from default with sizeof elif except match when unless'.split(' '),
);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'coverage', 'target', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'Pods', 'DerivedData']);
const MAX_FILE_BYTES = 512_000;
const MAX_FILES = 6000;
const WINDOW = 6;
/** Files stat'ed and read at once on a full index. */
const IO_CONCURRENCY = 32;
/** After edits only the edited files are re-read; outside the workspace, unless the last full listing is older than this. */
const RELIST_MS = 30_000;

/** Whether a file is source code in a language the index understands. */
export const isSourceFile = (file: string) => !!LANGUAGES[path.extname(file).toLowerCase()];

/** The definitions in one file's text, for a file extension. */
export function extractSymbols(text: string, ext: string): CodeSymbol[] {
  const patterns = LANGUAGES[ext.toLowerCase()];
  if (!patterns) {
    return [];
  }
  const out: CodeSymbol[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) {
      continue;
    }
    for (const [re, kind] of patterns) {
      const m = re.exec(line);
      if (!m) {
        continue;
      }
      // Patterns with an empty kind capture the keyword first, then the name.
      const [k, name] = kind ? [kind, m[1]] : [m[1], m[2]];
      if (name && !KEYWORDS.has(name) && !name.startsWith('_')) {
        out.push({ name, kind: k, line: i + 1, signature: line.trim().replace(/\s*[{:]\s*$/, '').replace(/\s+/g, ' ') });
      }
      break;
    }
  }
  return out;
}

/** A line as compared for duplicates, or '' for lines too trivial to count. */
function normalize(line: string): string {
  const t = line.trim().replace(/\s+/g, ' ');
  if (t.length < 4 || /^(\/\/|#|\*|\/\*|--|<!--)/.test(t)) {
    return '';
  }
  return t;
}

/** Hashes of every run of WINDOW consecutive non-trivial lines. */
export function lineWindows(text: string): Window[] {
  const kept: { text: string; line: number }[] = [];
  text.split('\n').forEach((line, i) => {
    const n = normalize(line);
    if (n) {
      kept.push({ text: n, line: i + 1 });
    }
  });
  const out: Window[] = [];
  for (let i = 0; i + WINDOW <= kept.length; i++) {
    const slice = kept.slice(i, i + WINDOW);
    out.push({ hash: createHash('sha1').update(slice.map((k) => k.text).join('\n')).digest('base64'), start: slice[0].line, end: slice[WINDOW - 1].line });
  }
  return out;
}

/**
 * `p` relative to `root`, with forward slashes (how the index names files).
 * Claude Code passes tools resolved paths, so a workspace reached through a
 * symlink (macOS's /var → /private/var, a linked project folder) is compared
 * with symlinks resolved too.
 */
export function relPath(root: string, p: string): string {
  const full = path.resolve(root, p);
  let rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    rel = path.relative(resolvedPath(root), resolvedPath(full));
  }
  return rel.split(path.sep).join('/');
}

/**
 * The absolute path of a workspace file the agent named. The code tools are
 * auto-approved, so unlike Read they must not reach outside the workspace,
 * through `..`, an absolute path or a symlink.
 */
export function workspacePath(root: string, p: string): string {
  const full = path.resolve(root, p);
  const inside = (base: string, target: string) => {
    const rel = path.relative(base, target);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  // Both: the path as given, and with symlinks resolved (so neither `..` nor a link can leave).
  if (!(inside(root, full) || inside(resolvedPath(root), full)) || !inside(resolvedPath(root), resolvedPath(full))) {
    throw new Error(`${p} is outside the workspace; these tools only read workspace files. Use Read for other files.`);
  }
  return full;
}

const outside = (rel: string) => rel === '..' || rel.startsWith('../') || path.isAbsolute(rel);

/** A path an agent named, placed for the code tools. */
export interface Target {
  /** What to index it against: the workspace, else its git repo, else its folder. */
  root: string;
  abs: string;
  /** Relative to root, forward slashes; '' for the root itself. */
  rel: string;
  isDir: boolean;
  /** Root is the workspace or a git repo (not just the path's folder). */
  inRepo: boolean;
}

/**
 * Where `p` (relative to the workspace, absolute, or ~) is: a path outside the
 * workspace is placed in its own git repo, so a chat opened in one repo can
 * look at another. Throws, naming what it tried, when nothing is there.
 */
export function resolveTarget(workspace: string, p: string): Target {
  const given = p.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  const abs = path.resolve(workspace, given);
  let isDir: boolean;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {
    throw new Error(path.isAbsolute(given) ? `${p} not found.` : `${p} not found (tried ${abs}). For another repo, give an absolute path.`);
  }
  const rel = relPath(workspace, abs);
  if (!outside(rel)) {
    return { root: workspace, abs, rel, isDir, inRepo: true };
  }
  const dir = isDir ? abs : path.dirname(abs);
  const repo = repoRootOf(dir);
  const root = repo ?? dir;
  return { root, abs, rel: relPath(root, abs), isDir, inRepo: !!repo };
}

/** Where each window hash occurs: the file and the window's position in it. */
export type WindowMap = Map<string, { file: IndexedFile; idx: number }[]>;

function mapWindows(map: WindowMap, file: IndexedFile) {
  file.windows.forEach((w, idx) => {
    const list = map.get(w.hash);
    if (list) {
      list.push({ file, idx });
    } else {
      map.set(w.hash, [{ file, idx }]);
    }
  });
}

function unmapWindows(map: WindowMap, file: IndexedFile) {
  for (const { hash } of file.windows) {
    const list = map.get(hash)?.filter((o) => o.file !== file);
    if (list?.length) {
      map.set(hash, list);
    } else {
      map.delete(hash);
    }
  }
}

/** The window map of `files`, built from scratch. */
export function windowMap(files: IndexedFile[]): WindowMap {
  const map: WindowMap = new Map();
  files.forEach((f) => mapWindows(map, f));
  return map;
}

interface Entry {
  stamp: string;
  file: IndexedFile;
}

/** Index entries for one root, keyed by relative path, and its pending save. */
interface RootIndex {
  entries: Map<string, Entry>;
  timer?: NodeJS.Timeout;
  /** Kept in step with entries once built, so duplicate checks don't rehash the repo. */
  windows?: WindowMap;
  /** When the files were last listed (0: not this session). */
  listedAt: number;
  /** Inside a workspace folder: the watcher sets `stale` when a file is created or deleted. */
  watched: boolean;
  stale: boolean;
}

function setEntry(index: RootIndex, rel: string, entry: Entry) {
  const old = index.entries.get(rel);
  if (old && index.windows) {
    unmapWindows(index.windows, old.file);
  }
  index.entries.set(rel, entry);
  if (index.windows) {
    mapWindows(index.windows, entry.file);
  }
}

function dropEntry(index: RootIndex, rel: string) {
  const old = index.entries.get(rel);
  if (old && index.windows) {
    unmapWindows(index.windows, old.file);
  }
  index.entries.delete(rel);
}

/** Per repository root; loaded from disk on first use so a new session doesn't re-read every file. */
/** Entries are added as each file is indexed, so `cachedIndex` sees a partly built index. */
const cache = new Map<string, Promise<RootIndex>>();
/** The same indexes once loaded, for callers that must not wait (cachedIndex). */
const ready = new Map<string, RootIndex>();
/** One watcher over the workspace folders, made with the first workspace index. */
let watcher: vscode.Disposable | undefined;

/** Whether `root` is in a workspace folder and so watched; outside them the index is relisted after RELIST_MS. */
function watch(root: string): boolean {
  try {
    // Loaded here: the reuse and analysis modules use this file outside VS Code too.
    const vscode: typeof import('vscode') = require('vscode');
    if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))) {
      return false;
    }
    if (!watcher) {
      const files = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
      const changed = (uri: vscode.Uri) => markStale(uri.fsPath);
      watcher = vscode.Disposable.from(files, files.onDidCreate(changed), files.onDidDelete(changed));
    }
    return true;
  } catch {
    // Not running in VS Code (or a test without a watcher).
    return false;
  }
}

/** A source file (or a folder, which may hold some) appeared or went: its root lists again on the next edit check. */
function markStale(file: string) {
  if (!isSourceFile(file) && path.extname(file)) {
    return;
  }
  for (const [root, pending] of cache) {
    const rel = path.relative(root, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).some((part) => SKIP_DIRS.has(part) || part.startsWith('.'))) {
      void pending.then((index) => (index.stale = true));
    }
  }
}

const INDEX_FILE = 'index-v1.json';
const MAX_INDEX_BYTES = 50 * 1024 * 1024;
const SAVE_DELAY_MS = 2000;

const savedIndex = (root: string) => workPath(root, 'index', INDEX_FILE);

const isSymbol = (s: unknown): s is CodeSymbol => {
  const o = s as CodeSymbol;
  return !!o && typeof o.name === 'string' && typeof o.kind === 'string' && typeof o.line === 'number' && typeof o.signature === 'string';
};
const isWindow = (w: unknown) => Array.isArray(w) && w.length === 3 && typeof w[0] === 'string' && typeof w[1] === 'number' && typeof w[2] === 'number';

/** One saved entry, or undefined when it isn't the expected shape (the file can be edited or written by another version). */
function parseEntry(rel: string, e: unknown): Entry | undefined {
  const o = e as { stamp: unknown; symbols: unknown[]; idents: unknown[]; windows: unknown[] };
  if (!o || typeof o.stamp !== 'string' || !Array.isArray(o.symbols) || !Array.isArray(o.idents) || !Array.isArray(o.windows)) {
    return undefined;
  }
  if (!o.symbols.every(isSymbol) || !o.idents.every((i) => typeof i === 'string') || !o.windows.every(isWindow)) {
    return undefined;
  }
  const windows = (o.windows as [string, number, number][]).map(([hash, start, end]) => ({ hash, start, end }));
  return { stamp: o.stamp, file: { rel, symbols: o.symbols, idents: new Set(o.idents as string[]), windows } };
}

/** The saved index for `root`; empty when there is none or it's corrupt. */
async function loadIndex(root: string): Promise<RootIndex> {
  const entries = new Map<string, Entry>();
  try {
    const file = savedIndex(root);
    if ((await fs.promises.stat(file)).size <= MAX_INDEX_BYTES) {
      const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (data?.version === 1 && data.files && typeof data.files === 'object') {
        for (const [rel, e] of Object.entries(data.files)) {
          const entry = parseEntry(rel, e);
          if (entry) {
            entries.set(rel, entry);
          }
        }
      }
    }
  } catch {
    // Missing or unreadable: index from scratch.
  }
  return { entries, listedAt: 0, watched: watch(root), stale: false };
}

/** Writes the index for `root`; best effort, since the index can always be rebuilt. Windows are saved as tuples to keep the file small. */
function saveIndex(root: string, entries: Map<string, Entry>) {
  const files: Record<string, unknown> = {};
  for (const [rel, { stamp, file }] of entries) {
    files[rel] = { stamp, symbols: file.symbols, idents: [...file.idents], windows: file.windows.map((w) => [w.hash, w.start, w.end]) };
  }
  try {
    const text = JSON.stringify({ version: 1, files });
    if (Buffer.byteLength(text) > MAX_INDEX_BYTES) {
      fs.rmSync(savedIndex(root), { force: true });
      return;
    }
    workFolder(root, 'index');
    writeAtomic(savedIndex(root), text);
  } catch {
    // A read-only workspace: keep the in-memory index only.
  }
}

/** Saves after a quiet spell, so a run of edits (each re-indexing) writes once. */
function scheduleSave(root: string, index: RootIndex) {
  clearTimeout(index.timer);
  index.timer = setTimeout(() => {
    index.timer = undefined;
    saveIndex(root, index.entries);
  }, SAVE_DELAY_MS);
  index.timer.unref();
}

/** Writes any pending index saves now and stops the watcher (on shutdown, and in tests). */
export async function flushIndex() {
  watcher?.dispose();
  watcher = undefined;
  for (const [root, pending] of cache) {
    const index = await pending;
    index.watched = false;
    if (index.timer) {
      clearTimeout(index.timer);
      index.timer = undefined;
      saveIndex(root, index.entries);
    }
  }
}

/** Forgets the in-memory index, as a new session would; pending saves are dropped. */
export function resetIndexCacheForTests() {
  watcher?.dispose();
  watcher = undefined;
  for (const pending of cache.values()) {
    void pending.then((index) => clearTimeout(index.timer));
  }
  cache.clear();
  ready.clear();
}

/** Source files under `root`: git's view (tracked plus untracked, not ignored) when available. */
async function listSourceFiles(root: string): Promise<string[]> {
  let files: string[];
  try {
    const { stdout } = await promisify(execFile)('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
    files = stdout.split('\0').filter(Boolean);
  } catch {
    // Not a git repository: walk it, skipping dependency, build and hidden folders. Symlinked folders aren't followed.
    files = [];
    const walk = async (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES * 2) {
          return;
        }
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(rel);
        } else if (entry.isFile()) {
          files.push(rel);
        }
      }
    };
    await walk('');
  }
  return files
    .filter((f) => LANGUAGES[path.extname(f).toLowerCase()] && !/\.min\.\w+$/.test(f) && !f.split('/').some((part) => SKIP_DIRS.has(part)))
    .slice(0, MAX_FILES);
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** `rel`'s entry: `hit` when unchanged, a fresh one when changed, undefined when missing, too large or unreadable. */
async function readEntry(root: string, rel: string, hit?: Entry): Promise<Entry | undefined> {
  const abs = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(abs);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    return undefined;
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (hit?.stamp === stamp) {
    return hit;
  }
  let text: string;
  try {
    text = await fs.promises.readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
  return { stamp, file: { rel, symbols: extractSymbols(text, path.extname(rel)), idents: new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []), windows: lineWindows(text) } };
}

function rootIndex(root: string): Promise<RootIndex> {
  const resolved = path.resolve(root);
  if (resolved === os.homedir() || resolved === path.parse(resolved).root) {
    throw new Error(`Won't index ${resolved === os.homedir() ? 'your home folder' : resolved}; open a project folder or name a path inside a project.`);
  }
  if (!cache.has(root)) {
    cache.set(root, loadIndex(root).then((index) => (ready.set(root, index), index)));
  }
  return cache.get(root)!;
}

/**
 * Every source file under `root`, indexed. Async so a large repository doesn't
 * block VS Code's extension host; unchanged files come from the cache.
 */
export async function indexRepo(root: string): Promise<IndexedFile[]> {
  // Files created or deleted from here on are caught by this listing or mark it stale again.
  const loaded = rootIndex(root).then((index) => ((index.stale = false), index));
  const [listed, index] = await Promise.all([listSourceFiles(root), loaded]);
  const keep = new Set(listed);
  let changed = false;
  for (const rel of [...index.entries.keys()]) {
    if (!keep.has(rel)) {
      dropEntry(index, rel);
      changed = true;
    }
  }
  const read = await mapLimit(listed, IO_CONCURRENCY, (rel) => readEntry(root, rel, index.entries.get(rel)));
  const out: IndexedFile[] = [];
  read.forEach((entry, i) => {
    const rel = listed[i];
    if (!entry) {
      // Kept out of entries too, so entries always match what the last listing returned.
      if (index.entries.has(rel)) {
        dropEntry(index, rel);
        changed = true;
      }
      return;
    }
    if (entry !== index.entries.get(rel)) {
      setEntry(index, rel, entry);
      changed = true;
    }
    out.push(entry.file);
  });
  index.listedAt = Date.now();
  if (changed) {
    scheduleSave(root, index);
  }
  return out;
}

/**
 * The index after edits to `files` (absolute): when `root` already holds them
 * and its listing is current (in the workspace: no file created or deleted
 * since; outside it: listed in the last RELIST_MS), only they are re-read;
 * otherwise it's a full indexRepo.
 */
export async function refreshIndex(root: string, files: string[]): Promise<IndexedFile[]> {
  const index = await rootIndex(root);
  const rels = files.map((f) => relPath(root, f));
  const stale = index.watched ? index.stale : Date.now() - index.listedAt > RELIST_MS;
  if (!index.listedAt || stale || !rels.every((r) => index.entries.has(r))) {
    return indexRepo(root);
  }
  let changed = false;
  for (const rel of rels) {
    const entry = await readEntry(root, rel, index.entries.get(rel));
    if (!entry) {
      return indexRepo(root);
    }
    if (entry !== index.entries.get(rel)) {
      setEntry(index, rel, entry);
      changed = true;
    }
  }
  if (changed) {
    scheduleSave(root, index);
  }
  return [...index.entries.values()].map((e) => e.file);
}

/** The index built so far, without reading any file; undefined until the first indexRepo for `root`. */
export function cachedIndex(root: string): IndexedFile[] | undefined {
  const index = ready.get(root);
  return index && !index.stale ? [...index.entries.values()].map((e) => e.file) : undefined;
}

/** `root`'s window map, kept up to date by indexRepo and refreshIndex; call after one of them. */
export async function indexWindows(root: string): Promise<WindowMap> {
  const index = await rootIndex(root);
  return (index.windows ??= windowMap([...index.entries.values()].map((e) => e.file)));
}

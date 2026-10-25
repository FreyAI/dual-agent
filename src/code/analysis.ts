/**
 * The repository analyses behind code_map and find_duplicates, on an index from
 * repoIndex.ts: ranking definitions by how widely they are used, and finding
 * blocks that appear twice. No VS Code dependency, so the edit check and
 * scripts can use them too.
 */
import { short } from '../text';
import { CodeSymbol, IndexedFile, WindowMap, windowMap } from './repoIndex';

/** About 1,000 tokens: Aider's default map budget. */
const MAP_CHARS = 4000;
/** SWE-agent: a capped list with "narrow it" beats paging. */
export const REFERENCE_CAP = 50;
export const DUPLICATE_CAP = 20;

interface Ranked extends CodeSymbol {
  file: string;
  /** Other files that mention the name. */
  users: number;
  /** Query words it matches; ranks before score. */
  hits: number;
  score: number;
}

/** What the agent is working on: files it edited or the user has open, and words from the prompt. */
export interface Focus {
  files?: string[];
  words?: string[];
}

/** Words in an identifier or path: `parseHttpHeader` → parse, http, header. */
const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Paths of test files and folders. */
export const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.\w+$/;

/**
 * How much a name's use counts, after Aider's repo map weights: names in
 * active files, names the prompt mentions and distinctive names (long
 * camelCase or snake_case) count more; private names, names defined in many
 * files, very short names, methods and test code count less, since a bare
 * name match says little about them.
 */
function weight(s: CodeSymbol, file: string, definedIn: number, active: Set<string>, mentioned: Set<string>): number {
  let w = 1;
  if (active.has(file)) {
    w *= 50;
  }
  if (mentioned.has(s.name)) {
    w *= 10;
  }
  if (s.name.length >= 8 && /[a-z][A-Z]|_/.test(s.name)) {
    w *= 10;
  }
  if (s.name.startsWith('_')) {
    w *= 0.1;
  }
  if (definedIn > 5) {
    w *= 0.1;
  }
  if (s.name.length < 4) {
    w *= 0.1;
  }
  if (s.kind === 'method') {
    w *= 0.3;
  }
  if (TEST_PATH.test(file)) {
    w *= 0.1;
  }
  return w;
}

/** Identifiers as written in a query or prompt: `fix rankSymbols()` → fix, rankSymbols. */
const identifiers = (s: string) => s.split(/[^A-Za-z0-9_$]+/).filter(Boolean);

/** The definitions to show, best first: matches for the query, else the most widely used, weighted toward the focus. */
export function rankSymbols(files: IndexedFile[], query?: string, under?: string, focus: Focus = {}): Ranked[] {
  const active = new Set(focus.files ?? []);
  const mentioned = new Set([...(focus.words ?? []).flatMap(identifiers), ...identifiers(query ?? '')]);
  const fileCount = new Map<string, number>();
  const definedIn = new Map<string, number>();
  for (const f of files) {
    for (const id of f.idents) {
      fileCount.set(id, (fileCount.get(id) ?? 0) + 1);
    }
    for (const name of new Set(f.symbols.map((s) => s.name))) {
      definedIn.set(name, (definedIn.get(name) ?? 0) + 1);
    }
  }
  const terms = query ? words(query) : [];
  const out: Ranked[] = [];
  for (const f of files) {
    if (under && !(f.rel === under || f.rel.startsWith(`${under.replace(/\/$/, '')}/`))) {
      continue;
    }
    for (const s of f.symbols) {
      const users = Math.max(0, (fileCount.get(s.name) ?? 1) - 1);
      // The 0.1 lets unused definitions, such as ones just written, still rank by weight.
      const score = (users + 0.1) * weight(s, f.rel, definedIn.get(s.name) ?? 1, active, mentioned);
      let hits = 0;
      if (terms.length) {
        const hay = new Set([...words(s.name), ...words(f.rel)]);
        const name = s.name.toLowerCase();
        hits = terms.filter((t) => hay.has(t) || name.includes(t)).length;
        if (!hits) {
          continue;
        }
      }
      out.push({ ...s, file: f.rel, users, hits, score });
    }
  }
  return out.sort((a, b) => b.hits - a.hits || b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
}

const entry = (s: Ranked) => `  L${s.line} ${short(s.signature, 110)}${s.users ? `  [${s.users}]` : ''}`;

/** Groups ranked definitions by file, within a character budget. */
export function renderMap(ranked: Ranked[], budget = MAP_CHARS): { text: string; shown: number } {
  const byFile = new Map<string, Ranked[]>();
  let used = 0;
  let shown = 0;
  for (const s of ranked) {
    const line = `${entry(s)}\n`;
    const head = byFile.has(s.file) ? 0 : s.file.length + 1;
    if (used + line.length + head > budget) {
      break;
    }
    used += line.length + head;
    shown++;
    byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  }
  const text = [...byFile]
    .map(([file, syms]) => `${file}\n${syms.sort((a, b) => a.line - b.line).map(entry).join('\n')}`)
    .join('\n');
  return { text, shown };
}

/** The code_map answer: the map within a budget (×4 for an overview), and how many definitions were left out. */
export function mapReport(ranked: Ranked[], query?: string, budget = query ? MAP_CHARS : MAP_CHARS * 4): string {
  const { text, shown } = renderMap(ranked, budget);
  return `${text}${ranked.length > shown ? `\n(${ranked.length - shown} more; narrow with query or path.)` : ''}`;
}

/** The first `max` items across groups, in order, and how many items were left out and in how many groups. */
export function capGroups<T>(groups: [string, T[]][], max: number): { shown: [string, T[]][]; more: number; moreGroups: number } {
  const shown: [string, T[]][] = [];
  let left = max;
  let more = 0;
  let moreGroups = 0;
  for (const [key, items] of groups) {
    const take = items.slice(0, Math.max(0, left));
    if (take.length) {
      shown.push([key, take]);
    }
    if (take.length < items.length) {
      more += items.length - take.length;
      moreGroups++;
    }
    left -= take.length;
  }
  return { shown, more, moreGroups };
}

export interface Duplicate {
  file: string;
  start: number;
  end: number;
  other: string;
  otherStart: number;
  otherEnd: number;
}

/**
 * Blocks of at least `minLines` non-trivial lines that appear twice. With a
 * `target` file, only blocks in it (copied from anywhere); with a list of
 * files, blocks in any of them; otherwise every pair in the repository. A pair
 * with both sides checked is reported once. `where` is the files' window map
 * when one is kept (repoIndex's indexWindows); files not in `files` are ignored.
 */
export function findDuplicates(files: IndexedFile[], target?: string | string[], minLines = 8, where: WindowMap = windowMap(files)): Duplicate[] {
  const order = new Map(files.map((f, i) => [f, i]));
  const scope = Array.isArray(target) ? new Set(target) : undefined;
  const out: Duplicate[] = [];
  files.forEach((f, a) => {
    if (target !== undefined && (scope ? !scope.has(f.rel) : f.rel !== target)) {
      return;
    }
    // A run is a diagonal: window i in this file lines up with window j in another, then i+1 with j+1, ...
    const runs = new Map<string, { i0: number; i1: number; j0: number; j1: number; b: number }>();
    const done: { i0: number; i1: number; j0: number; j1: number; b: number }[] = [];
    f.windows.forEach((w, i) => {
      for (const { file, idx: j } of where.get(w.hash) ?? []) {
        const b = order.get(file);
        if (b === undefined) {
          continue;
        }
        const once = typeof target !== 'string' && (!scope || scope.has(file.rel));
        if (b === a ? Math.abs(j - i) < 6 || (once && j < i) : once && b < a) {
          continue;
        }
        const key = `${b}:${j - i}`;
        const run = runs.get(key);
        if (run && run.i1 === i - 1) {
          run.i1 = i;
          run.j1 = j;
        } else {
          if (run) {
            done.push(run);
          }
          runs.set(key, { i0: i, i1: i, j0: j, j1: j, b });
        }
      }
    });
    done.push(...runs.values());
    for (const r of done) {
      const other = files[r.b];
      const start = f.windows[r.i0].start;
      const end = f.windows[r.i1].end;
      if (end - start + 1 >= minLines) {
        out.push({ file: f.rel, start, end, other: other.rel, otherStart: other.windows[r.j0].start, otherEnd: other.windows[r.j1].end });
      }
    }
  });
  return out.sort((x, y) => y.end - y.start - (x.end - x.start));
}

/** find_duplicates' answer, capped at DUPLICATE_CAP blocks. */
export function duplicatesReport(found: Duplicate[]): string {
  const lines = found.slice(0, DUPLICATE_CAP).map((d) => `${d.file} L${d.start}-${d.end} = ${d.other} L${d.otherStart}-${d.otherEnd} (${d.end - d.start + 1} lines)`);
  const more = found.length - lines.length;
  return `${lines.join('\n')}${more > 0 ? `\n… ${more} more duplicated blocks; narrow with a path or a larger min_lines, or fix the largest first.` : ''}`;
}

/**
 * A short "likely relevant" map for a message that names no file: it ranks the
 * repository index (repoIndex.ts) by the words of the message, so the agent
 * opens the right files first instead of grepping for them. Definitions only,
 * never file bodies, and it gives up rather than hold a turn when the index is
 * cold.
 */
import type { CodeSymbol, IndexedFile } from './repoIndex';
import type { ContentBlock } from '../context';

/** About 300 tokens. */
export const RETRIEVAL_CHARS = 1200;
export const RETRIEVAL_FILES = 8;
/** The words the message must share with the code; below two, a path listing is noise. */
const MIN_SCORE = 4;

const STOP = new Set(
  'the and for with that this from are was were have has had not but you your our its can could should would will shall may might must been being into out over under about after before again all any as at be by did do does done each else even every few get got here how if in is it just let like make many more most much need new no now off on once only or other own per put same see set she some such than then there these they thing think those through to too try two up use used using very want way we well what when where which while who why work would yet also please help add change check code file files make sure want need still really'.split(
    ' ',
  ),
);

/** Integer hash (FNV-1a), for a stable tie-break. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

/** `rankFiles` once canonical: a matching definition. */
interface Hit {
  name: string;
  line: number;
  score: number;
}

export interface RankedFile {
  rel: string;
  /** Definitions of this file that match, best first. */
  symbols: CodeSymbol[];
  score: number;
}

/** Whether the message names a file the index knows, so nothing needs to be guessed. */
export function namesIndexedFile(files: IndexedFile[], message: string): boolean {
  const known = new Set(files.map((f) => f.rel));
  const paths = message.match(/[\w./\\-]+\.[A-Za-z0-9]+/g) ?? [];
  return paths.some((p) => known.has(p.replace(/\\/g, '/').replace(/^\.\//, '')) || files.some((f) => f.rel.endsWith(`/${p}`)));
}

/**
 * The files most likely involved in `message`, best first: exact definition
 * names and path words in the message count most, then a definition used in this
 * file (one-hop: related files share identifiers), then words of a definition
 * name. `recent` files (open in the editor, edited in this chat) get a boost.
 * Synchronous and deterministic, so it is easy to test.
 */
export function rankFiles(files: IndexedFile[], message: string, recent: string[] = [], limit = RETRIEVAL_FILES): RankedFile[] {
  if (!files.length) {
    return [];
  }
  const wordsOf = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .split(/[^A-Za-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase()))
      .map((w) => w.toLowerCase());
  const msgWords = new Set(wordsOf(message));
  const idents = new Set([...message.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase())));
  const msgText = ` ${message.toLowerCase()} `;
  const recentSet = new Set(recent);
  if (!msgWords.size) {
    return [];
  }
  // The definition names of the repository, and the identifiers files use.
  const defs = new Set(files.flatMap((f) => f.symbols.map((s) => s.name)));
  const users = new Set(files.flatMap((f) => [...f.idents]));
  // One hop: identifiers the message names are also weighted by how many files use them.
  const linked = new Set([...idents].filter((id) => users.has(id) && !STOP.has(id.toLowerCase())));
  const hopScore = (f: IndexedFile) => [...f.idents].filter((id) => linked.has(id) && !defs.has(id)).length;
  const out: RankedFile[] = [];
  for (const f of files) {
    const base = f.rel.replace(/[^A-Za-z0-9]+/g, ' ').toLowerCase();
    const stem = f.rel.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
    const pathScore = wordsOf(base).filter((w) => msgWords.has(w)).length + (msgText.includes(` ${stem} `) ? 10 : 0);
    const hits: Hit[] = [];
    for (const s of f.symbols) {
      let score = 0;
      if (idents.has(s.name)) {
        score = 10;
      } else if (msgText.includes(s.name.toLowerCase())) {
        score = 8;
      } else {
        score = wordsOf(s.name).filter((w) => msgWords.has(w)).length * 2;
      }
      if (score) {
        hits.push({ name: s.name, line: s.line, score });
      }
    }
    // Names the whole codebase uses say little about which file to open.
    const shared = Math.max(0, hits.length - 3);
    let score = pathScore + hits.reduce((n, h) => n + h.score, 0) + Math.min(hopScore(f), 5) - shared * 6;
    if (recentSet.has(f.rel)) {
      score += 5;
    }
    if (score >= MIN_SCORE) {
      hits.sort((a, b) => b.score - a.score || a.line - b.line);
      const byName = new Map(hits.map((h) => [h.name, h]));
      out.push({ rel: f.rel, symbols: f.symbols.filter((s) => byName.has(s.name)).sort((a, b) => byName.get(b.name)!.score - byName.get(a.name)!.score || a.line - b.line).slice(0, 4), score });
    }
  }
  return out.sort((a, b) => b.score - a.score || hash(a.rel) - hash(b.rel)).slice(0, Math.max(0, limit));
}

/** Prepends the block to a turn's first prompt, above the editor context and the user's own words. */
export function withRelevant<T extends string | ContentBlock[]>(prompt: T, block: string): T {
  return (typeof prompt === 'string' ? `${block}\n\n${prompt}` : [{ type: 'text', text: block }, ...prompt]) as T;
}

/**
 * The "Likely relevant" block for a message, within `cap` characters, or
 * undefined when nothing ranks. A file line is dropped rather than cut, and
 * the last line may lose names, so the block never exceeds the cap.
 */
export function retrievalBlock(files: IndexedFile[], message: string, recent: string[], cap = RETRIEVAL_CHARS): string | undefined {
  if (namesIndexedFile(files, message)) {
    return undefined;
  }
  const ranked = rankFiles(files, message, recent);
  if (!ranked.length) {
    return undefined;
  }
  const head = '<likely_relevant>\nFiles this request may involve (definitions, from the repository index):\n';
  const tail = '\nRead only the parts you need; code_map with a query lists more.</likely_relevant>';
  const budget = cap - head.length - tail.length;
  const lines: string[] = [];
  let used = 0;
  for (const f of ranked) {
    const names = f.symbols.map((s) => `${s.name} L${s.line}`);
    const line = (show: number) => `${f.rel}: ${names.slice(0, show).join(', ')}${show < names.length ? ' (more)' : ''}`;
    let show = names.length;
    while (show > 0 && used + line(show).length + 1 > budget) {
      show--;
    }
    if (!show) {
      break;
    }
    lines.push(line(show));
    used += line(show).length + 1;
  }
  return `${head}${lines.join('\n')}${tail}`;
}

/**
 * Moves the path-specific parts of a CLAUDE.md into `.claude/rules/*.md` files
 * with `paths:` frontmatter. Claude Code loads every CLAUDE.md (and its
 * @imports) at launch, but a path-scoped rule only when Claude touches a
 * matching file, so the split saves context without rewriting a word.
 * Format: https://code.claude.com/docs/en/memory#path-specific-rules
 */
import * as fs from 'fs';
import * as path from 'path';
import { compressRefusal } from '../lean';
import { writeAtomic } from '../memory/files';

export interface RuleFile {
  /** `.claude/rules/<slug>.md`, relative to the workspace root. */
  path: string;
  /** Globs for the `paths:` frontmatter. */
  paths: string[];
  /** The full file: frontmatter plus the section, verbatim. */
  body: string;
}

export interface SplitPlan {
  /** The new CLAUDE.md text. */
  keep: string;
  rules: RuleFile[];
  movedLines: number;
  keptLines: number;
}

export const RULES_DIR = path.join('.claude', 'rules');

/** Headings that describe the whole project; they stay unless the heading itself names a path. */
const GENERAL_HEADING = /\b(overview|about|summary|introduction|architecture|layout|structure|build|commands?|setup|install|getting started|conventions?|style|general|security|secrets?|git|commits?|workflow|deploy|environment|principles?)\b/i;

/** Language names that map to an extension, trusted only in headings ("## Swift tests"). */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  swift: ['swift'], typescript: ['ts', 'tsx'], javascript: ['js', 'jsx'], python: ['py'], kotlin: ['kt'],
  rust: ['rs'], ruby: ['rb'], java: ['java'], golang: ['go'], php: ['php'], scala: ['scala'],
  dart: ['dart'], elixir: ['ex', 'exs'], 'objective-c': ['m', 'mm'], css: ['css', 'scss'], sql: ['sql'],
};

/** More globs than this reads as a project tour, not a scoped section. */
const MAX_GLOBS = 4;
/** A rule that would load for more than this share of the repo is effectively general. */
const MAX_COVERAGE = 0.5;

const PATH_TOKEN = /(?<![\w@:/.\\-])(?:\.\/)?([A-Za-z0-9_*][\w.*-]*(?:\/[\w.*-]+)*)(\/?)/g;
const EXT_TOKEN = /(?:\*\.|`\.)([A-Za-z0-9]{1,10})\b/g;

interface Section {
  heading: string;
  level: number;
  lines: string[];
}

/** Splits Markdown at `#`/`##` headings outside code fences; deeper headings stay with their parent. */
function sections(text: string): Section[] {
  const out: Section[] = [{ heading: '', level: 0, lines: [] }];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) {
      fence = fence ? undefined : marker;
    }
    const head = !fence && !marker ? /^(#{1,2})\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (head) {
      out.push({ heading: head[2], level: head[1].length, lines: [] });
    }
    out[out.length - 1].lines.push(line);
  }
  return out;
}

/** A glob as a RegExp over forward-slash paths: `**`, `*`, `?` and `{a,b}`. */
export function globRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(?:';
    } else if (c === '}') {
      re += ')';
    } else if (c === ',' && re.lastIndexOf('(?:') > re.lastIndexOf(')')) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (file: string, globs: RegExp[]) => globs.some((g) => g.test(file));

/** The glob for one mentioned path, or undefined when it names nothing in the repo. */
function globForPath(token: string, files: string[], dirs: Set<string>): string | undefined {
  const p = token.replace(/[.…]+$/u, '').replace(/\/\*\*?$/, '').replace(/\/+$/, '');
  if (!p || p === '*' || p === '**') {
    return undefined;
  }
  if (p.includes('*')) {
    const re = globRegex(p);
    return files.some((f) => re.test(f)) ? p : undefined;
  }
  if (dirs.has(p)) {
    return `${p}/**`;
  }
  if (files.includes(p)) {
    return p;
  }
  const nested = [...dirs].filter((d) => d.endsWith(`/${p}`));
  return nested.length === 1 && p.includes('/') ? `${nested[0]}/**` : undefined;
}

/** Globs a section clearly points at, inferred only from paths and extensions present in the repo. */
function inferGlobs(section: Section, files: string[], dirs: Set<string>, exts: Set<string>): string[] {
  const text = section.lines.join('\n');
  const globs = new Set<string>();
  for (const m of text.matchAll(PATH_TOKEN)) {
    if (m[1].includes('/') || m[2]) {
      const glob = globForPath(m[1], files, dirs);
      if (glob) {
        globs.add(glob);
      }
    }
  }
  const named = [...text.matchAll(EXT_TOKEN)].map((m) => m[1].toLowerCase());
  for (const word of section.heading.toLowerCase().match(/[a-z-]+/g) ?? []) {
    named.push(...(LANGUAGE_EXTENSIONS[word] ?? []));
  }
  for (const ext of named) {
    if (exts.has(ext)) {
      globs.add(`**/*.${ext}`);
    }
  }
  return pruneGlobs([...globs], files);
}

/** Drops globs whose matching files broader globs already cover. */
function pruneGlobs(globs: string[], files: string[]): string[] {
  const matched = new Map(globs.map((g) => [g, files.filter((f) => globRegex(g).test(f))]));
  const kept: RegExp[] = [];
  const drop = new Set<string>();
  for (const g of [...globs].sort((a, b) => matched.get(b)!.length - matched.get(a)!.length)) {
    if (matched.get(g)!.every((f) => matchesAny(f, kept))) {
      drop.add(g);
    } else {
      kept.push(globRegex(g));
    }
  }
  return globs.filter((g) => !drop.has(g));
}

function slugify(heading: string): string {
  const slug = heading.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'rule';
}

/** A rule file's text, frontmatter exactly as the docs show it. */
export function ruleText(paths: string[], section: string): string {
  return `---\npaths:\n${paths.map((p) => `  - ${JSON.stringify(p)}`).join('\n')}\n---\n\n${section}\n`;
}

const lineCount = (s: string) => (s ? s.split('\n').length : 0);

/** Which CLAUDE.md sections can become path-scoped rules; pure, nothing is written. */
export function planSplit(claudeMd: string, repoFiles: string[]): SplitPlan {
  const files = repoFiles.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''));
  const dirs = new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  const exts = new Set(files.map((f) => /\.([^./]+)$/.exec(f)?.[1].toLowerCase()).filter((e): e is string => !!e));
  const kept: string[] = [];
  const rules: RuleFile[] = [];
  const slugs = new Set<string>();
  let movedLines = 0;
  for (const s of sections(claudeMd)) {
    const globs = s.level === 2 ? inferGlobs(s, files, dirs, exts) : [];
    const headingOnly = { ...s, lines: [s.heading] };
    const general = GENERAL_HEADING.test(s.heading) && !inferGlobs(headingOnly, files, dirs, new Set()).length;
    const res = globs.map(globRegex);
    const coverage = files.length ? files.filter((f) => matchesAny(f, res)).length / files.length : 1;
    if (!globs.length || general || globs.length > MAX_GLOBS || coverage > MAX_COVERAGE) {
      kept.push(...s.lines);
      continue;
    }
    const section = s.lines.join('\n').replace(/\s+$/, '');
    let slug = slugify(s.heading);
    for (let n = 2; slugs.has(slug); n++) {
      slug = `${slugify(s.heading)}-${n}`;
    }
    slugs.add(slug);
    rules.push({ path: path.posix.join('.claude', 'rules', `${slug}.md`), paths: globs, body: ruleText(globs, section) });
    movedLines += lineCount(section);
  }
  if (!rules.length) {
    return { keep: claudeMd, rules: [], movedLines: 0, keptLines: lineCount(claudeMd.replace(/\n$/, '')) };
  }
  const keep = `${kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
  return { keep, rules, movedLines, keptLines: lineCount(keep.replace(/\n$/, '')) };
}

/** Throws when `file` looks like a secret or isn't Markdown/text. */
function refuseUnsafe(file: string) {
  const why = compressRefusal(file);
  if (why) {
    throw new Error(`Won't write ${file}: ${why}`);
  }
}

/** `base` with `-2`, `-3`… until the file is free or already holds `text`. */
function freePath(file: string, text: string): string {
  const ext = path.extname(file);
  const stem = file.slice(0, -ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? file : `${stem}-${n}${ext}`;
    if (!fs.existsSync(candidate) || fs.readFileSync(candidate, 'utf8') === text) {
      return candidate;
    }
  }
}

/** Backs up CLAUDE.md, writes the rule files (never over different content), then the new CLAUDE.md. */
export function applySplit(root: string, plan: SplitPlan, backupDir: string): { backup: string; written: string[] } {
  const claudeMd = path.join(root, 'CLAUDE.md');
  const rulesDir = path.resolve(root, RULES_DIR);
  const targets = plan.rules.map((r) => path.resolve(root, r.path));
  for (const t of targets) {
    if (path.relative(rulesDir, t).startsWith('..') || path.isAbsolute(path.relative(rulesDir, t))) {
      throw new Error(`Won't write ${t}: it's outside ${rulesDir}.`);
    }
    refuseUnsafe(t);
  }
  if (!plan.rules.length) {
    return { backup: '', written: [] };
  }
  const original = fs.readFileSync(claudeMd, 'utf8');
  const backups = path.resolve(root, backupDir);
  fs.mkdirSync(backups, { recursive: true });
  const backup = path.join(backups, `CLAUDE.md.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  fs.writeFileSync(backup, original, { flag: 'wx' });
  const written: string[] = [];
  plan.rules.forEach((rule, i) => {
    fs.mkdirSync(path.dirname(targets[i]), { recursive: true });
    const file = freePath(targets[i], rule.body);
    if (!fs.existsSync(file)) {
      writeAtomic(file, rule.body);
    }
    written.push(file);
  });
  writeAtomic(claudeMd, plan.keep);
  return { backup, written };
}

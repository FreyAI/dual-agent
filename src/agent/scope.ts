/**
 * Scoped delegation: every helper is started with a declared scope (the files
 * it may edit, the files to read first) and its edits are held to it. A
 * helper that explores freely rebuilds the whole codebase in its own context
 * and its report grows the parent's: on 2026-10-17, 12 unscoped helpers made
 * 1,504 calls at up to 240k tokens each. Pure apart from finding the repos a
 * brief names.
 *
 * A brief may send a helper into another repo ("in ~/code/plugin: Edit only:
 * test/**"): globs then match relative to that repo as well as the workspace.
 * On 2026-10-19, 23 in-scope edits in other repos were refused before this.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { globRegex } from '../rules/split';

export interface Scope {
  /** Globs relative to the workspace or a named repo (or absolute); empty = read-only. */
  edit: string[];
  /** Files (optionally file:lines) to read before anything else. */
  read: string[];
  /** Repos other than the workspace that the brief names: globs also match relative to these. */
  roots?: string[];
}

/** Helper reports past this go back to be condensed (~1.5k tokens): they stay in the parent's context for the rest of the chat. */
export const MAX_REPORT_CHARS = 6_000;

const EDIT_LINE = /^\s*(?:[-*]\s*)?edit only\s*:\s*(.+)$/im;
const READ_LINE = /^\s*(?:[-*]\s*)?read first\s*:\s*(.+)$/im;
const NONE = /^(none|nothing|no files?|read[- ]only|-)$/i;

const list = (text: string) =>
  text
    .replace(/\([^)]*\)/g, ' ')
    .split(/[,;]|\s+and\s+/)
    .map((s) => s.trim().replace(/^[`'"]|[`'".]$/g, ''))
    // "other Tests/*.swift only to remove live tests" → "Tests/*.swift"; prose with no path drops out.
    .map((s) => s.replace(/^([\w-]+) config$/i, '$1.config.*'))
    .map((s) => (/\s/.test(s) ? (s.split(/\s+/).find((t) => /[/*]|\.\w/.test(t)) ?? '') : s))
    .filter(Boolean);

const home = os.homedir();
const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, home);

/** Absolute or ~ paths a brief mentions (e.g. "in /Users/me/code/plugin"). */
const NAMED_PATH = /(?:^|[\s`'"(=:])((?:~|\/)(?:[\w.@+-]+\/?)+)/g;

/** The git repo a path is in (the nearest folder with .git), or undefined. Cached: briefs repeat paths. */
const roots = new Map<string, string | undefined>();
export function repoRootOf(p: string): string | undefined {
  if (roots.has(p)) {
    return roots.get(p);
  }
  let dir = p;
  let found: string | undefined;
  for (let i = 0; i < 40 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      found = dir;
      break;
    }
  }
  roots.set(p, found);
  return found;
}

/** The scope a brief declares, or undefined when it declares none. `rootOf` finds a named path's repo (tests replace it). */
export function parseScope(brief: string, cwd?: string, rootOf: (p: string) => string | undefined = repoRootOf): Scope | undefined {
  const edit = EDIT_LINE.exec(brief)?.[1];
  if (edit === undefined) {
    return undefined;
  }
  const read = READ_LINE.exec(brief)?.[1];
  const scope: Scope = { edit: NONE.test(edit.trim()) ? [] : list(edit), read: read && !NONE.test(read.trim()) ? list(read) : [] };
  const named = new Set<string>();
  for (const m of brief.matchAll(NAMED_PATH)) {
    const root = rootOf(path.resolve(expandHome(m[1].replace(/[.,:;]+$/, ''))));
    // The workspace's own repo adds nothing: globs already match relative to the workspace.
    if (root && !(cwd && (cwd === root || cwd.startsWith(root + path.sep)))) {
      named.add(root);
    }
  }
  if (named.size) {
    scope.roots = [...named];
  }
  return scope;
}

/** A file or glob named in prose: has a slash or an extension, isn't a URL or a version number. */
const MENTIONED = /(?:^|[\s`'"(])((?:~|\.{0,2}\/)?[\w@*?-][\w@*?./-]*(?:\/[\w@*?.-]+|\.[a-z][a-z0-9]{0,7}))(?=[\s`'"),:;]|\.(?:\s|$)|$)/gi;

/**
 * A scope for a brief that has no "Edit only:" line: the files it names. A
 * refusal costs the main agent a whole model call to rewrite the brief, and
 * most briefs already name their files. Undefined when it names none.
 */
export function inferScope(brief: string, cwd?: string, rootOf: (p: string) => string | undefined = repoRootOf): Scope | undefined {
  const files = [...brief.matchAll(MENTIONED)]
    .map((m) => m[1].replace(/[.,:;]+$/, ''))
    .filter((f) => !/^(https?|www)\b/i.test(f) && !/^v?\d+(\.\d+)+$/.test(f) && !/^\d/.test(f));
  if (!files.length) {
    return undefined;
  }
  return parseScope(`Edit only: ${[...new Set(files)].join(', ')}\n${brief}`, cwd, rootOf);
}

/** Why an Agent call is refused: briefs must say which files the helper may edit. */
export function missingScopeReason(input: { prompt?: unknown }): string | undefined {
  if (typeof input.prompt === 'string' && parseScope(input.prompt)) {
    return undefined;
  }
  return 'Every helper brief needs a scope, so its context stays small: add a line "Edit only: <files or globs>" (or "Edit only: none" for research) and a line "Read first: <files, optionally file:lines>". Give only the files this job needs.';
}

/** The lines appended to a scoped brief: what the helper may touch and how to report. */
export function scopeFooter(scope: Scope): string {
  const edit = scope.edit.length ? `You may edit only: ${scope.edit.join(', ')}. Edits elsewhere are refused; if the job needs them, say so in your report.` : 'This job is read-only: make no edits.';
  const read = scope.read.length ? ` Read these first: ${scope.read.join(', ')}; open other files only when they are needed for this job.` : '';
  // Helpers read files through the shell more than anything else that gets refused (2026-10-19): say so up front.
  // "It builds" with no build run was the most common unverified claim (2026-10-21): say how to report not checking.
  return `\n\n[Scope] ${edit}${read} Read files with Read (offset/limit) or code_outline, never cat/head/tail/sed. Builds and tests may write their output folders (build/, .gradle/, target/...). If you could not build or test, write "not built" or "not tested"; never report a result you did not see. Report in under ~1,500 tokens: findings with file:line, what changed, how you verified it.`;
}


/** `file` relative to `base` (forward slashes), or undefined when it's outside `base`. */
function under(base: string, abs: string): string | undefined {
  const rel = path.relative(base, abs).split(path.sep).join('/');
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel;
}

const matches = (glob: string, rel: string) =>
  rel === glob || globRegex(glob).test(rel) || rel.startsWith(glob.replace(/\/?\*\*$/, '').replace(/\/$/, '') + '/');

/**
 * The git worktree of the workspace's repo that `abs` is in, if any: helpers
 * started with isolation edit a copy under .claude/worktrees/<id>, where
 * "App/**" means <worktree>/App/** (2026-10-19: every worktree edit was refused).
 */
function worktreeOf(cwd: string, abs: string): string | undefined {
  const m = /^(.*?\/\.claude\/worktrees\/[^/]+)(?:\/|$)/.exec(abs);
  if (m && (m[1] === path.join(cwd, '.claude', 'worktrees', path.basename(m[1])))) {
    return m[1];
  }
  const root = repoRootOf(path.dirname(abs));
  if (!root || root === cwd) {
    return undefined;
  }
  try {
    // A linked worktree's .git is a file: "gitdir: <main repo>/.git/worktrees/<name>".
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(root, '.git'), 'utf8'))?.[1].trim();
    return gitdir && gitdir.startsWith(path.join(cwd, '.git', 'worktrees') + path.sep) ? root : undefined;
  } catch {
    return undefined;
  }
}

/** The folders a scope's globs are relative to: the workspace, repos the brief named, and the file's worktree. */
const bases = (scope: Scope, cwd: string, abs?: string) => {
  const wt = abs ? worktreeOf(cwd, abs) : undefined;
  return [...(wt ? [wt] : []), cwd, ...(scope.roots ?? [])];
};

export function inScope(scope: Scope, cwd: string, file: string): boolean {
  const abs = path.resolve(cwd, expandHome(file));
  return scope.edit.some((glob) => {
    if (/^[~/]/.test(glob)) {
      return matches(path.resolve(expandHome(glob)), abs);
    }
    return bases(scope, cwd, abs).some((base) => {
      const rel = under(base, abs);
      return rel !== undefined && matches(glob, rel);
    });
  });
}

/**
 * A shell command split into simple commands (at ;, &&, ||, |, & and
 * newlines), each a list of words with quotes removed; an unquoted redirect
 * becomes the word "\0>" before its target. Heredoc bodies and comments are
 * skipped, so `echo "a > b"` or a heredoc's text never looks like a write.
 */
export function shellCommands(cmd: string): string[][] {
  const out: string[][] = [[]];
  let word = '';
  let started = false;
  const heredocs: string[] = [];
  const push = () => {
    if (started) {
      out[out.length - 1].push(word);
    }
    word = '';
    started = false;
  };
  const split = () => {
    push();
    if (out[out.length - 1].length) {
      out.push([]);
    }
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, end < 0 ? undefined : end);
      started = true;
      i = end < 0 ? cmd.length : end;
    } else if (c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') {
        j += cmd[j] === '\\' ? 2 : 1;
      }
      word += cmd.slice(i + 1, j).replace(/\\(.)/g, '$1');
      started = true;
      i = j;
    } else if (c === '\\') {
      word += cmd[i + 1] ?? '';
      started = true;
      i++;
    } else if (c === '#' && !started && (i === 0 || /\s/.test(cmd[i - 1]))) {
      const nl = cmd.indexOf('\n', i);
      i = (nl < 0 ? cmd.length : nl) - 1;
    } else if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      push();
      const m = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(cmd.slice(i));
      if (m) {
        heredocs.push(m[2]);
        i += m[0].length - 1;
      } else {
        i++;
      }
    } else if (c === '<' && cmd[i + 1] !== '(') {
      // "< in": reads a file; the target is marked so it isn't taken for an operand.
      push();
      out[out.length - 1].push('\0<');
    } else if (c === '\n') {
      split();
      // A heredoc's body starts on the next line and ends at its delimiter line.
      while (heredocs.length) {
        const delim = heredocs.shift()!;
        const end = new RegExp(`^\\s*${delim.replace(/[.-]/g, '\\$&')}\\s*$`, 'm').exec(cmd.slice(i + 1));
        i = end ? i + 1 + end.index + end[0].length : cmd.length;
      }
    } else if (c === '>' || (c === '&' && cmd[i + 1] === '>')) {
      // "2>file": the digits are the fd, not a word.
      if (/^\d+$/.test(word)) {
        word = '';
        started = false;
      } else {
        push();
      }
      let j = c === '&' ? i + 2 : i + 1;
      if (cmd[j] === '>' || cmd[j] === '|') {
        j++;
      }
      if (c === '>' && cmd[j] === '&') {
        // ">&2", "2>&1": a copy of another fd, not a file.
        j++;
        while (/[\d-]/.test(cmd[j] ?? '')) {
          j++;
        }
      } else {
        out[out.length - 1].push('\0>');
      }
      i = j - 1;
    } else if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || ((c === '{' || c === '}') && !started)) {
      split();
      if ((c === '|' || c === '&') && cmd[i + 1] === c) {
        i++;
      }
    } else if (/\s/.test(c)) {
      push();
    } else {
      word += c;
      started = true;
    }
  }
  push();
  return out.filter((s) => s.length);
}

/** Leading words that run the real command after them. */
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'env', 'time', 'nohup', 'exec']);

/** The files a shell command writes (redirects, tee, sed -i, rm, touch, mv, cp, ln), absolute; `cd` is followed. */
export function shellWrites(command: string, cwd: string): string[] {
  const writes: string[] = [];
  // Undefined after `cd $X`: relative paths are unknown from then on.
  let dir: string | undefined = cwd;
  const at = (p: string) => path.resolve(dir ?? '/', expandHome(p));
  // "$f", "$(…)", `…`: unknown until the shell runs it, so not judged; nor is a relative path after an unknown cd.
  const known = (p: string) => !/[$`]/.test(p) && (dir !== undefined || /^[~/]/.test(p));
  for (const seg of shellCommands(command)) {
    const words: string[] = [];
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === '\0>') {
        const target = seg[++i];
        if (target && !target.startsWith('\0') && known(target)) {
          writes.push(at(target));
        }
      } else if (seg[i] === '\0<') {
        i++;
      } else {
        words.push(seg[i]);
      }
    }
    let k = 0;
    while (k < words.length && (/^\w+=/.test(words[k]) || WRAPPERS.has(words[k]))) {
      k++;
    }
    const name = path.basename(words[k] ?? '');
    const args = words.slice(k + 1);
    // Operands: everything after "--", else words that aren't options.
    const dash = args.indexOf('--');
    const operands = (dash >= 0 ? [...args.slice(0, dash).filter((a) => !a.startsWith('-')), ...args.slice(dash + 1)] : args.filter((a) => !a.startsWith('-'))).filter(Boolean);
    if (name === 'cd' || name === 'pushd') {
      const to = operands[0];
      dir = to === undefined ? home : to === '-' ? dir : known(to) ? at(to) : undefined;
    } else if (name === 'tee' || name === 'rm' || name === 'unlink' || name === 'touch' || name === 'truncate') {
      writes.push(...operands.filter(known).map(at));
    } else if (name === 'ln' && args.some((a) => /^-\w*s/.test(a)) && operands.length >= 2 && !fs.existsSync(at(operands[operands.length - 1]))) {
      // A new symlink changes no file: helpers link untracked setup (credentials, .env) into a fresh worktree.
    } else if (name === 'mv' || name === 'cp' || name === 'ln' || name === 'install') {
      const t = args.findIndex((a) => a === '-t' || a.startsWith('--target-directory'));
      const target = t >= 0 ? (args[t].includes('=') ? args[t].split('=')[1] : args[t + 1]) : operands[operands.length - 1];
      // mv also removes its sources.
      const sources = name === 'mv' ? operands.filter((o) => o !== target) : [];
      if (target && (t >= 0 || operands.length >= 2)) {
        writes.push(...[target, ...sources].filter(known).map(at));
      }
    } else if ((name === 'sed' || name === 'gsed') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
      // Without -e/-f the first operand is the script; with them, every operand is a file.
      const files: string[] = [];
      let script = !args.some((a) => a === '-e' || a === '-f' || a.startsWith('--expression') || a.startsWith('--file'));
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-e' || a === '-f' || (a === '-i' && (args[i + 1] === '' || args[i + 1]?.startsWith('.')))) {
          // An option's value; BSD sed's "-i ''" / "-i .bak" take the backup suffix as the next word.
          i++;
        } else if (a && !a.startsWith('-')) {
          if (script) {
            script = false;
          } else {
            files.push(a);
          }
        }
      }
      writes.push(...files.filter(known).map(at));
    }
  }
  return writes;
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SCRATCH = /^(\/dev\/|\/tmp\/|\/private\/tmp\/|\/var\/folders\/)/;
/**
 * Build and tool output inside a repo: generated, not source, so any helper may write it. Refusing
 * `rm -rf build/...` or a Gradle cache write stopped helpers verifying their work (2026-10-21).
 * Only when git ignores the folder: a source folder that happens to be called build/ stays scoped.
 */
const GENERATED = /^(.*?(?:^|\/)(?:build|\.gradle|target|\.build|DerivedData|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|\.next|\.turbo|\.cache|coverage))(?:\/|$)/;
/** Whether git ignores each folder asked about: helpers write the same folders. */
const ignoredDirs = new Map<string, boolean>();

/**
 * `git check-ignore` for `abs`: relative, from a folder that exists (a symlinked temp path reads as outside
 * the repo), and ending in "/" so a "build/" pattern matches a folder the build hasn't made yet.
 */
function checkIgnore(abs: string): { args: string[]; cwd: string } {
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) {
    dir = path.dirname(dir);
  }
  return { args: ['check-ignore', '-q', `${path.relative(dir, abs) || '.'}/`], cwd: dir };
}

/** Whether git ignores `abs` (a folder); false outside git or when git can't say (exit 1: not ignored; 128: not a repo). Cached. */
export async function gitIgnores(abs: string): Promise<boolean> {
  if (!ignoredDirs.has(abs)) {
    const { args, cwd } = checkIgnore(abs);
    const ignored = await promisify(execFile)('git', args, { cwd, timeout: 3000 }).then(() => true, () => false);
    ignoredDirs.set(abs, ignored);
  }
  return ignoredDirs.get(abs)!;
}

/** scopeViolation without blocking the extension thread: git is asked about the output folders in parallel. */
export async function scopeViolationAsync(scope: Scope, cwd: string, tool: string, input: Record<string, unknown> | undefined, ignored: (abs: string) => Promise<boolean> = gitIgnores): Promise<string | undefined> {
  const known = new Map<string, boolean>();
  // Each pass may reach folders the last one didn't (a command writing several places), so ask until none is new.
  for (;;) {
    const ask = new Set<string>();
    const why = scopeViolation(scope, cwd, tool, input, (abs) => known.get(abs) ?? (ask.add(abs), false));
    if (!ask.size) {
      return why;
    }
    await Promise.all([...ask].map(async (abs) => known.set(abs, await ignored(abs))));
  }
}

/** Why a helper's tool call breaks its scope, or undefined. `ignored` says whether git ignores a folder; scopeViolationAsync asks git. */
export function scopeViolation(scope: Scope, cwd: string, tool: string, input: Record<string, unknown> | undefined, ignored: (abs: string) => boolean = () => false): string | undefined {
  // Inside the workspace or a named repo a file must be in scope; elsewhere only scratch locations are fine.
  const outside = (file: string) => {
    const abs = path.resolve(cwd, expandHome(file));
    if (inScope(scope, cwd, abs)) {
      return false;
    }
    const inRepo = bases(scope, cwd, abs).flatMap((base) => {
      const rel = under(base, abs);
      return rel === undefined ? [] : [{ base, rel }];
    });
    if (inRepo.some(({ base, rel }) => {
      const dir = GENERATED.exec(rel)?.[1];
      return dir !== undefined && ignored(path.join(base, dir));
    })) {
      return false;
    }
    return inRepo.length > 0 || !SCRATCH.test(abs);
  };
  const allowed = scope.edit.length ? `only ${scope.edit.join(', ')}` : 'nothing (read-only job)';
  const where = scope.roots?.length ? ` (relative to ${[cwd, ...scope.roots].map((r) => path.basename(r)).join(' or ')})` : '';
  if (FILE_TOOLS.has(tool)) {
    const file = input?.file_path ?? input?.notebook_path;
    if (typeof file === 'string' && outside(file)) {
      return `${file} is outside your scope: you may edit ${allowed}${where}. Don't edit it; say in your report what needs changing there.`;
    }
  }
  if (tool === 'Bash' && typeof input?.command === 'string') {
    const target = shellWrites(input.command, cwd).find(outside);
    if (target) {
      return `That command writes ${under(cwd, target) ?? target}, outside your scope: you may edit ${allowed}${where}. Report what needs changing instead.`;
    }
  }
  return undefined;
}

/** Commands that only read: they run without a permission card (dualAgent.autoApproveReadOnly). */
const READ_ONLY = new Set(['cd', 'pwd', 'ls', 'rg', 'grep', 'egrep', 'fgrep', 'wc', 'file', 'stat', 'du', 'df', 'which', 'whereis', 'type', 'tree', 'echo', 'printf', 'date', 'uname', 'whoami', 'basename', 'dirname', 'realpath', 'readlink', 'sort', 'uniq', 'cut', 'tr', 'column', 'jq', 'diff', 'cmp', 'head', 'tail', 'cat', 'true', 'test', 'find']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'describe', 'shortlog', 'grep', 'branch', 'tag', 'remote']);
/** Flags that make a reading command write or run something. */
const WRITING_FLAG = /^(-delete|-exec|-execdir|-ok|-okdir|-fprint\w*|-fls)$/;
/** -o writes a file for these (for grep it only means "only matching"). */
const OUTPUT_FLAG_WRITES = new Set(['sort', 'tree']);

/**
 * Whether a shell command only reads: every part is a reading command (or a
 * reading git subcommand), nothing is written outside /dev/null, and nothing
 * runs commands of its own ($(...), backticks, find -exec). Permission cards
 * for these were waits for nothing.
 */
export function isReadOnlyCommand(command: string, cwd = '/'): boolean {
  if (/\$\(|`|<\(|>\(/.test(command) || shellWrites(command, cwd).some((f) => !f.startsWith('/dev/'))) {
    return false;
  }
  return shellCommands(command).every((words) => {
    const [cmd, ...args] = words.filter((w) => w !== '\0>' && w !== '\0<');
    if (!cmd || /^\w+=/.test(cmd) || args.some((a) => WRITING_FLAG.test(a) || (OUTPUT_FLAG_WRITES.has(cmd) && /^(-o|--output)/.test(a)))) {
      return false;
    }
    if (cmd !== 'git') {
      return READ_ONLY.has(cmd);
    }
    const sub = args.find((a) => !a.startsWith('-'));
    if (!sub || !GIT_READ.has(sub)) {
      return false;
    }
    // branch, tag and remote only list: anything named after them creates, renames or deletes.
    const rest = args.slice(args.indexOf(sub) + 1);
    return !['branch', 'tag', 'remote'].includes(sub) || rest.every((a) => a.startsWith('-') && !/^-[dDmMcC]$|^--(delete|move|copy|set-upstream)/.test(a));
  });
}

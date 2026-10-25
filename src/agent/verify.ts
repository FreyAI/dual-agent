/**
 * Checks what an agent says it did against what it did. Agents report
 * "tests pass", "added X to file.ts" or "done" without having run the tests,
 * made the edit or finished the to-dos; the Stop and SubagentStop hooks use
 * these checks to send the agent back once, and the chat shows anything still
 * unverified. Evidence is collected per agent from the tool hooks; pure apart
 * from the optional git lookup the caller passes in.
 */
import * as path from 'path';
import { execFile } from 'child_process';

export interface Command {
  command: string;
  ok: boolean;
}

export interface Todo {
  content: string;
  status: string;
}

/** What one agent did since its last check. */
export interface Evidence {
  edited: Set<string>;
  commands: Command[];
  todos: Todo[];
  /**
   * Test and build runs since the last edit, kept across checks: "tests pass"
   * in a status reply still holds when nothing changed since the run
   * (2026-10-19: six status replies were sent back for quoting an earlier run).
   */
  sinceEdit: Command[];
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const TEST_COMMAND = /\b(npm (run )?test|npx (jest|vitest|mocha)|yarn test|pnpm test|jest|vitest|mocha|pytest|python3? -m (pytest|unittest)|go test|cargo test|swift test|xcodebuild\b.*\btest|node --test|make (test|check)|gradle\w* (\S*:)?test\w*|mvn test|rspec|phpunit|dotnet test|ctest|bun test|deno test)\b/i;
export const BUILD_COMMAND = /\b(npm run (build|compile)|tsc\b|make\b|xcodebuild|cargo (build|check)|go (build|vet)|swift build|gradle\w* (\S*:)?(build|assemble\w*|compile\w*|check)|mvn (package|compile)|dotnet build|webpack|vite build|esbuild)\b/i;

/** "tests pass", "all 42 tests passed", "the suite is green", "619/620 pass". */
const TESTS_CLAIM = /\b(tests?|suites?|specs?)\b[^.\n]{0,40}\b(pass(es|ed|ing)?|green|succeed(s|ed)?)\b|\b\d+\s*\/\s*\d+\s+(tests? )?pass/i;
/** "builds cleanly", "compiles", "the build succeeded". */
const BUILD_CLAIM = /\b(it |now |still )?(builds|compiles)\b(?! (the|a|an) )|\bbuild (passes|succeeded|is green|is clean)\b|\bcompiles? (cleanly|fine|without)/i;
/**
 * A sentence saying a file was changed, with the file in backticks or as a path.
 * The name runs to its end: a 6-letter cap once read ".gitignore" as ".gitign" (2026-10-19).
 */
const FILE_CLAIM = /\b(created|added|wrote|updated|edited|changed|modified|fixed|moved|implemented)\b[^.\n]{0,80}?`?([\w./-]+\.[a-z0-9]{1,12})(?![\w-])`?/gi;
/** The reply says the work is finished. */
const DONE_CLAIM = /\b(all )?(done|finished|completed?|all set|implemented|ready to (use|ship|install))\b/i;
/** Admissions that make a claim honest: "not run", "didn't test", "untested". */
const HEDGE = /\b(not (yet )?(run|tested|built|verified)|didn'?t (run|test|build)|untested|couldn'?t (run|test)|haven'?t (run|tested))\b/i;

/**
 * Failure signs in output whose exit code said success: `cmd | tail` reports
 * tail's exit code, so a failing test run piped through it looks fine.
 */
const FAILURE_SIGNS = /(\b[1-9]\d* (failed|failing|errors?)\b|^\s*FAIL\b|^not ok \d+|\berror TS\d+|Traceback \(most recent call last\)|\bAssertionError\b|^panic:|npm ERR!|\*\* BUILD FAILED \*\*|BUILD FAILED|^error(\[E\d+\])?:|:\d+:\d+: error:|Segmentation fault|command not found)/m;

/** The first line that shows a failure, or undefined. */
export function failureIn(output: string): string | undefined {
  const m = FAILURE_SIGNS.exec(output);
  if (!m) {
    return undefined;
  }
  const start = output.lastIndexOf('\n', m.index) + 1;
  const end = output.indexOf('\n', m.index);
  return output.slice(start, end < 0 ? undefined : end).trim().slice(0, 160);
}

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|java|kt|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte|m|mm|scala|dart)$/i;
const TEST_FILE = /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)|Tests?\.(swift|kt|java|cs)$/i;
/** A test run limited to some tests: a test file path or a filter flag. */
export const NARROWED = /(\s-k\s|\s-t\s|--grep\b|--test-name-pattern|--filter\b|-only-testing|::|\S+\.(test|spec)\.\w+|\S*[Tt]ests?\/\S+|\bTests?\.\w+)/;
const stem = (file: string) => path.basename(file).replace(/\.(test|spec)(?=\.)/, '').replace(/\.\w+$/, '').toLowerCase();

/** Commands that change the machine or the repo rather than check it: never kept as "a command that worked". */
const NOT_A_CHECK = /\b(install|uninstall|clean|clobber|deploy|publish|release|push|reset|rm|upgrade)\b/i;

/**
 * Whether a command (without its output plumbing, memory/commandCore) is a
 * build or test run worth remembering: the build or test tool is the command
 * itself (not `cat log` or `echo && make`), it runs everything (not one
 * filtered test), and it changes nothing (`make install` matched "make").
 */
export function isCheckCommand(run: string): boolean {
  const cmd = run.replace(/^(\w+=\S*\s+)+/, '');
  const m = TEST_COMMAND.exec(cmd) ?? BUILD_COMMAND.exec(cmd);
  const firstWord = cmd.search(/\s|$/);
  return !!m && m.index < firstWord && !NOT_A_CHECK.test(cmd) && !NARROWED.test(` ${cmd} `);
}

export const newEvidence = (): Evidence => ({ edited: new Set(), commands: [], todos: [], sinceEdit: [] });

/** After a check: the next one looks at new work only, but the to-do list carries over. */
export function resetEvidence(ev: Evidence) {
  ev.edited.clear();
  ev.commands = [];
}

/** Adds one finished tool call to the evidence. */
export function recordTool(ev: Evidence, tool: string, input: Record<string, unknown> | undefined, ok: boolean) {
  const filePath = input?.file_path ?? input?.notebook_path;
  if (FILE_TOOLS.has(tool) && typeof filePath === 'string' && ok) {
    ev.edited.add(filePath);
    ev.sinceEdit = [];
  } else if (tool === 'Bash' && typeof input?.command === 'string') {
    ev.commands.push({ command: input.command, ok });
    if (TEST_COMMAND.test(input.command) || BUILD_COMMAND.test(input.command)) {
      ev.sinceEdit = [...ev.sinceEdit, { command: input.command, ok }].slice(-5);
    }
  } else if (tool === 'TodoWrite' && Array.isArray(input?.todos)) {
    ev.todos = (input.todos as Todo[]).filter((t) => t && typeof t.content === 'string');
  }
}

/** The last run of commands matching `kind`, or undefined if none ran. */
const lastRun = (ev: Evidence, kind: RegExp) =>
  [...ev.commands].reverse().find((c) => kind.test(c.command)) ?? [...ev.sinceEdit].reverse().find((c) => kind.test(c.command));

/** A claimed file counts if the agent edited it or git shows it changed (scripts and moves included). */
function fileChanged(file: string, ev: Evidence, changedFiles: string[]): boolean {
  const base = path.basename(file);
  const matches = (p: string) => p === file || p.endsWith(`/${file}`) || path.basename(p) === base;
  return [...ev.edited].some(matches) || changedFiles.some(matches);
}

/** Files git reports as changed or new, relative to the repo; undefined outside git or on error. */
export function gitChangedFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    // No index lock (a helper's own git commit mustn't fail meanwhile); -z keeps non-ASCII paths unquoted.
    execFile('git', ['--no-optional-locks', 'status', '--porcelain', '-z', '-uall'], { cwd, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const entries = stdout.split('\0');
      const files: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.length > 3) {
          files.push(e.slice(3));
          // A rename lists the old path next; skip it.
          if (e[0] === 'R' || e[0] === 'C') {
            i++;
          }
        }
      }
      resolve(files);
    });
  });
}

/**
 * Changed files across several repos, as absolute paths: a helper sent into
 * another repo changes files the workspace's git status can't see. Undefined
 * when no repo could be read.
 */
export async function gitChangedAcross(roots: Iterable<string>): Promise<string[] | undefined> {
  const lists = await Promise.all([...new Set(roots)].map(async (root) => (await gitChangedFiles(root))?.map((f) => path.join(root, f))));
  const read = lists.filter((l): l is string[] => !!l);
  return read.length ? read.flat() : undefined;
}

/** Adds a helper's work to its parent's, so the parent's report can rely on it. */
export function mergeEvidence(into: Evidence, from: Evidence) {
  from.edited.forEach((f) => into.edited.add(f));
  into.commands.push(...from.commands);
  // The helper's edits make the parent's earlier runs stale; its own runs after them stand.
  into.sinceEdit = from.edited.size ? [...from.sinceEdit] : [...into.sinceEdit, ...from.sinceEdit].slice(-5);
}

/**
 * What the reply claims that the evidence doesn't support. Contradictions
 * (the last run failed, a named file is unchanged) send the agent back;
 * the rest is only unverified (no run since the last edit, open to-dos):
 * sending those back made correction turns, 42 notices on 2026-10-19.
 * `changedFiles` is what git reports as changed (absolute or relative
 * paths); pass undefined when unknown, and file claims aren't checked.
 */
export interface ReportCheck {
  contradictions: string[];
  unverified: string[];
}

export function checkReport(reply: string, ev: Evidence, changedFiles?: string[]): ReportCheck {
  const contradictions: string[] = [];
  const unverified: string[] = [];
  const sentences = reply.split(/(?<=[.!?\n])\s+/);
  // A fresh non-global copy: a /g regex's test() keeps state between calls.
  const claims = (re: RegExp) => {
    const once = new RegExp(re.source, re.flags.replace('g', ''));
    return sentences.filter((s) => once.test(s) && !HEDGE.test(s));
  };
  if (claims(TESTS_CLAIM).length) {
    const run = lastRun(ev, TEST_COMMAND);
    if (!run) {
      unverified.push('it says tests pass, but no test command ran since the last edit');
    } else if (!run.ok) {
      contradictions.push(`it says tests pass, but the last test run failed (${run.command.slice(0, 80)})`);
    }
  }
  if (claims(BUILD_CLAIM).length) {
    const run = lastRun(ev, BUILD_COMMAND) ?? lastRun(ev, TEST_COMMAND);
    if (!run) {
      unverified.push('it says the code builds, but no build or test command ran since the last edit');
    } else if (!run.ok) {
      contradictions.push(`it says the code builds, but the last build failed (${run.command.slice(0, 80)})`);
    }
  }
  const code = [...ev.edited].filter((f) => CODE_FILE.test(f) && !TEST_FILE.test(f));
  const tested = lastRun(ev, TEST_COMMAND);
  const saysFinished = claims(DONE_CLAIM).length > 0 || claims(TESTS_CLAIM).length > 0;
  if (code.length && !tested && !lastRun(ev, BUILD_COMMAND) && saysFinished && !HEDGE.test(reply)) {
    unverified.push(`it changed code (${code.slice(0, 3).map((f) => path.basename(f)).join(', ')}) but ran no tests or build`);
  } else if (tested && NARROWED.test(tested.command)) {
    const untested = [...new Set(code.map(stem))].filter((st) => !tested.command.toLowerCase().includes(st));
    if (untested.length >= 2 || (untested.length && code.length > 1)) {
      unverified.push(`it changed ${code.length} code files but only ran some tests (${tested.command.slice(0, 80)}); ${untested.slice(0, 3).join(', ')} weren't covered. Run the full suite or tests for each change`);
    }
  }
  if (changedFiles) {
    const missing = new Set<string>();
    for (const s of claims(FILE_CLAIM)) {
      for (const m of s.matchAll(FILE_CLAIM)) {
        const file = m[2].replace(/[`'"),:;]+$/, '');
        if (/\//.test(file) || /\.(ts|tsx|js|jsx|py|go|rs|swift|java|kt|rb|php|cs|c|cc|cpp|h|hpp|css|scss|html|md|json|ya?ml|toml|sh|sql|vue|svelte)$/i.test(file)) {
          if (!fileChanged(file, ev, changedFiles)) {
            missing.add(file);
          }
        }
      }
    }
    if (missing.size) {
      contradictions.push(`it says it changed ${[...missing].slice(0, 4).join(', ')}, but ${missing.size === 1 ? 'that file has' : 'those files have'} no changes`);
    }
  }
  const open = ev.todos.filter((t) => t.status === 'in_progress' || t.status === 'pending');
  if (open.length && claims(DONE_CLAIM).length) {
    unverified.push(`${open.length} to-do item${open.length === 1 ? ' is' : 's are'} still open: ${open.slice(0, 3).map((t) => t.content).join('; ')}`);
  }
  return { contradictions, unverified };
}

/** Every problem, contradictions first. */
export function unsupportedClaims(reply: string, ev: Evidence, changedFiles?: string[]): string[] {
  const r = checkReport(reply, ev, changedFiles);
  return [...r.contradictions, ...r.unverified];
}

/** What the agent is told when it's sent back; `checks` is the auto-check failure text, joined into the same message. */
export function sendBackReason(problems: string[], checks?: string): string {
  const claims = problems.length
    ? `Before finishing, check your report against what you did: ${problems.join('; ')}. ` +
      'Do the missing work (run the tests or build, make the edit, finish the to-dos), or correct the report to say plainly what was not done or not verified.'
    : '';
  return [checks, claims].filter(Boolean).join('\n\n');
}

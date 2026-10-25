/**
 * The project's own check commands (test, lint, typecheck, build), found from
 * its manifests and kept in `.dual-agent/memory/conventions.md`, so agents stop
 * working them out again on every task. The file is plain Markdown a person
 * can edit: a line they changed always wins, and detection only fills or
 * refreshes the lines they didn't touch. Detection reruns only when a manifest's
 * modification time changed. Commands an agent ran successfully (memory.ts
 * recordCommand) fill what no manifest gives. Every read is fail-safe: a
 * missing or broken manifest means no entry, never an error.
 */
import * as fs from 'fs';
import * as path from 'path';
import { short } from '../text';
import { BUILD_COMMAND, TEST_COMMAND } from '../agent/verify';
import { readTextOrUndefined, stripControl, workFolder, workPath, writeAtomic } from './files';

export const CONVENTION_KINDS = ['typecheck', 'lint', 'test', 'build'] as const;
export type ConventionKind = (typeof CONVENTION_KINDS)[number];

/** A shell command to run in the workspace root, and where it came from. */
export interface ConventionEntry {
  command: string;
  source: string;
}
export type Conventions = Partial<Record<ConventionKind, ConventionEntry>>;

const FILE = 'conventions.md';
const MAX_READ_BYTES = 256 * 1024;
const MAX_COMMAND_CHARS = 300;
/** Written in a hand-edited line to switch a kind off. */
const OFF = 'none';
const HEAD =
  '# Project commands\n<!-- Dual Agent: how to check this project. Edit a line to change it ("none" turns one off); detection only fills lines that are missing or that you did not edit. -->\n';

/** Files whose modification times decide whether detection reruns. */
const WATCHED = ['package.json', 'tsconfig.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Makefile', 'Cargo.toml', 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'ruff.toml', '.ruff.toml', 'mypy.ini', 'go.mod', 'node_modules/.bin/tsc'];

const at = (root: string, name: string) => path.join(root, name);
const has = (root: string, name: string) => fs.existsSync(at(root, name));
const text = (root: string, name: string) => readTextOrUndefined(at(root, name), MAX_READ_BYTES) ?? '';

function packageJson(root: string): Conventions {
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(text(root, 'package.json') || '{}');
    if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) {
      scripts = pkg.scripts;
    }
  } catch {
    return {};
  }
  const pm = has(root, 'yarn.lock') ? 'yarn' : has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'bun.lockb') || has(root, 'bun.lock') ? 'bun' : 'npm';
  const script = (...names: string[]) => names.find((n) => typeof scripts[n] === 'string' && (scripts[n] as string).trim() && !/no test specified/i.test(scripts[n] as string));
  const out: Conventions = {};
  const add = (kind: ConventionKind, name: string | undefined, note = '') => {
    if (name) {
      out[kind] = { command: name === 'test' ? `${pm} test` : `${pm} run ${name}`, source: `package.json${note}` };
    }
  };
  // `npm test` runs `pretest` first (this repo's compiles), so a typecheck before it would repeat that work.
  add('test', script('test', 'test:unit'), typeof scripts.pretest === 'string' ? ', runs pretest' : '');
  add('lint', script('lint'));
  add('typecheck', script('typecheck', 'type-check', 'check-types', 'tsc'));
  add('build', script('build', 'compile'));
  if (!out.typecheck && has(root, 'tsconfig.json') && has(root, 'node_modules/.bin/tsc')) {
    out.typecheck = { command: 'npx --no-install tsc --noEmit', source: 'tsconfig.json' };
  }
  return out;
}

function cargo(root: string): Conventions {
  const source = 'Cargo.toml';
  return has(root, source)
    ? { test: { command: 'cargo test', source }, lint: { command: 'cargo clippy', source }, typecheck: { command: 'cargo check', source } }
    : {};
}

function python(root: string): Conventions {
  const out: Conventions = {};
  for (const file of ['pyproject.toml', 'setup.cfg']) {
    const t = text(root, file);
    const entry = (command: string) => ({ command, source: file });
    if (/\[tool\.pytest|\[tool:pytest\]/.test(t)) {
      out.test ??= entry('pytest');
    }
    if (/\[tool\.ruff/.test(t)) {
      out.lint ??= entry('ruff check .');
    }
    if (/\[tool\.mypy|^\[mypy\]/m.test(t)) {
      out.typecheck ??= entry('mypy .');
    }
  }
  if (has(root, 'pytest.ini')) {
    out.test ??= { command: 'pytest', source: 'pytest.ini' };
  }
  if (has(root, 'ruff.toml') || has(root, '.ruff.toml')) {
    out.lint ??= { command: 'ruff check .', source: 'ruff.toml' };
  }
  if (has(root, 'mypy.ini')) {
    out.typecheck ??= { command: 'mypy .', source: 'mypy.ini' };
  }
  return out;
}

/** `go vet` compiles and type-checks, so it is the Go project's typecheck. */
function golang(root: string): Conventions {
  const source = 'go.mod';
  return has(root, source) ? { test: { command: 'go test ./...', source }, typecheck: { command: 'go vet ./...', source } } : {};
}

function makefile(root: string): Conventions {
  const t = text(root, 'Makefile');
  const target = (name: string) => new RegExp(`^${name}\\s*:(?!=)`, 'm').test(t);
  const entry = (name: string) => ({ command: `make ${name}`, source: 'Makefile' });
  const out: Conventions = {};
  // `make check` conventionally runs the tests.
  const test = target('test') ? 'test' : target('check') ? 'check' : undefined;
  if (test) {
    out.test = entry(test);
  }
  if (target('lint')) {
    out.lint = entry('lint');
  }
  if (target('build')) {
    out.build = entry('build');
  }
  return out;
}

/** Manifest order is priority: the first to name a kind keeps it. */
function detect(root: string): Conventions {
  const out: Conventions = {};
  for (const find of [packageJson, cargo, python, golang, makefile]) {
    try {
      for (const kind of CONVENTION_KINDS) {
        out[kind] ??= find(root)[kind];
      }
    } catch {
      // An unreadable manifest gives no entry.
    }
  }
  return out;
}

/** Which kind a command an agent ran belongs to, if any. */
export function kindOf(command: string): ConventionKind | undefined {
  if (/\b(eslint|ruff|clippy|flake8|golangci-lint|biome (check|lint))\b|\bnpm run lint\b/.test(command)) {
    return 'lint';
  }
  if (/\btsc\b.*--noEmit|\bcargo check\b|\bgo vet\b|\bmypy\b|\bpyright\b|\bnpm run (typecheck|type-check)\b/.test(command)) {
    return 'typecheck';
  }
  return TEST_COMMAND.test(command) ? 'test' : BUILD_COMMAND.test(command) ? 'build' : undefined;
}

interface Stored {
  entries: Conventions;
  /** The modification-time key and the commands detection (not a person) wrote, from the trailing comment. */
  key?: string;
  detected: Partial<Record<ConventionKind, string>>;
}

const LINE = /^[-*]\s+(typecheck|lint|test|build):\s*(?:`([^`]+)`|(\S.*?))(?:\s+\(([^)]*)\))?\s*$/;
const META = /^<!-- detected: (\{.*\}) -->$/;

function parse(file: string | undefined): Stored | undefined {
  if (file === undefined) {
    return undefined;
  }
  const stored: Stored = { entries: {}, detected: {} };
  for (const raw of stripControl(file).split('\n')) {
    const line = raw.trim();
    const m = LINE.exec(line);
    const command = (m?.[2] ?? m?.[3] ?? '').trim().slice(0, MAX_COMMAND_CHARS);
    if (m && command) {
      stored.entries[m[1] as ConventionKind] = { command, source: m[4] ?? 'conventions.md' };
      continue;
    }
    const meta = META.exec(line);
    if (meta) {
      try {
        const j = JSON.parse(meta[1]);
        stored.key = typeof j.key === 'string' ? j.key : undefined;
        stored.detected = j.commands && typeof j.commands === 'object' ? j.commands : {};
      } catch {
        // A damaged comment only means the next read detects again.
      }
    }
  }
  return stored;
}

function render(entries: Conventions, key: string, detected: Stored['detected']): string {
  const lines = CONVENTION_KINDS.filter((k) => entries[k]).map((k) => `- ${k}: \`${entries[k]!.command}\` (${entries[k]!.source})`);
  const meta = JSON.stringify({ key, commands: detected }).replace(/>/g, '\\u003e');
  return `${HEAD}${lines.join('\n')}\n<!-- detected: ${meta} -->\n`;
}

/** Changes when a watched manifest or the recorded commands do. */
function cacheKey(root: string, recorded: string[]): string {
  const stamps = WATCHED.map((name) => {
    try {
      return `${name}:${fs.statSync(at(root, name)).mtimeMs}`;
    } catch {
      return '';
    }
  }).filter(Boolean);
  return [...stamps, ...recorded].join('|');
}

const visible = (entries: Conventions): Conventions =>
  Object.fromEntries(Object.entries(entries).filter(([, e]) => e && e.command !== OFF)) as Conventions;

/**
 * The project's commands: from conventions.md while its key still matches the
 * manifests, else detected again and merged under the hand edits. `recorded`
 * (newest first) fills kinds no manifest names. `persist` false reads the
 * file but never writes it (project memory off).
 */
export function loadConventions(root: string, recorded: string[] = [], persist = true): Conventions {
  const file = path.join(workPath(root, 'memory'), FILE);
  const current = readTextOrUndefined(file, MAX_READ_BYTES);
  const stored = parse(current);
  const key = cacheKey(root, recorded);
  if (stored && stored.key === key) {
    return visible(stored.entries);
  }
  const found = detect(root);
  for (const command of recorded) {
    const kind = kindOf(command);
    if (kind && !found[kind]) {
      found[kind] = { command: short(command, MAX_COMMAND_CHARS), source: 'recorded' };
    }
  }
  const merged: Conventions = {};
  const detected: Stored['detected'] = {};
  for (const kind of CONVENTION_KINDS) {
    const old = stored?.entries[kind];
    // A line that no longer matches what detection wrote was edited by a person.
    if (old && stored!.detected[kind] !== old.command) {
      merged[kind] = old;
    } else if (found[kind]) {
      merged[kind] = found[kind];
      detected[kind] = found[kind]!.command;
    }
  }
  if (persist && (Object.keys(merged).length || stored)) {
    const next = render(merged, key, detected);
    if (next !== current) {
      try {
        workFolder(root, 'memory');
        writeAtomic(file, next);
      } catch {
        // A read-only workspace still gets its commands, just not the file.
      }
    }
  }
  return visible(merged);
}

/** One short line for the agents' primer and brief; undefined when there is nothing to say. */
export function commandsLine(c: Conventions, maxChars = 280): string | undefined {
  const parts = (['test', 'typecheck', 'lint', 'build'] as const).filter((k) => c[k]).map((k) => `${k} \`${short(c[k]!.command, 60)}\``);
  return parts.length ? short(`Project commands: ${parts.join('; ')}.`, maxChars) : undefined;
}

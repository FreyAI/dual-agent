/** What every eval task is made of, shared by tasks.ts and the hard tasks in hard/. */
export interface EvalTask {
  id: string;
  kind: 'bugfix' | 'feature' | 'refactor' | 'fix-tests' | 'write-tests' | 'lint';
  /** Tasks agents are known to get wrong; the easy set alone can't tell arms apart. */
  difficulty?: 'hard';
  /** What the user asks; never mentions the hidden tests. */
  prompt: string;
  /** The starting project, by relative path. */
  files: Record<string, string>;
  /** Files (new or whole replacements) that make the task right. */
  solution: Record<string, string>;
  /** Written after the agent finishes; they also restore any test the agent might have edited. */
  hidden: Record<string, string>;
  /** The grading command (argv), run in the project folder. */
  check: string[];
}

/** A plausible wrong fix: one replacement in a starting file, instead of the solution; the hidden tests must still fail it. */
export interface NaiveFix {
  file: string;
  replace: [string, string];
}

/** One hard task module in hard/: the task plus the wrong fixes that prove it is hard. */
export interface HardTask {
  task: EvalTask;
  naive: NaiveFix[];
}

const PKG = JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test', lint: 'node scripts/lint.js' } }, null, 2) + '\n';
export const T = "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n";
export const TEST = ['node', '--test'];

/** Visible tests every fixture starts with, so "the existing tests still pass" is checked too. */
export const project = (files: Record<string, string>) => ({ 'package.json': PKG, ...files });

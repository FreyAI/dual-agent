/**
 * Grading for the eval: write the hidden files into the agent's finished folder,
 * run the task's check command with a timeout, and report pass/fail with the
 * (trimmed) output. The child env drops NODE_TEST_CONTEXT, or a nested
 * `node --test` would act as a test file of the outer runner instead of a runner.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvalTask, writeFiles } from './tasks';

export interface Grade {
  pass: boolean;
  output: string;
}

const MAX_OUTPUT = 3000;

/** Keeps the end of long output, where test failures are summarised. */
export const trimOutput = (text: string, max = MAX_OUTPUT) => {
  const t = text.trim();
  return t.length > max ? '...' + t.slice(-max) : t;
};

/** The parent env without test-runner and Claude variables that change a child's behaviour. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'NODE_TEST_CONTEXT' || key.startsWith('CLAUDE')) {
      delete env[key];
    }
  }
  return env;
}

/** A new temp folder holding the task's starting files, plus the solution when asked. */
export function setUp(task: EvalTask, withSolution = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-' + task.id + '-'));
  writeFiles(root, task.files);
  if (withSolution) {
    writeFiles(root, task.solution);
  }
  return root;
}

/** Writes the hidden files into root and runs the task's check there. Never throws. */
export function gradeFolder(root: string, task: EvalTask, timeoutMs = 60_000): Promise<Grade> {
  writeFiles(root, task.hidden);
  return new Promise((resolve) => {
    const [cmd, ...args] = task.check;
    let output = '';
    let settled = false;
    const done = (pass: boolean, extra = '') => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ pass, output: trimOutput(output + extra) });
      }
    };
    const child = spawn(cmd, args, { cwd: root, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(false, '\n[grading timed out after ' + Math.round(timeoutMs / 1000) + 's and was killed]');
    }, timeoutMs);
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (err) => done(false, '[could not start "' + task.check.join(' ') + '": ' + err.message + ']'));
    child.on('close', (code) => done(code === 0, code === 0 ? '' : '\n[check exited with code ' + code + ']'));
  });
}

/** Grades a fresh copy of the task, optionally with the solution applied; removes the folder after. */
export async function gradeFresh(task: EvalTask, withSolution: boolean, timeoutMs?: number): Promise<Grade> {
  const root = setUp(task, withSolution);
  try {
    return await gradeFolder(root, task, timeoutMs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

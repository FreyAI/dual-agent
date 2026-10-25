/**
 * Runs the project's typecheck, lint and test commands when the main agent
 * stops after editing files, so a break is found while the agent can still fix
 * it. A real failure (non-zero exit) is sent back; a check that could not run
 * (timeout, spawn error, command not found) is reported as unverified, never
 * as a pass and never as a block. Output is trimmed before the agent sees it.
 */
import { spawn } from 'child_process';
import { condenseTestOutput, headTail } from './trim';
import { Conventions } from '../memory/conventions';
import { Evidence, NARROWED, TEST_COMMAND } from './verify';

export type AutoCheckMode = 'off' | 'typecheck' | 'all';
export const MAX_CHECK_SENDS = 2;
const MAX_CAPTURE = 400_000;
const OUTPUT_CHARS = 3000;
const NOT_FOUND = 127;

export interface CheckResult {
  command: string;
  /** failed: ran and exited non-zero. unverified: could not give an answer. */
  status: 'passed' | 'failed' | 'unverified';
  exit?: number;
  /** Trimmed output for a failure, or why it could not run. */
  detail: string;
}

export interface AutoCheckConfig {
  mode: AutoCheckMode;
  /** Typecheck and lint. */
  timeoutMs: number;
  testTimeoutMs: number;
}

export interface Ran {
  exit?: number;
  output: string;
  timedOut?: boolean;
  error?: string;
}

export type Runner = (command: string, cwd: string, timeoutMs: number) => Promise<Ran>;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Runs one shell command in `cwd`; kills its whole process group on timeout. */
export const runCommand: Runner = (command, cwd, timeoutMs) =>
  new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (r: Omit<Ran, 'output'>) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ...r, output });
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (err) {
      resolve({ output: '', error: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Already gone.
      }
      finish({ timedOut: true });
    }, timeoutMs);
    const take = (d: Buffer) => {
      if (output.length < MAX_CAPTURE) {
        output += d.toString();
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (err) => finish({ error: err.message }));
    child.on('close', (code) => finish({ exit: code ?? 1 }));
  });

const seconds = (ms: number) => Math.round(ms / 100) / 10;

/** Which checks to run, in order: typecheck, lint, test. A test already passed since the last edit is skipped. */
export function plannedChecks(c: Conventions, ev: Evidence, mode: AutoCheckMode): { kind: 'typecheck' | 'lint' | 'test'; command: string }[] {
  if (mode === 'off' || ev.edited.size === 0) {
    return [];
  }
  const plan: { kind: 'typecheck' | 'lint' | 'test'; command: string }[] = [];
  if (c.typecheck) {
    plan.push({ kind: 'typecheck', command: c.typecheck.command });
  }
  if (mode === 'all') {
    if (c.lint) {
      plan.push({ kind: 'lint', command: c.lint.command });
    }
    const passed = ev.sinceEdit.some((x) => x.ok && TEST_COMMAND.test(x.command) && !NARROWED.test(x.command));
    if (c.test && !passed) {
      plan.push({ kind: 'test', command: c.test.command });
    }
  }
  return plan;
}

/**
 * Runs the planned checks in order and stops at the first failure (later
 * checks would mostly repeat it). Anything that could not give an answer is
 * returned as unverified and the run goes on.
 */
export async function runAutoChecks(cwd: string, c: Conventions, ev: Evidence, cfg: AutoCheckConfig, run: Runner = runCommand): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { kind, command } of plannedChecks(c, ev, cfg.mode)) {
    const ms = kind === 'test' ? cfg.testTimeoutMs : cfg.timeoutMs;
    const r = await run(command, cwd, ms);
    if (r.timedOut) {
      results.push({ command, status: 'unverified', detail: `timed out after ${seconds(ms)}s (killed)` });
    } else if (r.error) {
      results.push({ command, status: 'unverified', detail: `could not start: ${r.error}` });
    } else if (r.exit === NOT_FOUND) {
      results.push({ command, status: 'unverified', exit: r.exit, detail: 'command not found' });
    } else if (r.exit === 0) {
      results.push({ command, status: 'passed', exit: 0, detail: '' });
    } else {
      const clean = r.output.replace(ANSI, '').trim();
      results.push({ command, status: 'failed', exit: r.exit, detail: condenseTestOutput(command, clean) ?? headTail(clean, OUTPUT_CHARS) });
      break;
    }
  }
  return results;
}

/** The text that sends the agent back to fix a failure. */
export function checksReason(failed: CheckResult[]): string {
  const body = failed.map((f) => `${f.command} exit ${f.exit}\n${f.detail}`).join('\n\n');
  return `Checks failed after your edits: ${body}\nFix these, or say why they're unrelated.`;
}

/**
 * Decides whether this failure set goes back to the agent. The same failing
 * commands are sent once, and at most MAX_CHECK_SENDS times a turn; past that
 * the result is shown as unverified instead. `sent` holds the signatures
 * already sent this turn and is updated here.
 */
export function sendBackText(results: CheckResult[], sent: string[]): string | undefined {
  const failed = results.filter((r) => r.status === 'failed');
  if (!failed.length) {
    return undefined;
  }
  const signature = failed.map((f) => f.command).sort().join('\n');
  if (sent.length >= MAX_CHECK_SENDS || sent.includes(signature)) {
    return undefined;
  }
  sent.push(signature);
  return checksReason(failed);
}

/** One line per check that did not pass and was not sent back, for the chat. */
export function unverifiedNotice(results: CheckResult[], sentBack: boolean): string | undefined {
  const lines = results
    .filter((r) => r.status === 'unverified' || (r.status === 'failed' && !sentBack))
    .map((r) => (r.status === 'failed' ? `${r.command} still fails (exit ${r.exit})` : `${r.command}: ${r.detail}`));
  return lines.length ? `Not verified: ${lines.join('; ')}.` : undefined;
}

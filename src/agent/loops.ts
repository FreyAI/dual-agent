/**
 * Stops agents from burning tokens in loops, after OpenHands' stuck detector:
 * the same call returning the same result again and again, a command retried
 * after it already failed twice, or alternating between two calls. A nudge
 * comes first, then a refusal. Checked in the PreToolUse hook per agent (main
 * or a helper's id), so a refused call costs one short message instead of
 * another round of tool output.
 */
import { BUILD_COMMAND, TEST_COMMAND } from './verify';

/** Calls whose inputs legitimately repeat (plans, questions). */
const EXEMPT = new Set(['TodoWrite', 'AskUserQuestion', 'ExitPlanMode']);
/** A successful edit changes the state, so repeating a check after it is progress, not a loop. */
const STATE_CHANGING = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** How many of an agent's recent calls are kept for spotting back-and-forth. */
const WINDOW = 12;
/** The same call returning the same result this many times: the next one is refused (OpenHands: 4 identical action+observation pairs). */
const MAX_SAME_RESULTS = 3;
/** A call that failed this many times: the next identical one is refused. */
const MAX_FAILURES = 2;
/** Alternating between two calls this long (A B A B A B): the next one is refused; shorter gets a nudge. */
const PING_PONG_DENY = 6;
const PING_PONG_NUDGE = 4;

/** One call's identity: tool plus its input, key order ignored. */
export function signature(tool: string, input: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v;
  try {
    return `${tool} ${JSON.stringify(sorted(input ?? {}))}`;
  } catch {
    return tool;
  }
}

export interface LoopVerdict {
  /** Refuse the call with this reason. */
  deny?: string;
  /** Let it run, but tell the agent this (a one-time warning before refusing). */
  nudge?: string;
}

/** The last `n` calls alternate between two different calls. */
function alternates(seq: string[], n: number): boolean {
  if (seq.length < n) {
    return false;
  }
  const tail = seq.slice(-n);
  return tail[0] !== tail[1] && tail.every((s, i) => s === tail[i % 2]);
}

export class LoopGuard {
  private recent = new Map<string, string[]>();
  private failures = new Map<string, Map<string, number>>();
  /** Per agent and call: the last result's hash and how many times in a row it came back. */
  private sameResults = new Map<string, Map<string, { hash: string; streak: number }>>();

  /** Whether to refuse or warn about this call. Counts it as made when allowed. */
  check(agent: string, tool: string, input: unknown): LoopVerdict {
    if (EXEMPT.has(tool)) {
      return {};
    }
    const sig = signature(tool, input);
    const failed = this.failures.get(agent)?.get(sig) ?? 0;
    // A test or build rerun after a fix made elsewhere (a helper, another chat, the user) is progress, not a loop.
    const command = tool === 'Bash' && typeof (input as { command?: unknown } | undefined)?.command === 'string' ? (input as { command: string }).command : '';
    const recheck = TEST_COMMAND.test(command) || BUILD_COMMAND.test(command);
    if (failed >= MAX_FAILURES && !recheck) {
      return { deny: `This exact ${tool} call already failed ${failed} times; repeating it won't help. Read the error, change the approach, or stop and report what is blocking you.` };
    }
    const streak = this.sameResults.get(agent)?.get(sig)?.streak ?? 0;
    if (streak >= MAX_SAME_RESULTS) {
      return { deny: `This exact ${tool} call returned the same result ${streak} times in a row, so you are likely in a loop. Use what it returned, try something different, or stop and report.` };
    }
    const recent = [...(this.recent.get(agent) ?? []), sig];
    if (alternates(recent, PING_PONG_DENY + 1)) {
      return { deny: `You keep alternating between the same two ${tool} calls with nothing changing in between. Step back: change the approach or stop and report.` };
    }
    this.recent.set(agent, recent.slice(-WINDOW));
    if (alternates(recent, PING_PONG_NUDGE + 1)) {
      return { nudge: 'You are alternating between the same two calls. If nothing is changing, change the approach instead of repeating them.' };
    }
    if (streak === MAX_SAME_RESULTS - 1) {
      return { nudge: `This is the same ${tool} call as your last ${streak}, which returned the same result each time. If you are waiting for a change, say so; otherwise try something different.` };
    }
    return {};
  }

  /** A call's outcome. Failures count toward refusing the same call again; an edit resets everything (the state changed). */
  result(agent: string, tool: string, input: unknown, ok: boolean, resultHash: string) {
    if (ok && STATE_CHANGING.has(tool)) {
      this.forget(agent);
      return;
    }
    const sig = signature(tool, input);
    const counts = this.failures.get(agent) ?? new Map<string, number>();
    if (ok) {
      counts.delete(sig);
    } else {
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    this.failures.set(agent, counts);
    const results = this.sameResults.get(agent) ?? new Map<string, { hash: string; streak: number }>();
    const prev = results.get(sig);
    results.set(sig, { hash: resultHash, streak: prev?.hash === resultHash ? prev.streak + 1 : 1 });
    this.sameResults.set(agent, results);
  }

  /** A helper finished, or the chat was reset. */
  forget(agent?: string) {
    for (const map of [this.recent, this.failures, this.sameResults] as Map<string, unknown>[]) {
      if (agent === undefined) {
        map.clear();
      } else {
        map.delete(agent);
      }
    }
  }
}

/**
 * Reading a source or text file through the shell: cat, head, tail, sed -n,
 * less, more, nl, bat. Not when a pipe in the same command filters the output
 * (`cat package.json | jq .version`), which costs fewer tokens than Read.
 */
const FILE_DUMP = /^\s*(?:cd\s+(?:"[^"]*"|\S+)\s*(?:&&|;)\s*)?(cat|head|tail|sed\s+-n|less|more|nl|bat)\b[^|><;&]*?\s(['"]?)[^\s'"|]+\.(ts|tsx|js|jsx|mjs|py|go|rs|swift|java|kt|rb|php|cs|c|cc|cpp|h|hpp|vue|svelte|md|json|ya?ml|toml|css|scss|html|sql|sh)\2(?=\s|$)(?![^;&|]*\|(?!\|))/i;

/**
 * Why a shell command is refused as a file dump, or undefined. In real
 * sessions these were ~95% of shell output and the agents ignored the rule
 * against them; Read caps what it returns and supports ranges. Pipes from
 * another command (`git show x | head`), filtered output and writes are left alone.
 */
export function fileDumpReason(command: string): string | undefined {
  if (!FILE_DUMP.test(command) || /\btail\s+-f\b/.test(command)) {
    return undefined;
  }
  return 'Read files with the Read tool (offset and limit for a range) or code_outline / code_map, not cat, head, tail or sed through the shell: shell output is re-sent on every later call.';
}

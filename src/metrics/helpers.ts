/**
 * One row per helper launch, written when it ends: its type and model, the
 * reply that started it, what it cost (summed from its calls in the call log,
 * which carry its id), the tools it used and what their output cost in
 * context, and how its report checked out. Stored next to the usage ledger as
 * helpers-<machine>.jsonl. On 2026-10-21 ~34 launches made 63% of the tokens
 * and nothing tied them to the launch or the reply that made them.
 */
import type { TokenCounts } from '../usage';
import { JsonlLog } from '../jsonl';

/** How a helper's report checked out (agent/verify.ts). */
export type HelperOutcome = 'checked' | 'unchecked' | 'unverified' | 'contradicted' | 'stopped';

export interface HelperRow {
  /** When it started. */
  at: number;
  endedAt: number;
  machine: string;
  session?: string;
  repo: string;
  /** The spawning Agent call's id: the `helper` on its calls (CallRow). */
  id: string;
  type: string;
  model?: string;
  /** The reply that launched it (TurnMetrics.turn). */
  spawnTurn?: string;
  background?: boolean;
  /** Characters of the brief it was given. */
  promptChars: number;
  calls: number;
  tokens: TokenCounts;
  cost: number;
  /** Its largest context. */
  peakContext: number;
  /** Per tool: calls and characters of output the model read. */
  tools: Record<string, { calls: number; outChars: number }>;
  reportChars?: number;
  outcome?: HelperOutcome;
}

const isRow = (r: any): r is HelperRow => !!r && typeof r.id === 'string' && typeof r.type === 'string' && Number.isFinite(r.at) && !!r.tokens;

export class HelperLog extends JsonlLog<HelperRow> {
  constructor(dir: string, machine: string) {
    super(dir, 'helpers', machine, isRow, (r) => `${r.machine}|${r.id}`);
  }
}

interface Draft {
  id: string;
  type: string;
  at: number;
  spawnTurn?: string;
  promptChars: number;
  task?: string;
  background?: boolean;
  tools: HelperRow['tools'];
  reportChars?: number;
  outcome?: HelperOutcome;
}

/** The helpers of one chat while they run; a row is made when one ends. */
export class HelperTracker {
  private live = new Map<string, Draft>();
  /** Task id (the hooks' agent_id) → spawning call id. */
  private tasks = new Map<string, string>();

  spawn(id: string, type: string, promptChars: number, spawnTurn?: string, background?: boolean) {
    if (!this.live.has(id)) {
      this.live.set(id, { id, type, at: Date.now(), spawnTurn, promptChars, background, tools: {} });
    }
  }

  /** Claude Code's task for a spawn: hooks name helpers by task id, messages by spawn id. */
  task(taskId: string, id: string, background?: boolean) {
    this.tasks.set(taskId, id);
    const d = this.live.get(id);
    if (d) {
      d.task = taskId;
      d.background ||= background;
    }
  }

  /** The spawn id for a task id or spawn id. */
  idOf(key: string): string | undefined {
    return this.live.has(key) ? key : this.tasks.get(key);
  }

  spawnTurnOf(key: string): string | undefined {
    const id = this.idOf(key);
    return id ? this.live.get(id)?.spawnTurn : undefined;
  }

  typeOf(key: string): string | undefined {
    const id = this.idOf(key);
    return id ? this.live.get(id)?.type : undefined;
  }

  isBackground(key: string): boolean {
    const id = this.idOf(key);
    return !!(id && this.live.get(id)?.background);
  }

  tool(key: string, name: string, outChars: number) {
    const d = this.live.get(this.idOf(key) ?? '');
    if (d) {
      const t = (d.tools[name] ??= { calls: 0, outChars: 0 });
      t.calls++;
      t.outChars += outChars;
    }
  }

  outcome(key: string, outcome: HelperOutcome, reportChars: number) {
    const d = this.live.get(this.idOf(key) ?? '');
    if (d) {
      d.outcome = outcome;
      d.reportChars = reportChars;
    }
  }

  /** Ends a helper (by task or spawn id); its calls' totals come from the caller. Undefined if unknown or ended. */
  end(key: string, totals: (id: string) => Pick<HelperRow, 'calls' | 'tokens' | 'cost' | 'peakContext' | 'model'>, base: Pick<HelperRow, 'machine' | 'session' | 'repo'>, outcome?: HelperOutcome): HelperRow | undefined {
    const id = this.idOf(key);
    const d = id ? this.live.get(id) : undefined;
    if (!id || !d) {
      return undefined;
    }
    this.live.delete(id);
    if (d.task) {
      this.tasks.delete(d.task);
    }
    return {
      at: d.at,
      endedAt: Date.now(),
      ...base,
      id,
      type: d.type,
      spawnTurn: d.spawnTurn,
      ...(d.background ? { background: true } : {}),
      promptChars: d.promptChars,
      ...totals(id),
      tools: d.tools,
      ...(d.reportChars !== undefined ? { reportChars: d.reportChars } : {}),
      outcome: d.outcome ?? outcome,
    };
  }

  /** Every helper still running (a closed chat ends them). */
  running(): string[] {
    return [...this.live.keys()];
  }
}

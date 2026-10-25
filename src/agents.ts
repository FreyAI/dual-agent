/**
 * Keeps track of the agents working on a chat: the main agent and the
 * sub-agents it starts (Claude Code's Agent tool), what each has done, the
 * plan (the main agent's to-do list), and the tokens each has used.
 */
import { ApiUsage, freshTokens } from './usage';

/** 'blocked' waits on the user; 'warning' is running but silent for a while, or its last tool failed. */
export type AgentStatus = 'running' | 'idle' | 'done' | 'failed' | 'stopped' | 'blocked' | 'warning';

export interface AgentStep {
  tool: string;
  detail: string;
  at: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  startedAt: number;
  endedAt?: number;
  /** The model it runs on, when known. */
  model?: string;
  tokens: number;
  toolUses: number;
  /** What it is doing right now, or how it ended. */
  summary?: string;
  /** Most recent steps, oldest first. */
  steps: AgentStep[];
  /** Steps dropped from the front of `steps`. */
  earlierSteps: number;
  /** 0 for the main agent, 1 for agents it starts, and so on. */
  depth: number;
  /** Runs in the background, so it can outlive the reply that started it. */
  background?: boolean;
  /** Claude Code's task id, for stopping this agent alone. */
  taskId?: string;
  /** The name the main agent gave it (Agent `name` or SendMessage `to`); runs sharing a name, else a type, are one agent. */
  label?: string;
  /** Its own to-do list, for sub-agents; the main agent's is the snapshot's `plan`. */
  todos?: PlanItem[];
  /** When it last showed any sign of work. */
  lastActivityAt?: number;
  /** Waiting on the user: a permission, question or plan card. */
  blocked?: boolean;
  /** Running with no sign of work for a while. */
  stalled?: boolean;
  /** The tool whose call just failed, until one succeeds. */
  failedTool?: string;
}

export interface PlanItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface AgentsSnapshot {
  agents: AgentInfo[];
  plan: PlanItem[];
  tokens: number;
}

const MAX_STEPS = 40;
/** Finished helper runs kept for the panel; older ones go (their tokens stay in the total). */
const MAX_FINISHED = 30;
/** Message, tool call and resume ids remembered; duplicates and results arrive long before this many newer ones. */
const MAX_IDS = 2000;
export const SPAWN_TOOLS = new Set(['Agent', 'Task']);
/** The Agent call's result when the helper went (or was moved) to the background, or is a teammate or cloud agent: it has started, not finished. */
const LAUNCHED_ASYNC = /^\s*(Async agent launched|Spawned successfully|Cloud agent launched)|running in the background/i;
/** How Claude Code reports a call a PreToolUse hook refused. */
const REFUSED_BY_HOOK = /PreToolUse:\w+ hook/;
const ACTIVE = new Set<AgentStatus>(['running', 'blocked', 'warning']);

/** Still working, even if waiting on the user or flagged. */
export function isActive(status: AgentStatus): boolean {
  return ACTIVE.has(status);
}

interface ToolUse {
  type?: string;
  id: string;
  name: string;
  input: unknown;
}


export class AgentTracker {
  private main = mainAgent();
  private subs = new Map<string, AgentInfo>();
  /** task_id -> key in `subs` (the spawning tool call's id when known). */
  private taskKeys = new Map<string, string>();
  private plan: PlanItem[] = [];
  /** API message ids already counted, since one message can arrive in several parts. */
  private counted = new Set<string>();
  /** Agents whose own messages carried usage: Claude Code's task totals (cache re-reads included) don't overwrite them. */
  private metered = new Set<string>();
  /** Tool call id -> the agent that made it ('main' or a key in `subs`) and the tool. */
  private calls = new Map<string, { agent: string; tool: string }>();
  /** What is waiting on the user -> the agent it holds up. */
  private blocks = new Map<string, string>();
  /** SendMessage call id -> the agent it addressed and why, for the run it resumes. */
  private resumes = new Map<string, { label: string; description: string }>();
  /** Tokens of finished runs dropped from `subs`, so the snapshot total stays right. */
  private droppedTokens = 0;
  /** Task ids Claude Code last listed as live background tasks; undefined until it first lists them (older CLIs never do). */
  private live?: Set<string>;
  /** Helper -> when it first went missing from `live` while still shown working. */
  private missing = new Map<string, number>();
  /** Helpers ended by their own task events, which never reopen. */
  private settled = new Set<string>();
  /** Stalled helpers already reported in the chat, until they show activity again. */
  private warned = new Set<string>();

  constructor(
    private readonly describe: (tool: string, input: unknown) => string,
    /** The model a kind of sub-agent runs on, when it has its own. */
    private readonly modelOf: (agentType: string) => string | undefined = () => undefined,
  ) {}

  reset() {
    this.main = mainAgent();
    this.subs.clear();
    this.taskKeys.clear();
    this.plan = [];
    this.counted.clear();
    this.metered.clear();
    this.calls.clear();
    this.blocks.clear();
    this.resumes.clear();
    this.droppedTokens = 0;
    this.forgetLive();
    this.settled.clear();
  }

  /** The live set is per process: a new one starts empty. */
  private forgetLive() {
    this.live = undefined;
    this.missing.clear();
    this.warned.clear();
  }

  /** Restores a snapshot (a reopened chat); nothing in it is running any more. */
  load(snapshot: AgentsSnapshot | undefined) {
    this.reset();
    if (!snapshot) {
      return;
    }
    for (const a of snapshot.agents) {
      const copy: AgentInfo = { ...a, steps: [...a.steps], status: isActive(a.status) ? 'stopped' : a.status, blocked: undefined, stalled: undefined };
      if (a.id === 'main') {
        this.main = { ...copy, status: 'idle' };
      } else {
        this.subs.set(a.id, copy);
      }
    }
    this.plan = [...snapshot.plan];
    this.droppedTokens = Math.max(0, snapshot.tokens - snapshot.agents.reduce((sum, a) => sum + a.tokens, 0));
  }

  startTurn(model?: string) {
    this.main.model = model;
    this.main.status = 'running';
    // Its time is this reply's, as each helper's is its own job's.
    this.main.startedAt = Date.now();
    this.main.endedAt = undefined;
    this.main.summary = undefined;
    this.main.failedTool = undefined;
    this.touch(this.main);
  }

  endTurn(interrupted: boolean) {
    this.main.status = 'idle';
    this.main.endedAt = Date.now();
    for (const [what, agent] of this.blocks) {
      if (agent === 'main') {
        this.blocks.delete(what);
      }
    }
    this.main.blocked = undefined;
    for (const sub of this.subs.values()) {
      // Background helpers keep working after the reply; their own events end them.
      if (sub.status === 'running' && !(sub.background && !interrupted)) {
        sub.status = interrupted ? 'stopped' : 'done';
        sub.endedAt = Date.now();
      }
    }
  }

  /** Helpers still working (background ones may outlive the reply). */
  helpersWorking(): number {
    return [...this.subs.values()].filter((a) => isActive(a.status)).length;
  }

  /** The process closed: helpers still marked as working died with it. */
  stopHelpers() {
    for (const sub of this.subs.values()) {
      if (isActive(sub.status)) {
        sub.status = 'stopped';
        sub.endedAt = Date.now();
        sub.blocked = sub.stalled = undefined;
      }
    }
    this.forgetLive();
  }

  /** A main-agent API message: its tool calls and token use. */
  mainMessage(messageId: string | undefined, content: unknown[], usage: ApiUsage | undefined) {
    this.message(this.main, messageId, content, usage);
  }

  /** A message from inside a sub-agent (tagged with the tool call that started it). */
  /** The name a helper's calls are counted under: the name it was given, else its type. */
  agentName(parentToolUseId: string): string {
    const sub = this.subs.get(parentToolUseId);
    return sub?.label || sub?.name || 'helper';
  }

  subMessage(parentToolUseId: string, messageId: string | undefined, content: unknown[], usage: ApiUsage | undefined) {
    this.message(this.sub(parentToolUseId), messageId, content, usage);
  }

  /** Tool results the main agent received: a finished sub-agent call ends that agent. */
  mainToolResults(content: unknown[]) {
    this.touch(this.main);
    this.results(content);
  }

  /** Tool results inside a sub-agent (a user message tagged with its parent tool call). */
  subToolResults(parentToolUseId: string, content: unknown[]) {
    this.touch(this.sub(parentToolUseId));
    this.results(content);
  }

  /**
   * Marks the agent behind `id` as waiting on the user, or not any more.
   * `id` is the tool call being asked about (canUseTool's toolUseID), a task id, or undefined for the main agent.
   */
  setBlocked(id: string | undefined, on: boolean) {
    const agent = this.agentFor(id);
    if (on) {
      this.blocks.set(id ?? 'main', agent.id);
    } else {
      this.blocks.delete(id ?? 'main');
      this.touch(agent);
    }
    agent.blocked = [...this.blocks.values()].includes(agent.id) || undefined;
  }

  /** Flags running agents with no sign of work for `ms`; returns whether any changed. Any activity clears it. */
  markStalled(now: number, ms: number): boolean {
    let changed = false;
    for (const a of [this.main, ...this.subs.values()]) {
      if (a.status === 'running' && !a.blocked && !a.stalled && now - (a.lastActivityAt ?? a.startedAt) > ms) {
        a.stalled = true;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Claude Code's full set of live background tasks (a level signal, so a
   * missed start or end event can't leave a stale state): reopens helpers
   * marked finished that still run, and notes working ones gone from it.
   */
  liveTasks(taskIds: string[], now = Date.now()) {
    this.live = new Set(taskIds);
    for (const sub of this.subs.values()) {
      // A resumed task's earlier runs share its id: only its latest run is live.
      if (!sub.taskId || this.taskKeys.get(sub.taskId) !== sub.id) {
        continue;
      }
      if (this.live.has(sub.taskId)) {
        this.missing.delete(sub.id);
        if (!isActive(sub.status) && !this.settled.has(sub.id)) {
          sub.status = 'running';
          sub.background = true;
          sub.endedAt = undefined;
          this.touch(sub);
        }
      } else if (isActive(sub.status) && sub.background && !this.missing.has(sub.id)) {
        this.missing.set(sub.id, now);
      }
    }
  }

  /**
   * The supervisor's check: flags silent agents, ends background helpers
   * missing from the live set for `lostMs` (crashed without a report), and
   * returns helpers newly lost or silent for `stuckMs`, to say so in the chat.
   */
  supervise(now: number, stallMs: number, lostMs: number, stuckMs: number): { lost: AgentInfo[]; stuck: AgentInfo[] } {
    this.markStalled(now, stallMs);
    const lost: AgentInfo[] = [];
    const stuck: AgentInfo[] = [];
    for (const sub of this.subs.values()) {
      const since = this.missing.get(sub.id);
      if (since !== undefined && isActive(sub.status) && now - since >= lostMs) {
        this.missing.delete(sub.id);
        sub.status = 'failed';
        sub.endedAt = now;
        sub.blocked = sub.stalled = undefined;
        sub.summary = 'Stopped without reporting back: Claude Code no longer runs it.';
        lost.push(sub);
      } else if (sub.status === 'running' && !sub.blocked && !this.warned.has(sub.id) && now - (sub.lastActivityAt ?? sub.startedAt) >= stuckMs) {
        this.warned.add(sub.id);
        stuck.push(sub);
      }
    }
    return { lost, stuck };
  }

  taskStarted(m: {
    task_id: string;
    tool_use_id?: string;
    description: string;
    subagent_type?: string;
    task_type?: string;
    spawn_depth?: number;
    ambient?: boolean;
    is_backgrounded?: boolean;
  }) {
    if (m.ambient || (m.task_type && m.task_type !== 'local_agent' && !m.subagent_type)) {
      return;
    }
    const key = m.tool_use_id ?? m.task_id;
    this.taskKeys.set(m.task_id, key);
    const sub = this.sub(key);
    sub.taskId = m.task_id;
    sub.name = m.subagent_type || sub.name;
    sub.description = m.description || sub.description;
    sub.depth = m.spawn_depth ?? sub.depth;
    sub.background = m.is_backgrounded ?? sub.background;
    sub.model = this.modelOf(sub.name) ?? sub.model ?? this.main.model;
  }

  taskProgress(m: { task_id: string; usage: { total_tokens: number; tool_uses: number }; summary?: string; last_tool_name?: string }) {
    const sub = this.byTask(m.task_id);
    if (!sub) {
      return;
    }
    this.touch(sub);
    if (!this.metered.has(sub.id)) {
      sub.tokens = Math.max(sub.tokens, m.usage.total_tokens);
    }
    sub.toolUses = Math.max(sub.toolUses, m.usage.tool_uses);
    sub.summary = m.summary || (m.last_tool_name ? `Using ${m.last_tool_name}` : sub.summary);
  }

  taskUpdated(m: { task_id: string; patch: { status?: string; description?: string; error?: string; is_backgrounded?: boolean } }) {
    const sub = this.byTask(m.task_id);
    if (!sub) {
      return;
    }
    sub.background = m.patch.is_backgrounded ?? sub.background;
    const status = { running: 'running', completed: 'done', failed: 'failed', killed: 'stopped' }[m.patch.status ?? ''] as AgentStatus | undefined;
    if (status) {
      sub.status = status;
      if (status === 'running') {
        sub.endedAt = undefined;
        this.settled.delete(sub.id);
        this.touch(sub);
      } else {
        sub.endedAt ??= Date.now();
        this.settled.add(sub.id);
      }
    }
    sub.description = m.patch.description || sub.description;
    if (m.patch.error) {
      sub.summary = m.patch.error;
    }
  }

  taskEnded(m: { task_id: string; status: 'completed' | 'failed' | 'stopped'; summary: string; usage?: { total_tokens: number; tool_uses: number } }) {
    const sub = this.byTask(m.task_id);
    if (!sub) {
      return;
    }
    sub.status = m.status === 'completed' ? 'done' : m.status;
    sub.endedAt ??= Date.now();
    this.settled.add(sub.id);
    sub.summary = m.summary || sub.summary;
    if (m.usage) {
      if (!this.metered.has(sub.id)) {
        sub.tokens = Math.max(sub.tokens, m.usage.total_tokens);
      }
      sub.toolUses = Math.max(sub.toolUses, m.usage.tool_uses);
    }
  }

  /** Prunes old finished runs first, so the panel updates and the saved chat stay small. */
  snapshot(): AgentsSnapshot {
    this.pruneFinished();
    const agents = [this.main, ...this.subs.values()].map((a) => ({ ...a, steps: [...a.steps], status: shownStatus(a) }));
    return { agents, plan: [...this.plan], tokens: this.droppedTokens + agents.reduce((sum, a) => sum + a.tokens, 0) };
  }

  /** Keeps the newest MAX_FINISHED finished runs; running and blocked ones always stay. */
  private pruneFinished() {
    const finished = [...this.subs.values()].filter((a) => !isActive(a.status)).sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
      this.droppedTokens += old.tokens;
      this.subs.delete(old.id);
      if (old.taskId) {
        this.taskKeys.delete(old.taskId);
      }
      this.settled.delete(old.id);
    }
  }

  private sub(key: string): AgentInfo {
    let sub = this.subs.get(key);
    if (!sub) {
      sub = { id: key, name: 'agent', description: '', status: 'running', startedAt: Date.now(), tokens: 0, toolUses: 0, steps: [], earlierSteps: 0, depth: 1, ...this.resumes.get(key) };
      this.subs.set(key, sub);
    }
    return sub;
  }

  private byTask(taskId: string): AgentInfo | undefined {
    const key = this.taskKeys.get(taskId);
    return key ? this.subs.get(key) : undefined;
  }

  /** The agent behind a tool call, sub-agent key or task id; the main agent otherwise. */
  private agentFor(id: string | undefined): AgentInfo {
    const key = id && (this.calls.get(id)?.agent ?? (this.subs.has(id) ? id : this.taskKeys.get(id)));
    return (key && this.subs.get(key)) || this.main;
  }

  private touch(agent: AgentInfo) {
    agent.lastActivityAt = Date.now();
    agent.stalled = undefined;
    this.warned.delete(agent.id);
  }

  private message(agent: AgentInfo, messageId: string | undefined, content: unknown[], usage: ApiUsage | undefined) {
    this.touch(agent);
    this.count(agent, messageId, usage);
    for (const block of toolUses(content)) {
      this.step(agent, block);
      this.calls.set(block.id, { agent: agent.id, tool: block.name });
      dropOldest(this.calls, MAX_IDS);
      this.onTool(agent, block);
    }
  }

  /** What a tool call tells us: a to-do list, a new helper, or a message resuming a named one. */
  private onTool(agent: AgentInfo, block: ToolUse) {
    const input = (block.input ?? {}) as { todos?: PlanItem[]; description?: string; subagent_type?: string; name?: string; model?: string; to?: string; summary?: string; message?: unknown };
    if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = input.todos.map((t) => ({ content: String(t.content ?? ''), status: t.status, activeForm: t.activeForm }));
      if (agent === this.main) {
        this.plan = todos;
      } else {
        agent.todos = todos;
      }
    } else if (SPAWN_TOOLS.has(block.name)) {
      const sub = this.sub(block.id);
      sub.name = input.subagent_type || 'agent';
      sub.label = input.name || sub.label;
      sub.description = input.description || sub.description;
      sub.depth = agent.depth + 1;
      sub.model = input.model || this.modelOf(sub.name) || agent.model || this.main.model;
    } else if (block.name === 'SendMessage' && input.to) {
      this.resumes.set(block.id, { label: input.to, description: input.summary || String(input.message ?? '').slice(0, 80) });
      dropOldest(this.resumes, MAX_IDS);
    }
  }

  /** Ends sub-agents whose call returned, and notes tool failures on the agent that made the call. */
  private results(content: unknown[]) {
    for (const block of (Array.isArray(content) ? content : []) as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) {
        continue;
      }
      const sub = this.subs.get(block.tool_use_id);
      if (sub && sub.status === 'running' && block.is_error && !sub.taskId && !sub.tokens && REFUSED_BY_HOOK.test(JSON.stringify(block.content ?? ''))) {
        // Refused by a hook before it started (e.g. a brief without a scope): it never was an agent.
        this.subs.delete(block.tool_use_id);
        continue;
      }
      if (sub && sub.status === 'running' && !block.is_error && (LAUNCHED_ASYNC.test(resultText(block.content)) || (sub.background && sub.taskId))) {
        // Its task events (task_notification) end it, not this.
        sub.background = true;
      } else if (sub && sub.status === 'running') {
        sub.status = block.is_error ? 'failed' : 'done';
        sub.endedAt = Date.now();
      }
      const call = this.calls.get(block.tool_use_id);
      if (call && !SPAWN_TOOLS.has(call.tool)) {
        this.agentFor(block.tool_use_id).failedTool = block.is_error ? call.tool : undefined;
      }
    }
  }

  private step(agent: AgentInfo, block: ToolUse) {
    agent.steps.push({ tool: block.name, detail: this.describe(block.name, block.input), at: Date.now() });
    agent.toolUses = Math.max(agent.toolUses, agent.steps.length + agent.earlierSteps);
    if (agent.steps.length > MAX_STEPS) {
      agent.steps.shift();
      agent.earlierSteps++;
    }
  }

  private count(agent: AgentInfo, messageId: string | undefined, usage: ApiUsage | undefined) {
    if (!usage || (messageId && this.counted.has(messageId))) {
      return;
    }
    if (messageId) {
      this.counted.add(messageId);
      dropOldest(this.counted, MAX_IDS);
    }
    // New tokens only, as in the usage pill: cache re-reads are most of the count but little of the cost.
    agent.tokens += freshTokens(usage);
    this.metered.add(agent.id);
  }
}

/** Deletes the earliest-inserted keys beyond `max`. */
function dropOldest(ids: Set<string> | Map<string, unknown>, max: number) {
  for (const id of ids.keys()) {
    if (ids.size <= max) {
      return;
    }
    ids.delete(id);
  }
}

function mainAgent(): AgentInfo {
  return { id: 'main', name: 'Main agent', description: '', status: 'idle', startedAt: Date.now(), tokens: 0, toolUses: 0, steps: [], earlierSteps: 0, depth: 0 };
}

/** A running agent shows as blocked or warning when something holds it up. */
function shownStatus(a: AgentInfo): AgentStatus {
  if (a.status !== 'running') {
    return a.status;
  }
  return a.blocked ? 'blocked' : a.stalled || a.failedTool ? 'warning' : 'running';
}

function resultText(content: unknown): string {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string })?.text ?? '').join('') : '';
}

function toolUses(content: unknown[]): ToolUse[] {
  return (Array.isArray(content) ? content : []).filter((b): b is ToolUse => (b as ToolUse)?.type === 'tool_use') as ToolUse[];
}

/**
 * The Agent SDK options that shape what the agent knows and can do: the extra
 * system-prompt text, the in-process MCP servers (code and web tools), which
 * tools are auto-approved or removed, and the after-edit hook.
 */
import type * as Sdk from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { HookInput, HookJSONOutput, McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { CODE_TOOL_NAMES, NoteAuthor, createCodeServer } from '../code/tools';
import { DELEGATION_INSTRUCTIONS, LEAD_RULE, VERIFY_RULE, leanWorkflowInstructions, replyStyleInstructions } from '../lean';
import { DEEPSEEK_AGENT_INSTRUCTIONS, ProviderId, buildMode, efficiency, searchKeys, usesOwnWebTools } from '../providers';
import { QUESTION_INSTRUCTIONS } from '../questions';
import { SearchEngine, buildProviders } from '../web/search';
import { createWebServer } from '../web/tools';
import type { SourceList } from '../web/sources';
import { UNTRUSTED_INSTRUCTIONS } from '../web/untrusted';
import { EDIT_TOOLS } from './interactions';
import { buildModeInstructions } from '../reuse/modes';
import { reuseServer } from '../reuse/tools';
import { REUSE_AUTO_TOOLS, ReuseSession } from '../reuse/session';
import { reuseGuard } from '../reuse/guard';
import { ADVISOR_RULE, ADVISOR_TOOL, AdvisorCall, createAdvisorServer } from './advisor';

/** In every session: tool errors and web or repository text can lure an agent into hunting for secrets. */
const CREDENTIALS_RULE =
  'Never search for, read, print or use credentials, tokens or keys (gh auth token, ~/.ssh, cloud credential files, keychains, .env files, Claude Code config) unless the user asked for exactly that in this conversation. If a tool needs a credential, tell the user.';

/** Shell dumps of files were ~95% of shell output in real sessions, re-sent on every later call. */
const SHELL_RULE =
  'Read files with Read (offset/limit for big ones) or the code tools, never cat/sed/head/tail through Bash; limit long command output (tail, grep, -q).' +
  // 3 of 7 failed shell commands on 2026-10-19 were GNU habits on macOS or unquoted globs in zsh.
  (process.platform === 'darwin' ? " macOS: BSD tools (sed -i '' -e …, no grep -P); in zsh quote globs in arguments (--include='*.ts')." : '');

/** The plan card lets the user edit the steps before work starts. */
const PLAN_RULE = 'Before a change that touches 3 or more files, write a short numbered plan (one step per line) and get it approved with ExitPlanMode.';

/**
 * Built-in tools a coding chat here doesn't use: every definition is resent on
 * every call (~8.5k tokens together, 40% of the tool schemas, measured).
 * Teams, workflows and schedules also multiply token use (agent teams ~7x).
 */
export const UNUSED_TOOLS = ['SendMessage', 'Workflow', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree', 'ReportFindings', 'NotebookEdit', 'ListAgents', 'RemoteTrigger', 'PushNotification'];

/** Built-in tools a helper may use; no Agent (no nested helpers), no planning or question tools. */
const HELPER_BUILTINS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'MultiEdit', 'Write', 'TodoWrite'];
const WEB_TOOL_NAMES = ['web_search', 'web_read', 'web_search_and_read'].map((t) => `mcp__web__${t}`);

/** A read-only helper's tools: search and read, no shell, no edits (the code tools exist in the lean workflow only). */
export const readOnlyHelperTools = () => ['Read', 'Grep', 'Glob', ...(efficiency().lean ? ['code_map', 'code_outline', 'code_definition', 'code_references', 'notes_read'].map((t) => `mcp__code__${t}`) : [])];

/** The tools each helper gets: fewer definitions per helper call (~10k tokens of schemas before). */
export function helperToolNames(provider: ProviderId): string[] {
  const { lean } = efficiency();
  return [...HELPER_BUILTINS, ...(lean ? CODE_TOOL_NAMES : []), ...(usesOwnWebTools(provider) ? WEB_TOOL_NAMES : ['WebSearch', 'WebFetch'])];
}

/** What compaction must keep (rules dropped by compaction get violated: 0% → 30% in one study). */
const COMPACT_INSTRUCTIONS =
  '# Compact instructions\nWhen summarizing this conversation, keep: the user\'s goal and every constraint or always/never instruction they gave, decisions made and why, files changed, failing tests or errors not yet fixed, open to-dos, and what was verified versus not.';

/** One search engine for every chat, so its cache and the blocked-provider pauses are shared. */
let webEngine = new SearchEngine(() => buildProviders(searchKeys()));

/** Points every chat's web tools at another search engine (the tests use a local fake web). */
export function setWebEngine(engine: SearchEngine) {
  webEngine = engine;
}

/** Plain web search on the shared engine (reuse mode's fallback when GitHub's API is out of quota). */
export const webSearch = async (query: string, count: number) => (await webEngine.search(query, count)).results;

export interface AgentSetup {
  provider: ProviderId;
  cwd: string;
  /** Whether helper agents are available, so the rules can mention them. */
  hasHelpers: boolean;
  sources: SourceList;
  /** The after-edit check, run as a PostToolUse hook. */
  onEdit: (input: HookInput) => Promise<HookJSONOutput>;
  /** Every finished tool call: metrics, evidence, and a note back to the agent when output shows a hidden failure. */
  onTool: (input: HookInput) => HookJSONOutput | void;
  /** Before every tool call: refuses loops and shell file dumps. */
  onPreTool: (input: HookInput) => HookJSONOutput | Promise<HookJSONOutput>;
  /** This chat's downloaded repositories, for the reuse tools. */
  reuse: ReuseSession;
  /** Project memory from earlier sessions, for a new conversation. */
  memory?: string;
  /** A compaction's summary, kept as the project's handoff note, and what started it (auto or manual). */
  onCompact: (summary: string, trigger: string) => void;
  /** Project memory to re-add right after a compaction. */
  afterCompact: () => string | undefined;
  /** What every helper starts with (memory/helperBrief): fixed for the agent process, so it stays cached. */
  helperBrief?: string;
  /** A helper was given the brief (for the memory metrics). */
  onHelperBrief?: (agentType: string) => void;
  /** Who made a notes_add call, so a helper's note waits for its report to check out. */
  noteAuthor?: NoteAuthor;
  /** Files and words the code map ranks first (edited files, the user's words). */
  focus: () => { files: string[]; words: string[] };
  /** The main agent or a helper is about to stop: its report is checked against its work. */
  onStop: (input: HookInput) => Promise<HookJSONOutput>;
  /** Seconds the main agent's Stop hook may take; longer when it also runs the project's checks. */
  stopTimeoutSec?: number;
  /** A stronger model the main agent may consult (DeepSeek Flash with V4 Pro advising). */
  advisor?: AdvisorCall;
}

/** Helpers that only locate code finish in a few steps; commands and gotchas would be noise to them. */
const NO_BRIEF = new Set(['searcher']);

/** The SubagentStart hook's answer: the project brief, added before the helper's first prompt. */
export function helperStart(input: HookInput, brief: string): HookJSONOutput {
  if (input.hook_event_name !== 'SubagentStart' || NO_BRIEF.has(input.agent_type)) {
    return {};
  }
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: brief } };
}

export function agentOptions(sdk: typeof Sdk, setup: AgentSetup): Partial<Options> {
  const ownWeb = usesOwnWebTools(setup.provider);
  const observe = async (input: HookInput): Promise<HookJSONOutput> => setup.onTool(input) ?? {};
  const { replyStyle, lean } = efficiency();
  const mode = buildMode();
  const reusing = mode !== 'craft';
  // Claude Code records the system prompt on a conversation's first request and
  // reuses it on resume, so changes here reach new chats only.
  const append = [
    QUESTION_INSTRUCTIONS,
    CREDENTIALS_RULE,
    SHELL_RULE,
    PLAN_RULE,
    VERIFY_RULE,
    replyStyleInstructions(replyStyle),
    lean ? leanWorkflowInstructions(setup.hasHelpers) : setup.hasHelpers ? DELEGATION_INSTRUCTIONS : undefined,
    setup.hasHelpers && setup.provider === 'claude' ? LEAD_RULE : undefined,
    buildModeInstructions(mode),
    // DeepSeek over-refuses code it reads as copyrighted; frame the repo as the user's.
    setup.provider === 'deepseek' ? DEEPSEEK_AGENT_INSTRUCTIONS : undefined,
    ownWeb ? UNTRUSTED_INSTRUCTIONS : undefined,
    setup.advisor ? ADVISOR_RULE : undefined,
    setup.memory,
    COMPACT_INSTRUCTIONS,
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    // Dynamic sections (cwd, git status, memory path) move to the first message, so the system prompt is identical across sessions and stays cached.
    systemPrompt: { type: 'preset', preset: 'claude_code', append: append || undefined, excludeDynamicSections: true },
    // The main agent's to-do list is the plan shown in the agents panel; the code tools only read.
    allowedTools: ['TodoWrite', ...(lean ? CODE_TOOL_NAMES : []), ...(reusing ? REUSE_AUTO_TOOLS : []), ...(setup.advisor ? [ADVISOR_TOOL] : [])],
    mcpServers: {
      ...(lean ? { code: createCodeServer(sdk, () => setup.cwd, setup.focus, setup.noteAuthor) } : {}),
      ...(ownWeb ? { web: createWebServer(sdk, { engine: webEngine, sources: setup.sources }) } : {}),
      ...(reusing ? { reuse: reuseServer(sdk, setup.reuse) } : {}),
      ...(setup.advisor ? { advisor: createAdvisorServer(sdk, setup.advisor) } : {}),
    },
    // One way to go online, so the agent doesn't pick between two.
    disallowedTools: [...UNUSED_TOOLS, ...(ownWeb ? ['WebSearch', 'WebFetch'] : [])],
    hooks: {
      // Downloaded repositories are reached only through the reuse tools.
      PreToolUse: [{ hooks: [reuseGuard(mode), async (input) => setup.onPreTool(input)], timeout: 5 }],
      PostToolUse: [
        { hooks: [observe], timeout: 5 },
        ...(lean ? [{ matcher: EDIT_TOOLS.join('|'), hooks: [setup.onEdit], timeout: 30 }] : []),
      ],
      PostToolUseFailure: [{ hooks: [observe], timeout: 5 }],
      // Helpers otherwise work out the project's commands and pitfalls again on every launch (~34 launches, 2026-10-21).
      ...(setup.helperBrief
        ? {
            SubagentStart: [
              {
                hooks: [
                  async (input: HookInput) => {
                    const out = helperStart(input, setup.helperBrief!);
                    if ('hookSpecificOutput' in out && input.hook_event_name === 'SubagentStart') {
                      setup.onHelperBrief?.(input.agent_type);
                    }
                    return out;
                  },
                ],
                timeout: 5,
              },
            ],
          }
        : {}),
      // A claims check can take a git status; the agent waits for it.
      Stop: [{ hooks: [setup.onStop], timeout: setup.stopTimeoutSec ?? 15 }],
      SubagentStop: [{ hooks: [setup.onStop], timeout: 15 }],
      SessionStart: [
        {
          matcher: 'compact',
          hooks: [
            async (input) => {
              const memory = input.hook_event_name === 'SessionStart' ? setup.afterCompact() : undefined;
              return memory ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: memory } } : {};
            },
          ],
          timeout: 5,
        },
      ],
      PostCompact: [
        {
          hooks: [
            async (input) => {
              if (input.hook_event_name === 'PostCompact') {
                setup.onCompact(input.compact_summary, input.trigger);
              }
              return {};
            },
          ],
          timeout: 5,
        },
      ],
    },
  };
}

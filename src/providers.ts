/**
 * The two backends and how to reach them: settings, stored keys, how a
 * Claude Code process is launched for Claude (the user's sign-in or an
 * Anthropic key) or for DeepSeek (its Anthropic-compatible endpoint, in a
 * config folder with no Claude sign-in), and the helper agents' models.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { DEEP_THINKER_LEAN, HELPER_REPORT_INSTRUCTIONS, QUICK_HELPER_LEAN, ReplyStyle, SHARED_NOTES_RULE, VERIFY_RULE } from './lean';
import type { BuildMode } from './reuse/modes';
import { DeepSeekRoute, diagnoseCaches, proxyUrl, routeDeepSeekHelpers } from './proxy/registry';
import { writeAtomic } from './memory/files';
import { ClaudeTier, bestClaude, deepseekDefault, discoveredDeepSeek } from './models';
import { CostLimits, activeLimits } from './costLimits';

export type ProviderId = 'claude' | 'deepseek';
export type Mode = 'auto' | ProviderId;
/** Flash answers quickly without extended thinking; Thinking reasons first on the stronger model. */
export type Effort = 'flash' | 'thinking';
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude',
  deepseek: 'DeepSeek',
};

export function otherProvider(p: ProviderId): ProviderId {
  return p === 'claude' ? 'deepseek' : 'claude';
}

/**
 * Appended to DeepSeek's system prompt. DeepSeek's model is trained to refuse
 * anything it reads as a copyright request, and it over-fires on code: a
 * repository of the user's own code, or code that merely resembles published
 * material, gets a refusal where Claude would just do the job. This frames the
 * context so the model declines only real reproduction requests.
 */
export const DEEPSEEK_AGENT_INSTRUCTIONS = `You are a coding agent inside the user's own repository: the files here are the user's project or ones they are authorized to work with, so reading, searching, summarizing, planning around, and editing them is the job, not a copyright concern. Decline only when the user asks you to reproduce third-party copyrighted material at length (song lyrics, book passages, news articles, and the like) — not when a coding task touches code already in the workspace, even if it resembles published code. When a request is close to that line, do the coding work and flag the concern instead of refusing.`;

export function settings() {
  return vscode.workspace.getConfiguration('dualAgent');
}

/** The model set in settings, else the newest one DeepSeek lists (models.ts), else the MODELS.md default. */
export function deepseekModel(effort: Effort): string {
  return settings().get<string>(effort === 'flash' ? 'deepseek.fastModel' : 'deepseek.model') || discoveredDeepSeek(effort) || deepseekDefault(effort);
}

/** A Claude helper model: set in settings, else the best family this account offers (models.ts). Quick jobs always take the fast one. */
export function claudeModel(tier: ClaudeTier): string {
  const set = tier === 'fast' ? undefined : settings().get<string>(tier === 'planner' ? 'claude.plannerModel' : 'claude.helperModel');
  return set || bestClaude(tier);
}

/** This extension's version, as Claude Code reports the client app. */
const EXTENSION_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

/**
 * Effort per provider. DeepSeek defaults to V4 Pro (Thinking) so the supervisor and
 * planning run on the strong model; auto mode still routes mechanical reads and
 * delegation to Flash. Claude defaults to Thinking.
 */
export function effortFor(provider: ProviderId): Effort {
  return provider === 'deepseek' ? (settings().get<Effort>('deepseek.effort') ?? 'thinking') : (settings().get<Effort>('effort') ?? 'thinking');
}

/** The setting that holds a provider's effort. */
export const effortSetting = (provider: ProviderId) => (provider === 'deepseek' ? 'deepseek.effort' : 'effort');

/**
 * How much auto mode uses Claude while it is being phased out. backup (the
 * default): DeepSeek does everything; Claude only takes over when V4 Pro is
 * stuck or DeepSeek is down. off: never. primary: Claude first while its quota
 * is on pace. Picking Claude by hand always works.
 */
export type ClaudeRole = 'primary' | 'backup' | 'off';

export function claudeRole(): ClaudeRole {
  return settings().get<ClaudeRole>('claudeRole') ?? 'backup';
}

/**
 * Claude's target share of today's tokens in auto mode (0-100), set from the
 * usage panel's Split tab. When set it replaces claudeRole: new tasks go to
 * whichever provider is under its share.
 */
export function tokenSplit(): number | undefined {
  // A repo's own split (null: off there) wins over the setting, which defaults to 50.
  const repo = repoSettings?.store.get<number | null>('tokenSplit');
  const v = repo !== undefined ? repo : settings().get<number | null>('tokenSplit');
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : undefined;
}

/** The workspace's storage: a split set in a repo stays that repo's default for every new chat, and a change reaches its open chats. */
let repoSettings: { store: vscode.Memento; changed: () => void } | undefined;
export function useRepoSettings(store: vscode.Memento, changed: () => void) {
  repoSettings = { store, changed };
}

export async function saveTokenSplit(claude: number | null) {
  const v = claude === null ? null : Math.min(100, Math.max(0, Math.round(claude)));
  if (!repoSettings) {
    await settings().update('tokenSplit', v ?? undefined, vscode.ConfigurationTarget.Global);
    return;
  }
  await repoSettings.store.update('tokenSplit', v);
  repoSettings.changed();
}

/** Whether auto mode may use Claude at all: a 0% split or the "off" role rule it out. */
export function claudeAllowed(): boolean {
  const split = tokenSplit();
  return split === undefined ? claudeRole() !== 'off' : split > 0;
}

/** The provider auto mode starts on. */
export const autoPrimary = (): ProviderId => {
  const split = tokenSplit();
  return (split === undefined ? claudeRole() === 'primary' : split >= 50) ? 'claude' : 'deepseek';
};

/** Reuse, craft or hybrid; a project starts in hybrid. */
export function buildMode(): BuildMode {
  return settings().get<BuildMode>('buildMode') ?? 'hybrid';
}

/** Saves the build mode for this project (the workspace), or globally when no folder is open. */
/** The cost limits set in the settings, or undefined while none is (the default). */
export const configuredLimits = (): CostLimits | undefined => activeLimits(settings().get<number>('costLimitUsd'), settings().get<Record<string, number>>('modelCostLimitsUsd'));

/** The Cost tab's limits, in the user settings like the rest; 0 (or a model left out) is off. */
export async function saveCostLimits(c: { total?: number; daily?: number; perModel?: Record<string, number> }) {
  const g = vscode.ConfigurationTarget.Global;
  const usd = (n: number) => Math.max(0, Math.round(n * 100) / 100);
  if (c.total !== undefined) await settings().update('costLimitUsd', usd(c.total), g);
  if (c.daily !== undefined) await settings().update('dailyBudgetUsd', usd(c.daily), g);
  if (c.perModel) await settings().update('modelCostLimitsUsd', Object.fromEntries(Object.entries(c.perModel).filter(([k, v]) => k.trim() && v > 0).map(([k, v]) => [k.trim(), usd(v)])), g);
}

export async function saveBuildMode(mode: BuildMode) {
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await settings().update('buildMode', mode, target);
}

/** A GitHub token from the credentials file, for higher API limits in reuse mode (optional). */
export function githubToken(): string | undefined {
  return readCredential(settings().get<string>('deepseek.apiKeyFile'), 'GITHUB_TOKEN');
}

/** How terse the agent's replies are, and whether it follows the lean coding habits. */
export function efficiency(): { replyStyle: ReplyStyle; lean: boolean } {
  const cfg = settings();
  return { replyStyle: cfg.get<ReplyStyle>('replyStyle') ?? 'full', lean: cfg.get<boolean>('leanWorkflow') ?? true };
}

const SECRET_DEEPSEEK = 'dualAgent.deepseekApiKey';
const SECRET_ANTHROPIC = 'dualAgent.anthropicApiKey';

// Variables that decide which backend Claude Code talks to. They are cleared
// before every launch so a value exported in the user's shell can never route
// a session to the wrong provider.
const ROUTING_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_EXTRA_BODY',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CONFIG_DIR',
];

export class Credentials {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** A configured key file takes precedence, so rotating the key there is picked up. */
  async getDeepSeekKey(): Promise<string | undefined> {
    return readKeyFile(settings().get<string>('deepseek.apiKeyFile')) ?? (await this.secrets.get(SECRET_DEEPSEEK));
  }
  async deepSeekKeySource(): Promise<string> {
    const file = settings().get<string>('deepseek.apiKeyFile');
    if (readKeyFile(file)) {
      return `API key from ${path.basename(file!)}`;
    }
    if (await this.secrets.get(SECRET_DEEPSEEK)) {
      return 'API key set';
    }
    return file ? `no DEEPSEEK_API_KEY readable in ${path.basename(file)}` : 'no API key';
  }
  setDeepSeekKey(key: string) {
    return this.secrets.store(SECRET_DEEPSEEK, key);
  }
  getAnthropicKey() {
    return this.secrets.get(SECRET_ANTHROPIC);
  }
  setAnthropicKey(key: string) {
    return this.secrets.store(SECRET_ANTHROPIC, key);
  }
  async clear() {
    await this.secrets.delete(SECRET_DEEPSEEK);
    await this.secrets.delete(SECRET_ANTHROPIC);
  }
}

/** Everything that differs between a Claude session and a DeepSeek session. */
export interface LaunchConfig {
  provider: ProviderId;
  env: Record<string, string | undefined>;
  model?: string;
  thinking?: { type: 'disabled' };
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Claude Code settings for this launch (fast mode, the advisor). */
  settings?: { fastMode?: boolean; advisorModel?: string };
  /** Who runs each helper tier: the other provider only when the proxy can carry its requests. */
  roster: HelperRoster;
}

/**
 * Who runs each helper tier. `work`: quick jobs, searches and delegated tasks (the
 * cheap side of the split). `plan`: Plan and deep-thinker (Claude Opus while its
 * quota allows, else DeepSeek's strongest). Picked by agent/router.ts helperRoster.
 */
export interface HelperRoster { work: ProviderId; plan: ProviderId }

export const soloRoster = (p: ProviderId): HelperRoster => ({ work: p, plan: p });
export const usesProvider = (r: HelperRoster, p: ProviderId) => r.work === p || r.plan === p;

/** A sub-agent the main agent can hand work to, with its own model. */
export interface HelperAgent {
  description: string;
  prompt: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxTurns: number;
  /** Helpers compact sooner than the main agent: their context is re-sent on every call. */
  autoCompactWindow: number;
  /** Skip the project's CLAUDE.md: for helpers that only search and read from a full brief. */
  omitClaudeMd?: boolean;
  /** Only these tools (read-only helpers); otherwise every helper's set. */
  readOnly?: boolean;
}

/**
 * Helpers compact at the smallest window Claude Code allows. On 2026-10-17's
 * real sessions, 12 helpers grew to 130-240k contexts over 1,500 calls (200M
 * tokens); compacting at 100k would have cut that by about half (simulated).
 */
const HELPER_COMPACT_WINDOW = 100_000;
/** Runaway guards, not budgets: a stopped helper's work is lost, so they sit above normal jobs. */
const MAX_TURNS = { quick: 30, deep: 40, general: 80, search: 6 };

/** Claude Code's own general-purpose helper, redefined with our model, limits and rules (same name, so it replaces the built-in). */
export const GENERAL_HELPER = 'general-purpose';

/**
 * When the main conversation compacts. Every call re-sends the whole context,
 * so a long session's cost grows with it; compacting at 160-200k instead of
 * near 1M cut main-thread input 57-89% on real sessions (simulated).
 */
export function compactWindow(provider: ProviderId): number {
  const configured = settings().get<number>('compactWindow') ?? 0;
  return configured >= 100_000 ? Math.min(configured, 1_000_000) : provider === 'deepseek' ? 160_000 : 200_000;
}

/** Shell output the agent sees inline; longer output goes to a file it can search. */
export const BASH_OUTPUT_CHARS = 12_000;

/** Output caps, unless the user's environment sets its own. */
const OUTPUT_CAPS: Record<string, string> = {
  MAX_MCP_OUTPUT_TOKENS: '8000',
  CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '10000',
};

/** Claude Code extras a chat has no use for, unless the user's environment sets its own. */
const BACKGROUND_OFF: Record<string, string> = {
  // Also skips the small-model call that writes session titles.
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
};

/**
 * Cheaper and stronger helpers. The main agent picks one per job from the
 * descriptions, so simple jobs run on the fast model and hard ones on the
 * strong one, whatever the main conversation runs on.
 */
/** Helpers that may run at once (dualAgent.maxParallelHelpers). */
export const maxParallelHelpers = () => Math.max(1, Math.min(20, settings().get<number>('maxParallelHelpers') ?? 4));

export function helperAgents(roster: HelperRoster): Record<string, HelperAgent> {
  if (!(settings().get<boolean>('helperAgents') ?? true)) {
    return {};
  }
  // Helpers were 76% of a long session's cost on Opus: only planning runs there; Sonnet takes delegated work on Claude.
  const ds = roster.work === 'deepseek';
  const fast = ds ? deepseekModel('flash') : claudeModel('fast');
  const strong = roster.plan === 'deepseek' ? deepseekModel('thinking') : claudeModel('planner');
  const limits = (maxTurns: number) => ({ maxTurns, autoCompactWindow: HELPER_COMPACT_WINDOW });
  const { replyStyle, lean } = efficiency();
  const withRules = (base: string, leanRule?: string) =>
    [base, VERIFY_RULE, lean ? leanRule : undefined, lean ? SHARED_NOTES_RULE : undefined, replyStyle !== 'off' ? HELPER_REPORT_INSTRUCTIONS : undefined].filter(Boolean).join(' ');
  return {
    'quick-helper': {
      description:
        'Fast, low-cost helper for well-defined small jobs: finding files, searching the code, reading and summarizing files, looking something up on the web, ' +
        'running a command and reporting the output, well-specified edits in files you name. Several can run in parallel on independent parts. Prefer it for anything that does not need deep reasoning.',
      prompt: withRules('You are a fast helper. Do exactly the job you are given, efficiently, and report the result concisely.', QUICK_HELPER_LEAN),
      model: fast,
      effort: 'low',
      ...limits(MAX_TURNS.quick),
      omitClaudeMd: true,
    },
    // Retrieval took over 60% of a coding agent's first turn (Cognition's SWE-grep): a fast searcher that only locates.
    searcher: {
      description:
        'Fastest, cheapest way to locate code: where something is defined or used, how a flow runs across files, which files a change touches. ' +
        'Returns only file paths with line ranges and a one-line note each; it reads and edits nothing else. Use it before reading around yourself.',
      prompt:
        'You locate code. In every step, make several searches in parallel (Grep, Glob, code_map, code_references); confirm with small Read ranges; finish within 4 steps. ' +
        'Reply with only a list: `path:start-end - one-line note`, most relevant first, then one line on anything you could not find. No explanations, no edits.',
      model: fast,
      effort: 'low',
      ...limits(MAX_TURNS.search),
      omitClaudeMd: true,
      readOnly: true,
    },
    'deep-thinker': {
      description:
        'Careful reasoning for hard problems: debugging a tricky failure, designing a change across several files, reviewing for subtle bugs. ' +
        'Slower and costs more; use it only when the job needs it.',
      prompt: withRules(
        'You are a careful engineer. Think the problem through, check your conclusions against the code, and report what you found and why.',
        DEEP_THINKER_LEAN,
      ),
      model: strong,
      effort: 'high',
      ...limits(MAX_TURNS.deep),
    },
    // Planning is where the supervisor thinks hard: the strongest model even while the other helpers run on the cheap one.
    Plan: {
      description:
        'Software architect agent for designing implementation plans. Use it to plan the implementation strategy for a task: ' +
        'it returns step-by-step plans, names the critical files, and considers architectural trade-offs.',
      prompt: withRules(
        'You are a software architect. Plan the implementation strategy: break the work into ordered steps, name the critical files, and weigh the trade-offs. Do not edit files.',
        DEEP_THINKER_LEAN,
      ),
      model: strong,
      effort: 'high',
      ...limits(MAX_TURNS.deep),
    },
    [GENERAL_HELPER]: {
      description:
        'General-purpose agent for multi-step tasks: researching a question across the code, or carrying out a well-briefed change in the files you name. ' +
        'Give it a self-contained brief sized to finish in about 30 steps; split bigger work.',
      prompt: withRules(
        'You are a capable engineer working on one delegated task. Stay inside the brief, finish it, verify it (build or tests), and report what changed and how you checked it.',
        QUICK_HELPER_LEAN,
      ),
      model: ds ? fast : claudeModel('helper'),
      // Sonnet defaults to high; medium makes fewer, terser tool calls on well-briefed jobs. Hard ones go to deep-thinker.
      effort: ds ? 'low' : 'medium',
      ...limits(MAX_TURNS.general),
    },
  };
}

/** The model a provider runs at an effort level, for display. */
export function modelFor(provider: ProviderId, effort: Effort): string | undefined {
  const cfg = settings();
  if (provider === 'claude') {
    return cfg.get<string>('claude.model') || undefined;
  }
  return deepseekModel(effort);
}

export class MissingCredentialError extends Error {}

/** Whether a Claude chat's helpers may run on DeepSeek (dualAgent.deepseekHelpers). */
export const deepseekHelpersAllowed = () => settings().get<boolean>('deepseekHelpers') ?? true;

/** Whether a DeepSeek chat's planning and some delegated work may run on Claude (dualAgent.claudeHelpers). */
export const claudeHelpersAllowed = () => settings().get<boolean>('claudeHelpers') ?? true;

/** Claude Code's built-in helpers (general-purpose, Explore) otherwise run on the main model: they take the delegated-work model. */
const subagentModel = (r: HelperRoster) => (r.work === 'deepseek' ? deepseekModel('flash') : claudeModel('helper'));

/**
 * `wanted`: who should run each helper tier. The other provider's requests go
 * through the Claude proxy, which diverts DeepSeek models to DeepSeek without
 * the sign-in; when it can't start, the launch's roster falls back to one provider.
 */
export async function buildLaunch(provider: ProviderId, effort: Effort, creds: Credentials, wanted: HelperRoster = soloRoster(provider)): Promise<LaunchConfig> {
  const env: Record<string, string | undefined> = { ...process.env };
  const userConfigDir = process.env.CLAUDE_CONFIG_DIR;
  for (const key of ROUTING_ENV) {
    delete env[key];
  }
  if (userConfigDir) {
    // The user's own Claude Code folder, if they moved it: that's where their sign-in is.
    env.CLAUDE_CONFIG_DIR = userConfigDir;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `dual-agent-vscode/${EXTENSION_VERSION}`;
  for (const [name, value] of Object.entries({ ...OUTPUT_CAPS, ...BACKGROUND_OFF })) {
    env[name] ??= value;
  }
  // The plan panel, the report check and the loop rules read TodoWrite; without this Claude Code swaps it for its Task tools.
  env.CLAUDE_CODE_ENABLE_TASKS ??= '0';
  // Fan-out is the biggest cost lever: Claude Code allows 20 helpers at once, and on 2026-10-19 eleven parallel
  // helpers wrote 1.4M cache tokens in one session (each new helper writes its own cache at 1.25-2x input price).
  env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ??= String(maxParallelHelpers());
  // Helpers don't start helpers (they have no Agent tool either).
  env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH ??= '1';
  // A helper's cache rarely outlives its job; the 1-hour write costs 2x input, the 5-minute one 1.25x.
  env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL ??= '5m';
  // Fork mode (on by default) removes run_in_background from the Agent tool, so every helper ran in the background
  // and each report started another main-agent turn: 27 automatic turns, $11.59 of $20.92 on 2026-10-21.
  // Off, the main agent can wait for parallel helpers and review their reports in one turn.
  env.CLAUDE_CODE_FORK_SUBAGENT ??= '0';
  const otlp = settings().get<string>('telemetry.otlpEndpoint');
  if (otlp) {
    // Claude Code's own OpenTelemetry metrics and events (tokens, cost, latency, tool results).
    // Prompts and tool details stay redacted, as is Claude Code's default.
    Object.assign(env, {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: settings().get<string>('telemetry.otlpProtocol') || 'http/protobuf',
      OTEL_EXPORTER_OTLP_ENDPOINT: otlp,
      OTEL_RESOURCE_ATTRIBUTES: `service.name=dual-agent,dual_agent.provider=${provider}`,
    });
  }
  const cfg = settings();

  if (provider === 'claude') {
    // Server-side clearing rewrites the whole cached conversation each time it clears (6 rewrites, $4.43 of $17 on
    // 2026-10-21) and pays back only after ~100-180 calls; compaction comes sooner. Off unless chosen.
    const clearOld = cfg.get<boolean>('claude.clearOldToolResults') ?? false;
    const diagnose = cfg.get<boolean>('cacheDiagnostics') ?? true;
    diagnoseCaches(diagnose);
    // "Thinking" ran at high effort on every turn, status replies included (5-15 s per call on 2026-10-19); medium unless chosen.
    const claudeEffort = effort === 'flash' ? 'low' : (cfg.get<'medium' | 'high' | 'xhigh'>('claude.thinkingEffort') ?? 'medium');
    const fast = cfg.get<boolean>('claude.fastMode') ?? false;
    // A faster executor with a stronger advisor (Sonnet + Opus advisor: +2.7 points at 11.9% less cost, Anthropic 2026-04).
    const advisor = cfg.get<boolean>('claude.advisor') ?? false;
    const model = advisor && !cfg.get<string>('claude.model') ? 'sonnet' : modelFor(provider, effort);
    const claudeSettings = fast || advisor ? { ...(fast ? { fastMode: true } : {}), ...(advisor ? { advisorModel: 'opus' } : {}) } : undefined;
    const apiKey = await creds.getAnthropicKey();
    const route = usesProvider(wanted, 'deepseek') ? await deepseekRoute(creds) : undefined;
    // Shared by every Claude chat's proxy; a chat with Claude helpers sends no DeepSeek models, so it never clears it.
    if (route) {
      routeDeepSeekHelpers(route);
    }
    // The proxy also carries DeepSeek helpers and cache diagnostics, so it runs when any is wanted.
    const proxied = clearOld || route || diagnose ? await proxyUrl('https://api.anthropic.com', clearOld ? 'clear' : 'claude') : undefined;
    // Background calls a chat doesn't need (Claude Code's own telemetry and error reports); DeepSeek chats turn off all nonessential traffic.
    env.DISABLE_TELEMETRY ??= '1';
    env.DISABLE_ERROR_REPORTING ??= '1';
    const roster = route && proxied ? wanted : soloRoster('claude');
    env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel(roster);
    if (proxied) {
      env.ANTHROPIC_BASE_URL = proxied;
      // A non-Anthropic base URL would otherwise send every tool definition upfront (55k vs 33k tokens per call, measured).
      env.ENABLE_TOOL_SEARCH ??= 'true';
      // Off by default behind a custom base URL: large Write/Edit inputs would arrive only once fully written.
      env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING ??= '1';
      // Requests say whether they're a compaction or the first after one, so cache diagnostics can tell expected misses.
      env.CLAUDE_CODE_GATEWAY_HINT_HEADERS ??= '1';
      if (fast) {
        // The fast-mode availability check doesn't go through ANTHROPIC_BASE_URL.
        env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK ??= '1';
      }
    }
    if (!apiKey) {
      // Claude Code uses the claude.ai sign-in stored on this machine.
      return { provider, env, model, effort: claudeEffort, settings: claudeSettings, roster };
    }
    // When signed in, Claude Code ignores ANTHROPIC_API_KEY and keeps using the
    // sign-in. Away from the sign-in, the key is what gets used and billed.
    keyedSession(env, apiKey);
    // Pay-per-token caches last 5 minutes; chats pause longer than that, and a rewrite costs more than the 1-hour write.
    env.CLAUDE_CODE_PROMPT_CACHE_TTL ??= '1h';
    return { provider, env, model, effort: claudeEffort, settings: claudeSettings, roster };
  }

  const key = await creds.getDeepSeekKey();
  if (!key) {
    throw new MissingCredentialError('No DeepSeek API key set. Run "Dual Agent: Set DeepSeek API Key".');
  }
  const model = modelFor(provider, effort)!;
  const fastModel = deepseekModel('flash');
  // DeepSeek handles deferred tools: 31k → 16k input tokens per call, and a deferred tool still loads when needed (measured live).
  env.ENABLE_TOOL_SEARCH ??= 'true';
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_SMALL_FAST_MODEL = fastModel;
  // CLAUDE_CODE_MAX_CONTEXT_TOKENS stays unset although Claude Code assumes 200k for unknown models: it makes Claude Code
  // add a "<total_tokens>" system message to every request (measured 2026-10-19), and compaction runs at 160k anyway.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  // DeepSeek ignores thinking budgets; effort is its only control, and 'high' (not its guide's 'max') keeps V4 Pro's billed reasoning in check.
  const launch = { provider, env, model, thinking: effort === 'flash' ? ({ type: 'disabled' } as const) : undefined, effort: effort === 'thinking' ? ('high' as const) : undefined };
  if (usesProvider(wanted, 'claude')) {
    // Claude helpers need Claude's credential: the session runs signed in behind the Claude proxy, which sends
    // every DeepSeek-model request (the main agent's included) to DeepSeek with its key and without the sign-in.
    const route = await deepseekRoute(creds);
    const proxied = route && (await proxyUrl('https://api.anthropic.com', 'claude'));
    if (route && proxied) {
      routeDeepSeekHelpers(route);
      env.ANTHROPIC_BASE_URL = proxied;
      env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel(wanted);
      env.DISABLE_TELEMETRY ??= '1';
      env.DISABLE_ERROR_REPORTING ??= '1';
      env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING ??= '1';
      // Flash's thinking is turned off by the proxy (toDeepSeek), not CLAUDE_CODE_EXTRA_BODY, which Claude helpers would get too.
      const apiKey = await creds.getAnthropicKey();
      if (apiKey) {
        keyedSession(env, apiKey);
      }
      return { ...launch, roster: wanted };
    }
  }
  env.ANTHROPIC_BASE_URL = await deepseekUrl();
  env.CLAUDE_CODE_SUBAGENT_MODEL = fastModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fastModel;
  if (effort === 'flash') {
    // DeepSeek thinks unless the request says otherwise, and Claude Code sends
    // no thinking field when thinking is off, so turn it off in the body.
    env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ thinking: { type: 'disabled' } });
  }

  // The claude.ai sign-in must never be sent to DeepSeek's server.
  keyedSession(env, key);
  return { ...launch, roster: soloRoster('deepseek') };
}

/** DeepSeek's endpoint for Claude Code: always through the proxy, which also reshapes requests DeepSeek can't parse (proxy/inlineTools.ts). */
async function deepseekUrl(): Promise<string> {
  const upstream = settings().get<string>('deepseek.baseUrl') || 'https://api.deepseek.com/anthropic';
  return (await proxyUrl(upstream, (settings().get<boolean>('clearOldToolResults') ?? true) ? 'mask' : 'fix')) ?? upstream;
}

/** Where a Claude chat's DeepSeek helpers go, or undefined without a DeepSeek key. */
export async function deepseekRoute(creds: Credentials): Promise<DeepSeekRoute | undefined> {
  const key = await creds.getDeepSeekKey();
  return key ? { url: await deepseekUrl(), key, fastModel: deepseekModel('flash'), mainModel: deepseekModel('thinking') } : undefined;
}

/**
 * A session authenticated by an API key only: it runs in the config folder
 * with no sign-in, using the key from ANTHROPIC_API_KEY.
 */
function keyedSession(env: Record<string, string | undefined>, key: string) {
  const dir = keylessConfigDir();
  approveKey(dir, key);
  env.CLAUDE_CONFIG_DIR = dir;
  env.ANTHROPIC_API_KEY = key;
}

/**
 * Claude Code only uses a key from ANTHROPIC_API_KEY once someone approves it
 * in its interactive prompt, which an extension never shows. It records that
 * approval in the config folder's .claude.json (the key's last 20 characters),
 * so record it there for our own folder. The Claude Code binary is bundled and
 * pinned with the extension, and the tests check this still works.
 */
function approveKey(dir: string, key: string) {
  const file = path.join(dir, '.claude.json');
  let config: any = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Unreadable (perhaps half-written by a CLI process): keep a copy before replacing it.
      fs.copyFileSync(file, `${file}.unreadable-${Date.now()}`);
    }
  }
  const responses = (config.customApiKeyResponses ??= {});
  const approved: string[] = (responses.approved ??= []);
  responses.rejected = (responses.rejected ?? []).filter((k: string) => k !== key.slice(-20));
  if (!approved.includes(key.slice(-20))) {
    approved.push(key.slice(-20));
    writeAtomic(file, JSON.stringify(config, null, 2));
    fs.chmodSync(file, 0o600);
  }
}

/** Claude Code's normal config folder, where the sign-in and conversations live. */
export function mainConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Where keylessConfigDir lives, without creating it. */
export function keylessConfigPath(): string {
  return process.env.DUAL_AGENT_CONFIG_DIR || path.join(os.homedir(), '.claude-dual-agent');
}

/**
 * A Claude Code config folder with no sign-in in it, for sessions that use an
 * API key (DeepSeek, or Claude on an Anthropic key). Claude Code keeps the
 * sign-in per config folder, so here it has none to send, and the key is the
 * only credential. Conversations are shared with the main folder, so switching
 * providers mid-chat keeps the conversation.
 *
 * (Claude Code's --bare mode also hides the sign-in, but it cuts the agent
 * down to three tools and a minimal prompt.)
 */
export function keylessConfigDir(): string {
  const dir = keylessConfigPath();
  const projects = path.join(dir, 'projects');
  const mainProjects = path.join(mainConfigDir(), 'projects');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(mainProjects, { recursive: true });
  linkInto(projects, mainProjects);
  // Your global instructions apply on every provider.
  const instructions = path.join(mainConfigDir(), 'CLAUDE.md');
  if (fs.existsSync(instructions)) {
    linkInto(path.join(dir, 'CLAUDE.md'), instructions);
  }
  return dir;
}

function linkInto(link: string, target: string) {
  if (process.platform === 'win32' && fs.statSync(target).isFile()) {
    // Junctions only link folders, and file symlinks need admin rights: keep a fresh copy.
    fs.copyFileSync(target, link);
    return;
  }
  try {
    if (fs.readlinkSync(link) === target) {
      return;
    }
    fs.unlinkSync(link);
  } catch {
    // Missing, or a real file/folder (left alone below).
  }
  if (!fs.existsSync(link)) {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined);
  }
}

/** Reads DEEPSEEK_API_KEY=... from a .env-style file (also works inside markdown code blocks). */
/** The key file's last read, by path. It is asked for several times per message and may sit on a sleeping drive. */
const keyFiles = new Map<string, { stamp: string; key?: string }>();

/** Re-read only when the file's modification time or size changes: one `stat` otherwise. */
function readKeyFile(file: string | undefined): string | undefined {
  if (!file) {
    return undefined;
  }
  let stamp: string;
  try {
    const s = fs.statSync(file);
    stamp = `${s.mtimeMs}:${s.size}`;
  } catch {
    keyFiles.delete(file);
    return undefined;
  }
  const cached = keyFiles.get(file);
  if (cached?.stamp === stamp) {
    return cached.key;
  }
  const key = readCredential(file, 'DEEPSEEK_API_KEY');
  keyFiles.set(file, { stamp, key });
  return key;
}

/** One NAME=value from a .env-style credentials file; empty values count as unset. */
export function readCredential(file: string | undefined, name: string): string | undefined {
  if (!file) {
    return undefined;
  }
  try {
    const match = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*['"]?([^'"\\s#]+)`, 'm'));
    return match?.[1] || undefined;
  } catch {
    return undefined;
  }
}

/** Optional search API keys, from the same credentials file as the DeepSeek key. */
export function searchKeys(): { brave?: string; tavily?: string } {
  const file = settings().get<string>('deepseek.apiKeyFile');
  return { brave: readCredential(file, 'BRAVE_API_KEY'), tavily: readCredential(file, 'TAVILY_API_KEY') };
}

/**
 * Whether a session gets Dual Agent's own web tools (web_search, web_read,
 * web_search_and_read) in place of Claude Code's built-in WebSearch/WebFetch.
 * "auto": Claude Code's own search, server-side on Claude and on DeepSeek alike, unless a Brave or
 * Tavily key is set; then DeepSeek uses ours. Without a key ours only scrapes DuckDuckGo and Brave's
 * pages, which block after a search or two (measured 2026-10-20).
 */
export function usesOwnWebTools(provider: ProviderId): boolean {
  const mode = settings().get<string>('webTools') ?? 'auto';
  if (mode !== 'auto') {
    return mode === 'dualAgent';
  }
  const keys = searchKeys();
  return provider === 'deepseek' && !!(keys.brave || keys.tavily);
}

/** The Claude Code binary that ships with the Agent SDK, used for sign-in. */
export function claudeBinary(): string {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const bin = path.join(path.dirname(pkg), exe);
    if (fs.existsSync(bin)) {
      return bin;
    }
  } catch {
    // Platform package missing; fall back to a globally installed CLI.
  }
  return exe;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  detail: string;
  email?: string;
}

/** A live check: 'expired' when Claude refused the sign-in, 'unknown' when it couldn't tell (offline, timeout). */
export interface ClaudeCheck { state: 'ok' | 'expired' | 'unknown'; detail: string }

/** What Claude Code says when the stored sign-in no longer works (revoked or expired token, signed out). */
const SIGN_IN_FAILED = /\b401\b|authenticat|oauth|revoked|\/login|not logged in|invalid api key/i;
/** An answer holds for 10 minutes across every chat; a failure is checked again after a minute. */
const CHECK_OK_MS = 10 * 60_000;
const CHECK_FAILED_MS = 60_000;
let lastCheck: { until: number; startedAt: number; result: Promise<ClaudeCheck> } | undefined;

/**
 * Whether Claude really answers: `claude auth status` only sees the stored
 * credentials, never a token revoked on Anthropic's side. Says "hi" to Haiku
 * with no tools, settings or saved session (~2 s, under 1k tokens). `force`
 * (after a sign-in) checks again, but chats asking at once share one check.
 */
export function checkClaude(creds: Credentials, force = false): Promise<ClaudeCheck> {
  const now = Date.now();
  if (lastCheck && (now < lastCheck.until || (force && now - lastCheck.startedAt < 5_000))) {
    return lastCheck.result;
  }
  const check = { until: Infinity, startedAt: now, result: runClaudeCheck(creds) };
  lastCheck = check;
  void check.result.then((r) => (check.until = Date.now() + (r.state === 'ok' ? CHECK_OK_MS : CHECK_FAILED_MS)));
  return check.result;
}

async function runClaudeCheck(creds: Credentials): Promise<ClaudeCheck> {
  const { env } = await buildLaunch('claude', 'flash', creds);
  const args = ['-p', 'hi', '--model', 'haiku', '--system-prompt', 'Reply with OK.', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json'];
  return new Promise((resolve) => {
    execFile(claudeBinary(), args, { env: env as NodeJS.ProcessEnv, cwd: os.tmpdir(), timeout: 30_000 }, (err, stdout) => {
      let out: { is_error?: boolean; result?: string } = {};
      try {
        out = JSON.parse(stdout);
      } catch {
        // No JSON: the process failed before answering.
      }
      const detail = String(out.result ?? err?.message ?? 'no answer').slice(0, 300);
      resolve({ state: out.is_error === false ? 'ok' : SIGN_IN_FAILED.test(detail) ? 'expired' : 'unknown', detail });
    });
  });
}

export function claudeAuthStatus(): Promise<ClaudeAuthStatus> {
  return new Promise((resolve) => {
    execFile(claudeBinary(), ['auth', 'status'], { timeout: 15000 }, (err, stdout) => {
      try {
        const status = JSON.parse(stdout);
        resolve({
          loggedIn: !!status.loggedIn,
          detail: status.loggedIn ? `${status.authMethod ?? 'signed in'}${status.email ? ` (${status.email})` : ''}` : 'not signed in',
          email: status.loggedIn ? status.email : undefined,
        });
      } catch {
        resolve({ loggedIn: false, detail: err ? `could not check sign-in: ${err.message}` : 'not signed in' });
      }
    });
  });
}

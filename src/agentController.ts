/**
 * One chat's agent: runs Claude Code through the Agent SDK on Claude or
 * DeepSeek, streams its replies to the chat page, and recovers from failures
 * by retrying fresh or switching providers.
 *
 * Flow: extension.ts activates → ChatSession (chatView.ts) owns a page and an
 * AgentController → send() starts a turn → ensureQuery() starts or reuses a
 * Claude Code process → pump() feeds its messages to handle() → finishTurn().
 * The cards that wait for the user live in agent/interactions.ts, the failure
 * policy in agent/failover.ts, usage accounting in agent/chatUsage.ts.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CanUseTool, HookInput, HookJSONOutput, Query, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { ContentBlock, attachmentBlocks, editorContext, editorInfo, markSeen } from './context';
import { AgentInfo, AgentTracker, AgentsSnapshot, SPAWN_TOOLS } from './agents';
import { SourceList } from './web/sources';
import { EditInput, checkEdit } from './code/editCheck';
import { errorSnapshot, newErrors } from './code/lsp';
import { ApiUsage, UsageLedger, inputTokens, providerOfModel, repoKey } from './usage';
import type { QuestionAnswers } from './questions';
import type { PermissionDecision, SendRequest, StintState, ToWebview, Usage, UsageScope } from './protocol';
import { errorMessage, formatTokens, short } from './text';
import { DiagInput, DiagRow, diag, onDiag, recentDiag, swallowed } from './diag/log';
import { editorFile, likelyRelevant } from './context';
import { withRelevant } from './code/retrieve';
import { bareTool, diagnosisOf, resolved } from './diag/rules';
import { diagnosePrompt } from './diag/report';
import type { AdvisorCall } from './agent/advisor';
import { withTimeout } from './async';
import { AsyncQueue } from './agent/asyncQueue';
import { ChatUsage } from './agent/chatUsage';
import { LimitStatus, cappedKeys, limitStatus, nearing, totalReached, usd } from './costLimits';
import { ANSWER_PROMPT, CONTINUE_PROMPT, MAX_RETRIES, RETRY_DELAYS_MS, RETRY_PROMPT, canRetry, describeError, errorCode, hint, pauseUntil, recover, statusIn, stopRetrying } from './agent/failover';
import { EDIT_TOOLS, Interactions } from './agent/interactions';
import { describeToolInput, resultErrorText, summarize } from './agent/present';
import { displayName, noteClaudeModels } from './models';
import { ModelChoice, Quota, RouterDecision, Split, TaskSignals, claudeQuotaOk, currentStint, earlyEscalation, helperRoster, label, levelOf, nameDeepSeekModels, route, startsTask } from './agent/router';
import { BUILD_COMMAND, Evidence, TEST_COMMAND, failureIn, isCheckCommand, checkReport, gitChangedAcross, mergeEvidence, newEvidence, recordTool, resetEvidence, sendBackReason } from './agent/verify';
import { LoopGuard, fileDumpReason, signature } from './agent/loops';
import { MAX_REPORT_CHARS, Scope, inferScope, isReadOnlyCommand, missingScopeReason, parseScope, repoRootOf, scopeFooter, scopeViolationAsync, shellWrites } from './agent/scope';
import { pruneSpill, trimToolOutput } from './agent/trim';
import { AutoCheckConfig, runAutoChecks, sendBackText, unverifiedNotice } from './agent/autoCheck';
import { workFolder } from './memory/files';
import { createHash } from 'crypto';
import { TurnLog, TurnMeter, TurnMetrics, inputSide } from './metrics/turns';
import type { CallLog } from './metrics/calls';
import { HelperLog, HelperOutcome, HelperTracker } from './metrics/helpers';
import { TaskEnd, TaskLog, TaskMeter } from './metrics/tasks';
import { commandCore, confirmNotes, helperBrief, loadProjectConventions, memoryPrimer, notesForFile, pruneNotes, recordCommand, saveHandoff } from './memory/memory';
import { REUSE_IMPORT_TOOL, ReuseSession } from './reuse/session';
import {
  Credentials,
  Effort,
  Mode,
  PROVIDER_LABELS,
  PermissionMode,
  ProviderId,
  BASH_OUTPUT_CHARS,
  buildLaunch,
  checkClaude,
  claudeAuthStatus,
  compactWindow,
  autoPrimary,
  buildMode,
  claudeAllowed,
  configuredLimits,
  tokenSplit,
  efficiency,
  effortFor,
  effortSetting,
  githubToken,
  helperAgents,
  deepseekHelpersAllowed,
  claudeHelpersAllowed,
  HelperRoster,
  keylessConfigPath,
  mainConfigDir,
  deepseekModel,
  modelFor,
  otherProvider,
  settings,
} from './providers';

export type { ProviderState, SendRequest, ToWebview, Usage, UsageScope, PermissionDecision } from './protocol';

type UserContent = string | ContentBlock[];

/** How often a signed-out user's sign-in is rechecked when they send a message. */
/** The sign-in card's option. */
const SIGN_IN = 'Sign in';
const AUTH_RECHECK_MS = 30_000;
/** How long a message waits for a sign-in check still running. */
const STATUS_WAIT_MS = 3_000;
/** A process started ahead of the next message and unused this long is closed. */
const SPARE_IDLE_MS = 10 * 60_000;
/** Streamed text is sent to the chat in batches this often, not per token. */
const DELTA_FLUSH_MS = 30;

/** Saved tool outputs older than this are deleted when a session first saves one. */
const SPILL_MAX_AGE_MS = 7 * 86_400_000;

/** After Stop is accepted, how long to wait for the turn's result before closing the process. */
const STOP_GRACE_MS = 10_000;

/** Silence from the model this long (outside a tool or card) is reported as a possible stall. */
const STALL_MS = 90_000;
const LIVE_TICK_MS = 3_000;
/** The supervisor checks every helper this often while any work runs (no model calls, no tokens). */
const SUPERVISE_MS = 120_000;
/** A background helper Claude Code stopped listing this long ago, with no report, crashed. */
const LOST_MS = 60_000;
/** A helper silent this long is reported in the chat (the pill warns after STALL_MS). */
const HELPER_STUCK_MS = 5 * 60_000;

/** Escalating with more context than this starts the stronger model fresh with a handoff: switching up re-reads everything uncached. */
const LEAN_ESCALATION_TOKENS = 100_000;
/** Reads of files longer than this without a range get a hint to outline first (Agentless: skeletons were cheaper and more accurate). */
const LONG_FILE_LINES = 400;
/** Notes about a file are added to reads of files at least this big (~2k tokens): below it a note costs about what it saves. */
const RECALL_MIN_BYTES = 8 * 1024;
const NOTES_ADD = 'mcp__code__notes_add';
/** The pending mark of notes written after web or tool content; only a person confirms them. */
const UNTRUSTED = 'untrusted';
/** Content from outside the repo: web pages, downloaded repos, other MCP servers (a browser, a database). */
const isExternalTool = (tool: string) => tool === 'WebFetch' || tool === 'WebSearch' || (tool.startsWith('mcp__') && !/^mcp__(code|advisor)__/.test(tool));
/** A build still "running" after this long is assumed lost (a killed process): it no longer holds the repo. */
const BUILD_HOLD_MS = 15 * 60_000;
/** A tool result this big (~5k tokens) is logged: it stays in context and is re-read on every later call. */
const BIG_OUTPUT_CHARS = 20_000;
/** An image's share of context, in characters: ~1.5k tokens. */
const IMAGE_CHARS = 6_000;

/** The characters a tool result puts in front of the model: its text, plus a fixed share per image. */
function resultChars(content: unknown): number {
  if (typeof content === 'string') {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.reduce((n: number, b: { type?: string; text?: unknown }) => n + (b?.type === 'text' && typeof b.text === 'string' ? b.text.length : b?.type === 'image' ? IMAGE_CHARS : 0), 0);
}

/** dualAgent.projectMemory: off, agents get no primer, brief or file notes (to compare with and without). */
const memoryOn = () => settings().get<boolean>('projectMemory') ?? true;

/** dualAgent.autoCheck (and its timeouts): what runs at the main agent's Stop after edits. */
function autoCheckConfig(): AutoCheckConfig {
  const cfg = settings();
  const mode = cfg.get<string>('autoCheck');
  const secs = (key: string, fallback: number) => {
    const n = cfg.get<number>(key);
    return (typeof n === 'number' && n > 0 ? n : fallback) * 1000;
  };
  return {
    mode: mode === 'off' || mode === 'all' ? mode : 'typecheck',
    timeoutMs: secs('autoCheckTimeoutSeconds', 60),
    testTimeoutMs: secs('autoCheckTestTimeoutSeconds', 180),
  };
}

/** Seconds the main Stop hook needs: the report check plus every check it may run. */
function stopTimeoutSec(): number | undefined {
  const { mode, timeoutMs, testTimeoutMs } = autoCheckConfig();
  return mode === 'off' ? undefined : Math.ceil((15_000 + 2 * timeoutMs + (mode === 'all' ? testTimeoutMs : 0)) / 1000);
}
const MAIN = 'main';
/** The pending mark of a note whose author couldn't be told: no report ever confirms it. */
const UNKNOWN_AGENT = 'unknown';
const THINKING_ONLY_PROMPT = 'Your last reply had only thinking and no answer. Answer now, briefly.';

const CALM: TaskSignals = { failedChecks: 0, toolErrors: 0, editFailures: 0, turnsOnTask: 0 };

/** How long each subscription window lasts, to pace Claude use across it. */
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000, seven_day_opus: 7 * 86400_000, seven_day_sonnet: 7 * 86400_000 };

interface Turn {
  prompt: UserContent;
  provider: ProviderId;
  effort: Effort;
  producedOutput: boolean;
  fallbackUsed: boolean;
  freshRetryUsed: boolean;
  resumedAcross: boolean;
  interrupted: boolean;
  /** finishTurn has run, so a second call (e.g. a late result after a stop) does nothing. */
  settled?: boolean;
  /** Started by Claude Code itself (e.g. to report a background helper's result), not by a message. */
  implicit?: boolean;
  /** Its prompt is in the running session, so further messages can join it. */
  begun?: boolean;
  /** An answer or an API error came back, so the prompt is in the transcript and a retry needn't resend it. */
  reachedModel?: boolean;
  /** The user's message when this turn retries or continues it, for a fresh restart. */
  original?: UserContent;
  /** Auto moved it to a stronger model mid-turn. */
  escalated?: boolean;
  /** The text the reply streamed, for a handoff if a stronger model takes over. */
  replyText?: string;
  /** The "N steps left" reminder was sent. */
  budgetWarned?: boolean;
  /** Already re-asked once after a reply with thinking and no answer. */
  thinkingRetried?: boolean;
  /** The report check flagged it. */
  unverified?: boolean;
  /** Failing-check sets already sent back this turn (autoCheck.ts caps them). */
  checkSends?: string[];
  /** An automatic turn: the helper whose report started it. */
  wokenBy?: string;
  /** Messages the user sent into it while it ran, re-sent if it fails. */
  steered?: SendRequest[];
  /** The process input the steered messages went into: while it lives they're still queued there. */
  steerInput?: AsyncQueue<SDKUserMessage>;
  /** Retries already made on this provider for this message. */
  retries?: number;
  /** Main-agent calls refused as loops in this turn. */
  loopDenials?: number;
  error?: string;
  errorText?: string;
  resetsAt?: number;
}

const newTurn = (prompt: UserContent, provider: ProviderId, effort: Effort, fallbackUsed = false): Turn => ({
  prompt,
  provider,
  effort,
  producedOutput: false,
  fallbackUsed,
  freshRetryUsed: false,
  resumedAcross: false,
  interrupted: false,
});

export class AgentController implements vscode.Disposable {
  /** The wait before each retry of a failed reply (tests shorten them). */
  retryDelays: readonly number[] = RETRY_DELAYS_MS;
  /** The stored sign-in, the live check that Claude answers, and the sign-in flow (tests replace them). */
  authStatus = claudeAuthStatus;
  claudeCheck = (force?: boolean) => checkClaude(this.creds, force);
  signIn = async () => {
    await vscode.commands.executeCommand('dualAgent.signInClaude');
  };
  /** Ends a wait for the sign-in when the user presses Stop. */
  private stopWait?: () => void;
  /** The chat already offered a sign-in for an expired one. */
  private signInOffered = false;
  private query?: Query;
  private input?: AsyncQueue<SDKUserMessage>;
  private activeProvider?: ProviderId;
  private activeEffort?: Effort;
  /** The model of the last turn, kept after the process closes: the router weighs switching away from it. */
  private lastChoice?: ModelChoice;
  private readonly post: (msg: ToWebview) => void;
  private readonly postRaw: (msg: ToWebview) => void;
  /** Streamed text not yet sent to the chat, and the timer that sends it. */
  private deltaText = '';
  private deltaTimer?: NodeJS.Timeout;
  /** The last agents snapshot sent, to skip unchanged ones. */
  private agentsSent?: string;
  /** A process started ahead of the next message that no reply has used yet (prewarm). */
  private spare?: { cwd: string; timer: NodeJS.Timeout };
  /** A prewarm in progress, so triggers close together start one process. */
  private warming?: Promise<void>;
  /** Why auto mode picked the current reply's model, for its turn row. */
  private routeReason?: string;
  /** The agent process just started, logged with its session once that is known. */
  private launchRow?: DiagInput;
  /** How the turns on the current task went, for escalating in auto mode. */
  private signals: TaskSignals = CALM;
  /** Latest Claude subscription limits, for pacing. */
  private quota?: Quota;
  /** Context size and time of the main agent's last model call (cache warmth). */
  private contextTokens = 0;
  private lastCallAt = 0;
  /** Files the agents changed in this conversation (the code map ranks them first; handoffs list them). */
  private editedFiles = new Set<string>();
  /** The user's recent messages, for the code map's focus and for handoffs. */
  private recentPrompts: string[] = [];
  /** The last finished reply's text, for handoffs. */
  private lastReply = '';
  /** Long files already hinted about. */
  private outlinedHints = new Set<string>();
  /** The usual steps per finished reply, from this machine's history. */
  private stepBudget?: number;
  /** Replies finished by the running process, to tell a cache miss from a first request. */
  private turnsThisProcess = 0;
  /** The day the 80% budget warning was shown, so it shows once a day. */
  private budgetWarnedDay?: string;
  /** Each file's errors before an edit to it, so the edit's own errors can be reported after it. */
  private errorsBefore = new Map<string, Set<string> | undefined>();
  /** Cost limits already warned about at 80%, so each warns once per approach. */
  private limitWarned = new Set<string>();
  /** The turn a reached cost limit stopped, so it stops once. */
  private limitStopped?: object;
  /** Where long tool outputs are saved (the workspace's .dual-agent/outputs). */
  private spillDir?: string;
  private spillFailed = false;
  /** Declared scopes of helper briefs, by the spawning Agent call's id, then by the helper's agent id (= its task id). */
  private briefScopes = new Map<string, Scope>();
  private agentScopes = new Map<string, Scope>();
  /** notes_add calls by tool_use id: the agent that made each (MAIN or a helper's id), seen by the guard first. */
  private noteCalls = new Map<string, string>();
  /** Files whose notes an agent was already shown, as "agent|file". */
  private shownNotes = new Set<string>();
  /** Agents (MAIN or a helper's id) that read web or tool content in this conversation: their notes are held back. */
  private untrusted = new Set<string>();
  /** The chat was told once that a note was held back. */
  private heldNoted = false;
  /** This chat's helpers while they run: each gets a row (metrics/helpers.ts) when it ends. */
  private helpers = new HelperTracker();
  /** Helper spend by the turn that spawned it, added to that turn's task (a helper ending later isn't counted). */
  private helperSpend = new Map<string, number>();
  /** The turns of the task in progress, closed into a row by closeTask (metrics/tasks.ts). */
  private taskMeter = new TaskMeter();
  /** Tool calls waiting for their result, by tool_use id: what the result's size is charged to. */
  private toolCalls = new Map<string, { name: string; target?: string; helper?: string }>();
  /** A compaction seen by its hook, logged with the context it left once the next main call shows it. */
  private compacted?: { before: number; summaryChars: number; trigger: string };
  /** The build or test run going on in each repo, so a second one waits instead of fighting it over locks and caches. */
  private builds = new Map<string, { agent: string; id: string; command: string; at: number }>();
  /** Refuses repeated identical calls and retries of calls that keep failing, per agent. */
  private readonly loops = new LoopGuard();
  /** What the main agent's first steps found, for routing on evidence rather than the prompt's words. */
  private firstSteps = { reads: 0, searches: 0, repeatedSearches: 0, seen: new Set<string>() };
  /** The main agent's failed tool calls this turn, by tool (helpers' don't count toward escalating). */
  private mainFailures: Record<string, number> = {};
  /** What each agent did since its last report ('main' or a helper's agent id), to check its claims. */
  private evidence = new Map<string, Evidence>();
  /** When the running process was asked to start, until it answers. */
  private launchStartedAt = 0;
  /** Stops listening to the failure log (network trouble seen by the proxy). */
  private readonly offDiag: () => void;
  private networkNoticeAt = 0;
  /** When each provider's requests last failed on the network (the proxy's synthetic 529s). */
  private netFailAt: Partial<Record<ProviderId, number>> = {};
  /** The helper that last reported back, to say why the chat starts working on its own. */
  private lastReported?: { name: string; status: string; at: number; helper?: string };
  /** The API message id each stream ('main' or a helper's tool use id) is on, to give its call the final output count. */
  private streamIds = new Map<string, string>();
  /** Repos other than the workspace that agents worked in this chat: the report check reads their git status too. */
  private workedRepos = new Set<string>();
  /** Messages sent while the agent was starting or switching, sent once the reply ends. */
  private pending: SendRequest[] = [];
  private sessionId?: string;
  /** Providers that have contributed turns to the current conversation. */
  private historyProviders = new Set<ProviderId>();
  private turn?: Turn;
  /** A send is between its first check and its turn starting. */
  private sending = false;
  /** Bumped by New Chat, so a send still choosing its model knows the chat it was for is gone. */
  private conversationGeneration = 0;
  /** The chat panel closed: nothing may start another agent process. */
  private disposed = false;
  private blockedUntil: Record<ProviderId, number> = { claude: 0, deepseek: 0 };
  private claudeSignedIn = false;
  private claudeUsesApiKey = false;
  private claudeStatus = 'checking…';
  private claudeAccount?: string;
  private deepseekReady = false;
  private deepseekStatus = 'checking…';
  private statusChecked = false;
  private statusCheckedAt = 0;
  /** The sign-in check in flight (or the last one), so a message sent meanwhile can wait for it. */
  private statusCheck?: Promise<void>;
  /** Provider and effort the running agent process was started with. */
  private launchKey?: string;
  /** Provider and effort of the last turn, kept after the process closes. */
  private lastLaunchKey?: string;
  /** Bumped whenever the process is closed, so a launch still starting knows it is stale. */
  private launchGeneration = 0;
  /** This chat's permission mode when it differs from the setting (approving a plan leaves plan mode here only). */
  private permissionOverride?: PermissionMode;
  /** Duplicates the edit check already raised in this chat. */
  private reportedDuplicates = new Set<string>();
  /** Callers of `whenIdle`, released when the current reply ends. */
  private idleWaiters: (() => void)[] = [];
  private nextProvider: ProviderId = 'claude';
  /** The split's stint as of the last routing decision, for the chat. */
  private stint?: StintState;
  private nextEffort?: Effort;
  /** Hashes of editor files whose contents this conversation has already seen. */
  private seenFiles = new Map<string, string>();
  private sawThinking = false;
  /** Models of the helper agents the running session can start, by agent name. */
  private helperModels: Record<string, string> = {};
  /** Who the running process's helpers were asked to run on, and who they run on. */
  private helpersAsked?: string;
  private roster?: HelperRoster;
  private readonly tracker = new AgentTracker(describeToolInput, (name) => this.helperModels[name]);
  private agentsTimer?: NodeJS.Timeout;
  private superviseTimer?: NodeJS.Timeout;
  /** What the main agent is doing and since when, for the live status line. */
  private activity = { what: 'Starting', since: 0, inTool: false };
  private lastEventAt = 0;
  private liveTimer?: NodeJS.Timeout;
  private stallReported = false;
  /** Web sources numbered for citing, per conversation. */
  private readonly sources = new SourceList();
  private readonly usage: ChatUsage;
  private readonly cards: Interactions;
  private readonly meter = new TurnMeter();
  /** This chat's downloaded repositories (reuse and hybrid modes). */
  private readonly reuse = new ReuseSession(
    () => this.resolveCwd(),
    githubToken,
    () => this.permissionMode !== 'bypassPermissions',
    async (query, count) => (await import('./agent/options.js')).webSearch(query, count),
  );

  constructor(
    private readonly creds: Credentials,
    private readonly log: vscode.OutputChannel,
    post: (msg: ToWebview) => void,
    private readonly onStateChange: () => void,
    /** The codebase this chat works in. */
    readonly resolveCwd: () => string = defaultCwd,
    /** Where every model's token usage is recorded (shared by all chats). */
    ledger?: UsageLedger,
    /** Where every turn's efficiency metrics are recorded (shared by all chats). */
    turnLog?: TurnLog,
    /** Where every model call's tokens are recorded by agent (shared by all chats). */
    callLog?: CallLog,
    /** Where every helper launch's summary is recorded (shared by all chats). */
    helperLog?: HelperLog,
    /** Where every finished task's cost is recorded (shared by all chats). */
    private readonly taskLog?: TaskLog,
  ) {
    this.postRaw = post;
    // Every warning or error the chat shows is also kept in the failure log, with its time, chat and reply.
    this.post = (msg) => {
      // Batched text goes out first, so the chat sees everything in order.
      this.flushDelta();
      if (msg.type === 'notice' && msg.level !== 'info') {
        this.report({ kind: 'notice', level: msg.level, detail: msg.text });
      }
      post(msg);
    };
    // Until the first status check, the next provider is the one the settings point to.
    this.nextProvider = this.mode === 'auto' ? autoPrimary() : this.mode;
    this.usage = new ChatUsage(
      this.post,
      resolveCwd,
      ledger,
      (text) => {
        log.appendLine(text);
        post({ type: 'notice', level: 'warn', text });
      },
      turnLog,
      callLog,
      helperLog,
      taskLog,
    );
    this.offDiag = onDiag((row) => this.watchNetwork(row));
    this.cards = new Interactions(
      this.post,
      (line) => log.appendLine(line),
      () => [path.join(mainConfigDir(), 'plans'), path.join(keylessConfigPath(), 'plans')],
      () => void this.leavePlanMode(),
      (tool, input) => (tool === REUSE_IMPORT_TOOL ? this.reuse.describeImport(input) : undefined),
    );
  }

  get mode(): Mode {
    return settings().get<Mode>('mode') ?? 'auto';
  }

  get active(): ProviderId | undefined {
    return this.activeProvider;
  }

  /** The effort of the model the next message goes to. */
  get effort(): Effort {
    return this.displayedNext().effort;
  }

  private displayedNext(): ModelChoice {
    if (this.activeProvider && this.activeEffort && this.mode === 'auto') {
      return { provider: this.activeProvider, effort: this.activeEffort };
    }
    return { provider: this.nextProvider, effort: this.nextEffort ?? effortFor(this.nextProvider) };
  }

  get permissionMode(): PermissionMode {
    return this.permissionOverride ?? settings().get<PermissionMode>('permissionMode') ?? 'default';
  }

  get busy(): boolean {
    return !!this.turn || this.sending;
  }

  /** The Claude Code session behind this chat, saved so a reopened chat resumes it. */
  get conversationId(): string | undefined {
    return this.sessionId;
  }

  /** `recheck`: just signed in, so check Claude again instead of trusting the last check. */
  refreshStatus(recheck = false): Promise<void> {
    const check = this.checkStatus(recheck);
    this.statusCheck = check.catch(() => undefined);
    return check;
  }

  private async checkStatus(recheck: boolean) {
    const wasReady = this.statusChecked && (this.claudeSignedIn || this.claudeUsesApiKey);
    const [auth, anthropicKey, deepseekKey, deepseekStatus] = await Promise.all([this.authStatus(), this.creds.getAnthropicKey(), this.creds.getDeepSeekKey(), this.creds.deepSeekKeySource()]);
    const hasAnthropicKey = !!anthropicKey;
    // A sign-in revoked on Anthropic's side still looks signed in to auth status: check Claude answers.
    const check = auth.loggedIn && !hasAnthropicKey && this.mode !== 'deepseek' && claudeAllowed() ? await this.claudeCheck(recheck) : undefined;
    const expired = check?.state === 'expired';
    this.claudeSignedIn = auth.loggedIn && !expired;
    this.claudeUsesApiKey = hasAnthropicKey;
    this.claudeStatus = hasAnthropicKey ? 'API key set' : expired ? 'Sign-in expired' : auth.loggedIn ? 'Signed in' : 'Not signed in';
    this.claudeAccount = hasAnthropicKey ? undefined : auth.email;
    this.deepseekReady = !!deepseekKey;
    this.deepseekStatus = deepseekStatus;
    if (this.statusChecked && !wasReady && (this.claudeSignedIn || hasAnthropicKey)) {
      this.post({ type: 'hello', text: auth.email ? `Hello! You're signed in to Claude as ${auth.email}.` : `Hello! Claude is ready.` });
    }
    this.statusChecked = true;
    this.statusCheckedAt = Date.now();
    await this.updateNextProvider();
    if (expired && !this.signInOffered && !this.turn) {
      this.signInOffered = true;
      void this.offerSignIn(check!.detail).catch((err) => swallowed('Offering the sign-in', err));
    }
  }

  /** The stored sign-in is refused: offer a new one; auto mode uses DeepSeek meanwhile. */
  private async offerSignIn(detail: string) {
    const pick = await this.cards.choose(`Claude's sign-in has expired (${short(detail, 90)}). Sign in again?`, 'Claude', [
      { label: SIGN_IN, description: 'Opens the Claude sign-in in a terminal.' },
      { label: 'Not now', description: 'Auto mode uses DeepSeek until you sign in.' },
    ]);
    if (pick === SIGN_IN) {
      await this.signInAndCheck();
    }
  }

  /** Opens the sign-in and waits until it's done (or Stop); true when Claude answers afterwards. */
  private async signInAndCheck(): Promise<boolean> {
    await Promise.race([this.signIn().catch((err) => swallowed('Sign-in', err)), new Promise<void>((resolve) => (this.stopWait = resolve))]);
    this.stopWait = undefined;
    await this.refreshStatus(true);
    this.signInOffered = false;
    return this.claudeSignedIn;
  }

  emitState() {
    const { provider: next, effort } = this.displayedNext();
    const availability = (provider: ProviderId, status: string) => {
      const until = this.blockedUntil[provider];
      const resumes = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return until > Date.now() ? `${status}, paused until ${resumes}` : status;
    };
    this.post({
      type: 'state',
      mode: this.mode,
      effort,
      permissionMode: this.permissionMode,
      buildMode: buildMode(),
      split: tokenSplit() ?? null,
      stint: this.mode === 'auto' ? this.stint : undefined,
      cwd: this.resolveCwd(),
      theme: settings().get<string>('theme') ?? 'graphite',
      active: this.activeProvider,
      next,
      model: modelFor(next, effort),
      busy: this.busy,
      claude: {
        ready: this.claudeSignedIn || this.claudeUsesApiKey,
        detail: availability('claude', this.statusChecked ? this.claudeStatus : 'Checking…'),
        account: this.claudeAccount,
      },
      deepseek: {
        ready: this.deepseekReady,
        detail: availability('deepseek', this.statusChecked ? this.deepseekStatus : 'Checking…'),
      },
      editor: editorInfo(),
    });
    this.onStateChange();
  }

  /** Recomputes which model the next message goes to, then tells the chat. */
  async updateNextProvider() {
    const next = await this.pickModel();
    this.nextProvider = next.provider;
    this.nextEffort = next.effort;
    this.emitState();
    if (this.spare && this.launchKey !== `${next.provider}/${next.effort}`) {
      // The spare was started for another model: start the right one instead.
      void this.prewarm();
    }
  }

  async send(req: SendRequest) {
    if (this.busy) {
      this.steer(req);
      return;
    }
    if (this.overBudget() || this.overCostLimit()) {
      if (this.pending.length) {
        this.post({ type: 'notice', level: 'warn', text: `${this.pending.length} queued message${this.pending.length === 1 ? ' was' : 's were'} not sent.` });
        this.pending = [];
      }
      return;
    }
    this.sending = true;
    const generation = this.conversationGeneration;
    try {
      this.post({ type: 'user', text: req.display ?? req.text, attachments: req.attachments, editor: req.includeEditor ? editorInfo() : undefined });
      // Sent while the chat opens: wait briefly for the sign-in check, or it routes as if Claude were unavailable.
      if (this.statusCheck) {
        await withTimeout(this.statusCheck, STATUS_WAIT_MS, 'The sign-in check').catch(() => undefined);
      }
      if (!this.claudeSignedIn && !this.claudeUsesApiKey && this.mode !== 'deepseek' && claudeAllowed() && Date.now() - this.statusCheckedAt > AUTH_RECHECK_MS) {
        // The user may have signed in from a terminal since the last check; checking takes up to 15 s, so it doesn't hold up this message.
        this.statusCheckedAt = Date.now();
        void this.refreshStatus().catch((err) => swallowed('Checking the Claude sign-in', err));
      }
      this.cards.startTurn();
      this.meter.start();
      const next = await this.withinModelLimits(await this.pickModel(req.text));
      if (!next || generation !== this.conversationGeneration || this.disposed) {
        // New Chat (or a closed panel) while choosing: this message belonged to the old chat.
        return;
      }
      // The same test the router makes for its model choice (router.ts ladder), so a new task closes the last one.
      if (this.startsNewTask(req.text)) {
        this.closeTask('new_task');
      }
      const lean =
        this.mode === 'auto' && next.switching && !!this.lastChoice && levelOf(next) > levelOf(this.lastChoice) &&
        this.contextTokens > LEAN_ESCALATION_TOKENS && settings().get<boolean>('leanEscalation') !== false;
      // Why each message went where it did, for diagnosing switches later (also on the turn row).
      this.routeReason = this.mode === 'auto' ? `${next.reason}${next.switching ? ' (switching)' : ''}` : undefined;
      if (this.routeReason) {
        this.log.appendLine(`Auto: ${this.routeReason}`);
      }
      if (next.switching && this.mode === 'auto') {
        const fresh = lean ? ` Starting it fresh with a handoff instead of re-reading ${Math.round(this.contextTokens / 1000)}k tokens of history.` : '';
        this.post({ type: 'notice', level: 'info', text: `Auto: ${next.reason}.${fresh}` });
      }
      this.stepBudget = this.usage.stepBudget();
      // A new message may follow a fix outside the chat ("run the tests again"): earlier failures don't count against it.
      this.loops.forget('main');
      this.notePrompt(req.text);
      const prompt = this.buildPrompt(req);
      const relevant = await this.relevantContext(req.text, req.includeEditor);
      const full = relevant ? withRelevant(prompt, relevant) : prompt;
      await this.startTurn(newTurn(lean ? this.withHandoff(full) : full, next.provider, next.effort), lean);
    } catch (err) {
      swallowed('Sending', err);
      this.post({ type: 'notice', level: 'error', text: `The message couldn't be sent: ${errorMessage(err)}` });
    } finally {
      this.sending = false;
      this.emitState();
    }
  }

  /**
   * A message while the agent works goes into the running session: by default
   * it steers the current task (read between tool calls); `queue` waits for
   * its own turn. While starting or switching it waits for the reply to end.
   */
  private steer(req: SendRequest) {
    if (!this.input || !this.turn?.begun || this.turn.settled || this.turn.interrupted) {
      this.pending.push(req);
      this.post({ type: 'notice', level: 'info', text: 'Queued: it goes out when the current reply ends.' });
      return;
    }
    this.post({ type: 'user', text: req.display ?? req.text, attachments: req.attachments, editor: req.includeEditor ? editorInfo() : undefined });
    this.notePrompt(req.text);
    (this.turn.steered ??= []).push({ ...req, display: undefined });
    this.turn.steerInput = this.input;
    this.input.push({
      type: 'user',
      message: { role: 'user', content: this.buildPrompt(req) },
      parent_tool_use_id: null,
      priority: req.queue ? 'later' : 'next',
    } as SDKUserMessage);
    if (req.queue) {
      this.post({ type: 'notice', level: 'info', text: 'Queued after the current task.' });
    }
  }

  /**
   * The daily spend cap (dualAgent.dailyBudgetUsd): a warning at 80%, and no
   * new replies once it's reached, so many sessions can't run up a bill.
   */
  private overBudget(): boolean {
    const budget = settings().get<number>('dailyBudgetUsd') ?? 0;
    if (budget <= 0) {
      return false;
    }
    const spent = this.usage.spentToday();
    if (spent >= budget) {
      this.post({ type: 'notice', level: 'error', text: `Today's spend ($${spent.toFixed(2)}) has reached your daily budget of $${budget.toFixed(2)} (dualAgent.dailyBudgetUsd). Raise it to keep going.` });
      return true;
    }
    const today = new Date().toDateString();
    if (spent >= budget * 0.8 && this.budgetWarnedDay !== today) {
      this.budgetWarnedDay = today;
      this.post({ type: 'notice', level: 'warn', text: `Today's spend is $${spent.toFixed(2)}, ${Math.round((spent / budget) * 100)}% of your daily budget.` });
    }
    return false;
  }

  /** The cost limits' state, or undefined while none is set (the default). */
  private limitState(fresh = false): LimitStatus | undefined {
    const limits = configuredLimits();
    return limits && limitStatus(this.usage.limitSpend(fresh), limits);
  }

  /** A warning the first time each limit passes 80%. */
  private warnNearing(status: LimitStatus) {
    const near = nearing(status);
    const fresh = near.filter((n) => !this.limitWarned.has(n.key));
    this.limitWarned = new Set(near.map((n) => n.key));
    if (fresh.length) {
      this.post({ type: 'notice', level: 'warn', text: `Nearing a cost limit: ${fresh.map((n) => n.text).join('; ')}.` });
    }
  }

  /** The total cost limit is reached: no new replies until a reset. */
  private overCostLimit(): boolean {
    const status = this.limitState(true);
    if (!status) {
      return false;
    }
    if (totalReached(status)) {
      this.post({ type: 'notice', level: 'error', text: `Spend since the last reset (${usd(status.total!.spent)}) has reached your cost limit of ${usd(status.total!.limit)} (dualAgent.costLimitUsd). Run "Dual Agent: Reset Cost Limits" or raise it to keep going.` });
      return true;
    }
    this.warnNearing(status);
    return false;
  }

  /**
   * The model choice with every model over its limit avoided: the provider's
   * other effort, then (in auto) the other provider. DeepSeek's helpers run on
   * its fast model, so that model must be under its limit too. Undefined when
   * nothing is left; the chat is told either way.
   */
  private async withinModelLimits(next: RouterDecision): Promise<RouterDecision | undefined> {
    const status = this.limitState();
    if (!status?.models.length) {
      return next;
    }
    const capped = (c: ModelChoice) => [...new Set([...cappedKeys(status, modelFor(c.provider, c.effort)), ...(c.provider === 'deepseek' ? cappedKeys(status, deepseekModel('flash')) : [])])];
    const reached = capped(next);
    if (!reached.length) {
      return next;
    }
    const other = (e: Effort): Effort => (e === 'flash' ? 'thinking' : 'flash');
    const otherProvider: ProviderId = next.provider === 'claude' ? 'deepseek' : 'claude';
    const candidates: ModelChoice[] = [{ provider: next.provider, effort: other(next.effort) }];
    if (this.mode === 'auto' && Date.now() >= this.blockedUntil[otherProvider] && (otherProvider === 'claude' ? await this.canSwitchTo('claude') : await this.isConfigured('deepseek'))) {
      candidates.push({ provider: otherProvider, effort: next.effort }, { provider: otherProvider, effort: other(next.effort) });
    }
    const pick = candidates.find((c) => !capped(c).length);
    const help = 'Run "Dual Agent: Reset Cost Limits" or raise dualAgent.modelCostLimitsUsd';
    if (!pick) {
      this.post({ type: 'notice', level: 'error', text: `${reached.join(', ')} reached ${reached.length === 1 ? 'its' : 'their'} cost limit and no other model is available. ${help}.` });
      return undefined;
    }
    const model = modelFor(pick.provider, pick.effort);
    this.post({ type: 'notice', level: 'warn', text: `${reached.join(', ')} reached ${reached.length === 1 ? 'its' : 'their'} cost limit, so ${model} answers instead. ${help} to use it again.` });
    const last = this.lastChoice;
    return { ...pick, reason: `cost limit reached for ${reached.join(', ')}`, switching: !last || last.provider !== pick.provider || last.effort !== pick.effort };
  }

  /** Checked on every model call: a reached limit stops the reply. */
  private enforceLimits(model: string | undefined) {
    const turn = this.turn;
    if (!turn || turn.interrupted || this.limitStopped === turn) {
      return;
    }
    const status = this.limitState();
    if (!status) {
      return;
    }
    const keys = cappedKeys(status, model);
    if (!totalReached(status) && !keys.length) {
      this.warnNearing(status);
      return;
    }
    this.limitStopped = turn;
    const what = totalReached(status) ? `Spend since the last reset reached your cost limit of ${usd(status.total!.limit)}` : `${keys.join(', ')} reached ${keys.length === 1 ? 'its' : 'their'} cost limit`;
    this.post({ type: 'notice', level: 'error', text: `${what}, so the reply was stopped. Run "Dual Agent: Reset Cost Limits" or raise the limit to keep going.` });
    void this.stop().catch((err) => swallowed('Stopping at a cost limit', err));
  }

  private notePrompt(text: string) {
    this.recentPrompts = [...this.recentPrompts, text].slice(-3);
  }

  /**
   * "Likely relevant" files for a message that names none (dualAgent.retrieval):
   * answers "which files do I know?" from what is already open and the index, so
   * the turn runs on the user's own words.
   */
  private async relevantContext(text: string, includeEditor: boolean | undefined): Promise<string | undefined> {
    const cwd = this.resolveCwd();
    // Only a new task's first message: later turns of the same task carry the conversation and that index already.
    if (text.length < 12 || settings().get<boolean>('retrieval') === false || !this.startsNewTask(text)) { // default true, as projectMemory
      return undefined;
    }
    const open = includeEditor ? editorFile() : undefined;
    const recent = [...this.editedFiles, ...(open ? [open] : [])].map((f) => path.relative(cwd, f).replace(/\\/g, '/'));
    return likelyRelevant(cwd, text, recent);
  }

  /**
   * A stronger model taking over with a short handoff instead of the cheaper
   * model's whole history (SWE-Router restarts the strong model from the task;
   * a scout's handoff carried a result at 1/5 of the cost).
   */
  private withHandoff(prompt: UserContent): UserContent {
    const cwd = this.resolveCwd();
    const todos = this.evidence.get('main')?.todos.filter((t) => t.status !== 'completed') ?? [];
    const lines = [
      'You are taking over this task from a cheaper model; its full history was left out to save tokens. Handoff:',
      `- Recent requests: ${this.recentPrompts.slice(0, -1).map((p) => `"${short(p, 300)}"`).join('; ') || 'none'}`,
      `- Files changed so far: ${[...this.editedFiles].map((f) => path.relative(cwd, f) || f).slice(0, 20).join(', ') || 'none'}`,
      `- Open to-dos: ${todos.map((t) => t.content).join('; ') || 'none'}`,
      `- Its last reply: ${short(this.lastReply, 1500) || 'none'}`,
      'Check notes_read and git diff before re-reading files. The new request follows.',
    ];
    const handoff = lines.join('\n');
    return typeof prompt === 'string' ? `${handoff}\n\n${prompt}` : [{ type: 'text', text: handoff }, ...prompt];
  }

  /** Stops one helper agent or background task; the rest keep working. */
  async stopAgent(taskId: string) {
    try {
      await withTimeout(this.query?.stopTask(taskId) ?? Promise.resolve(), 5_000, 'Stopping the agent');
    } catch (err) {
      swallowed('stopTask', err);
      this.post({ type: 'notice', level: 'warn', text: `That agent couldn't be stopped: ${errorMessage(err)}` });
    }
  }

  private startsNewTask(text: string): boolean {
    return startsTask({ current: this.lastChoice, prompt: text, idleMs: Date.now() - this.lastCallAt, contextTokens: this.contextTokens });
  }

  private buildPrompt(req: SendRequest): UserContent {
    const context = req.includeEditor ? editorContext(this.seenFiles) : undefined;
    const files = attachmentBlocks(req.attachments);
    if (!context && !files.length) {
      return req.text;
    }
    const blocks: ContentBlock[] = [...files];
    if (context) {
      blocks.push({ type: 'text', text: `<editor_context>\n${context}\n</editor_context>` });
    }
    blocks.push({ type: 'text', text: req.text });
    return blocks;
  }

  async stop() {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    turn.interrupted = true;
    this.cards.cancelAll();
    this.stopWait?.();
    if (!this.query) {
      // Still starting (or switching providers): startTurn sees the flag and ends the turn as stopped.
      return;
    }
    try {
      await withTimeout(this.query.interrupt(), 5_000, 'Stopping the agent');
    } catch (err) {
      swallowed('interrupt', err);
      this.closeQuery();
      await this.finishTurn();
      return;
    }
    // The interrupt was accepted but no result may ever come: don't stay busy.
    setTimeout(() => {
      if (this.turn === turn && !turn.settled) {
        this.log.appendLine('No result after Stop; closing the agent process.');
        this.closeQuery();
        void this.finishTurn();
      }
    }, STOP_GRACE_MS);
  }

  newChat() {
    this.resetConversation();
    this.post({ type: 'reset' });
    this.usage.show();
    this.postAgents(true);
    this.emitState();
  }

  /** Switches to a saved chat: the next message resumes its Claude Code session. */
  restoreConversation(sessionId: string | undefined, providers: ProviderId[], usage?: Usage, agents?: AgentsSnapshot) {
    this.resetConversation(sessionId, providers, usage);
    this.tracker.load(agents);
  }

  /** Ends any reply in progress and forgets the conversation, optionally loading a saved one. */
  private resetConversation(sessionId?: string, providers: ProviderId[] = [], usage?: Usage) {
    this.conversationGeneration++;
    this.closeTask('new_chat');
    // The old reply's last text lands before the chat is cleared or replaced, as each token did.
    this.flushDelta();
    this.agentsSent = undefined;
    this.closeQuery();
    if (this.turn) {
      this.turn.settled = true;
      this.turn = undefined;
      this.stopLive();
      this.tracker.endTurn(true);
    }
    this.sessionId = sessionId;
    this.historyProviders = new Set(providers);
    this.seenFiles.clear();
    this.reportedDuplicates.clear();
    this.pending = [];
    this.evidence.clear();
    this.workedRepos.clear();
    this.streamIds.clear();
    this.loops.forget();
    this.editedFiles.clear();
    this.briefScopes.clear();
    this.agentScopes.clear();
    this.recentPrompts = [];
    this.lastReply = '';
    this.outlinedHints.clear();
    this.signals = CALM;
    this.lastChoice = undefined;
    this.contextTokens = 0;
    // Unknown for a restored chat, so a resume on any provider counts as a possible switch.
    this.lastLaunchKey = undefined;
    this.permissionOverride = undefined;
    this.usage.reset(usage, sessionId);
    this.tracker.reset();
    this.sources.reset();
    this.cards.startTurn();
    this.releaseIdleWaiters();
  }

  /** Sends the usage panel its numbers, and keeps them live while it stays open. */
  usageReport(scope: UsageScope | undefined) {
    this.usage.report(scope);
  }

  /** Redraws the usage panel if it's open. */
  refreshUsage() {
    this.usage.refresh();
  }

  answerPermission(id: string, decision: PermissionDecision) {
    this.cards.answerPermission(id, decision);
  }

  /** The user's choices for a question card, or undefined to skip it. */
  answerQuestion(id: string, reply: QuestionAnswers | undefined) {
    this.cards.answerQuestion(id, reply);
  }

  decidePlan(id: string, approve: boolean, feedback?: string) {
    this.cards.decidePlan(id, approve, feedback);
  }

  async setMode(mode: Mode) {
    await settings().update('mode', mode, vscode.ConfigurationTarget.Global);
    // Switching by hand clears any automatic pause on that provider.
    if (mode !== 'auto') {
      this.blockedUntil[mode] = 0;
    }
    await this.updateNextProvider();
  }

  /** Takes effect on the next message: the conversation resumes on the new model. */
  async setEffort(effort: Effort) {
    await settings().update(effortSetting(this.displayedNext().provider), effort, vscode.ConfigurationTarget.Global);
    await this.updateNextProvider();
  }

  async setPermissionMode(mode: PermissionMode) {
    this.permissionOverride = undefined;
    await settings().update('permissionMode', mode, vscode.ConfigurationTarget.Global);
    await this.applyPermissionMode();
  }

  /** An approved plan: carry it out, asking before edits and commands. Other chats keep their mode. */
  private async leavePlanMode() {
    this.permissionOverride = 'default';
    await this.applyPermissionMode();
  }

  /** Applies the permission mode to the running agent right away, even mid-task. */
  async applyPermissionMode() {
    try {
      await this.query?.setPermissionMode(this.permissionMode);
    } catch (err) {
      swallowed('setPermissionMode', err);
    }
    this.emitState();
  }

  /** Resolves once no reply is in progress (after fallbacks and retries settle). */
  whenIdle(): Promise<void> {
    return this.busy ? new Promise((resolve) => this.idleWaiters.push(resolve)) : Promise.resolve();
  }

  dispose() {
    this.disposed = true;
    this.flushDelta();
    this.offDiag();
    const turn = this.turn;
    if (turn) {
      // A retry waiting to start (its turn already settled), or a sign-in resume, must not launch an agent for a closed chat.
      const running = !turn.settled;
      turn.interrupted = turn.settled = true;
      this.turn = undefined;
      try {
        if (running) {
          this.recordFinishedTurn(turn, false);
        }
      } catch (err) {
        swallowed('Recording the reply cut off by closing the chat', err);
      }
    }
    this.closeTask('new_chat');
    this.usage.flushCalls();
    for (const id of this.helpers.running()) {
      this.endHelper(id, 'stopped');
    }
    this.usage.dispose();
    this.closeQuery();
    this.stopLive();
    clearTimeout(this.agentsTimer);
    clearInterval(this.superviseTimer);
    this.releaseIdleWaiters();
  }

  private releaseIdleWaiters() {
    this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }

  /** The model for the next message: fixed by the mode, or routed per message in auto (agent/router.ts). */
  private async pickModel(prompt = ''): Promise<RouterDecision> {
    const now = Date.now();
    const split = this.splitInput();
    this.stint = split && { ...currentStint(split), today: { claude: split.claudeTokens, deepseek: split.deepseekTokens } };
    nameDeepSeekModels({ flash: displayName(deepseekModel('flash')), thinking: displayName(deepseekModel('thinking')) });
    return route({
      mode: this.mode,
      autoPrimary: autoPrimary(),
      configured: { claude: await this.canSwitchTo('claude'), deepseek: await this.isConfigured('deepseek') },
      claudeOff: !claudeAllowed(),
      split,
      blockedUntil: this.blockedUntil,
      preferred: { claude: effortFor('claude'), deepseek: effortFor('deepseek') },
      current: this.lastChoice,
      prompt,
      signals: this.signals,
      quota: this.quota,
      contextTokens: this.contextTokens,
      idleMs: now - this.lastCallAt,
      now,
    });
  }

  /** The repo's split target with its tokens today per provider and its usual day, when a split is set. */
  private splitInput(): Split | undefined {
    const target = tokenSplit();
    if (target === undefined) {
      return undefined;
    }
    const t = this.usage.splitTokens();
    return { claudeTarget: target / 100, claudeTokens: t.claude, deepseekTokens: t.deepseek, dayTokens: t.day };
  }

  /**
   * Auto mode, Flash struggling inside a turn: switch the running session to
   * V4 Pro for the rest of it (thinking stays off until the next message,
   * which relaunches with it). Helpers' errors don't count, only the main loop's.
   */
  private async maybeEscalate(turn: Turn) {
    if (this.mode !== 'auto' || turn.escalated || turn.provider !== 'deepseek' || this.activeEffort !== 'flash' || !this.query) {
      return;
    }
    const errors = (only?: string[]) => Object.entries(this.mainFailures).reduce((n, [name, count]) => n + (!only || only.includes(name) ? count : 0), 0);
    const f = this.firstSteps;
    const why = earlyEscalation(
      { modelCalls: this.meter.calls, toolErrors: errors(), editFailures: errors(EDIT_TOOLS), failedChecks: errors(['Bash']), reads: f.reads, searches: f.searches, repeatedSearches: f.repeatedSearches },
      { provider: 'deepseek', effort: this.activeEffort },
    );
    if (!why) {
      return;
    }
    turn.escalated = true;
    try {
      await this.query.setModel(deepseekModel('thinking'));
    } catch (err) {
      swallowed('Mid-turn escalation', err);
      return;
    }
    const to: ModelChoice = { provider: 'deepseek', effort: 'thinking' };
    turn.effort = 'thinking';
    this.activeEffort = 'thinking';
    this.lastChoice = to;
    // The process still runs with Flash's settings: the next message relaunches.
    this.launchKey = this.lastLaunchKey = 'deepseek/escalated';
    this.post({ type: 'notice', level: 'info', text: `Auto: escalated to ${label(to)} mid-task (${why}).` });
    this.emitState();
  }

  /** V4 Pro advising a Flash main agent, when dualAgent.deepseek.advisor is on. */
  private async advisorFor(provider: ProviderId, effort: Effort): Promise<AdvisorCall | undefined> {
    if (provider !== 'deepseek' || effort !== 'flash' || !settings().get<boolean>('deepseek.advisor')) {
      return undefined;
    }
    const key = await this.creds.getDeepSeekKey();
    return key ? { baseUrl: settings().get<string>('deepseek.baseUrl') || 'https://api.deepseek.com/anthropic', key, model: deepseekModel('thinking') } : undefined;
  }

  /** Counts the main agent's reads and searches, and searches it repeats exactly. */
  private noteFirstSteps(tool: string, input: Record<string, unknown>) {
    const f = this.firstSteps;
    if (tool === 'Read') {
      f.reads++;
      return;
    }
    const search = tool === 'Grep' || tool === 'Glob' || (tool === 'Bash' && typeof input.command === 'string' && /^\s*(rg|grep|find)\b/.test(input.command));
    if (!search) {
      return;
    }
    f.searches++;
    const sig = signature(tool, input);
    if (f.seen.has(sig)) {
      f.repeatedSearches++;
    }
    f.seen.add(sig);
  }

  /** A turn's tool failures feed the router: trouble escalates, a clean turn calms it. */
  private updateSignals(m: TurnMetrics) {
    if (m.outcome === 'stopped') {
      return;
    }
    const errors = (only?: string[]) => Object.entries(m.tools).reduce((n, [name, t]) => n + (!only || only.includes(name) ? t.errors : 0), 0);
    const toolErrors = errors();
    if (m.outcome === 'done' && toolErrors <= 1) {
      this.signals = { ...CALM, lastTurnOk: true };
      return;
    }
    const s = this.signals;
    this.signals = {
      failedChecks: s.failedChecks + errors(['Bash']),
      toolErrors: s.toolErrors + toolErrors,
      editFailures: s.editFailures + errors(EDIT_TOOLS),
      turnsOnTask: s.turnsOnTask + 1,
      lastTurnOk: false,
    };
  }

  /** Whether auto mode may move to this provider: set up, and for Claude not switched off. */
  /** The proxy answers a network failure with 529, which Claude Code calls overloaded: name it for what it is. */
  private netCode(code: string, provider: ProviderId | undefined): string {
    const recent = provider && Date.now() - (this.netFailAt[provider] ?? 0) < 30_000;
    return recent && ['overloaded', 'server_error', 'unknown'].includes(code) ? 'network' : code;
  }

  /** Failing over to a provider whose requests are failing on the network too only adds a relaunch. */
  private async canFailOverTo(provider: ProviderId): Promise<boolean> {
    return Date.now() - (this.netFailAt[provider] ?? 0) >= 60_000 && (await this.canSwitchTo(provider));
  }

  private async canSwitchTo(provider: ProviderId): Promise<boolean> {
    return (provider !== 'claude' || claudeAllowed()) && (await this.isConfigured(provider));
  }

  private async isConfigured(provider: ProviderId): Promise<boolean> {
    if (provider === 'deepseek') {
      return !!(await this.creds.getDeepSeekKey());
    }
    return this.claudeSignedIn || !!(await this.creds.getAnthropicKey());
  }

  /** Tells the chat a reply is starting. */
  private beginReply(turn: Turn) {
    if (turn.implicit) {
      this.meter.start();
    }
    this.turn = turn;
    this.lastEventAt = Date.now();
    this.mainFailures = {};
    this.firstSteps = { reads: 0, searches: 0, repeatedSearches: 0, seen: new Set() };
    this.setActivity('Waiting for the model');
    this.liveTimer ??= setInterval(() => this.postActivity(), LIVE_TICK_MS);
    this.post({ type: 'assistantStart', provider: turn.provider, effort: turn.effort });
    this.tracker.startTurn(modelFor(turn.provider, turn.effort) ?? 'Claude (your default)');
    this.postAgents(true);
  }

  private async startTurn(turn: Turn, fresh = false) {
    if (this.disposed) {
      return;
    }
    this.turn = turn;
    this.sawThinking = false;
    // A different provider, or a different model on the same one, may refuse the earlier history.
    const relaunch = !!this.lastLaunchKey && this.lastLaunchKey !== `${turn.provider}/${turn.effort}`;
    turn.resumedAcross = !fresh && !!this.sessionId && (relaunch || [...this.historyProviders].some((p) => p !== turn.provider));
    this.emitState();
    try {
      await this.ensureQuery(turn.provider, turn.effort, fresh);
    } catch (err) {
      turn.error = 'startup';
      turn.errorText = errorMessage(err);
      await this.finishTurn();
      return;
    }
    if (this.turn !== turn) {
      // The chat was reset or closed while the agent was starting.
      return;
    }
    if (turn.interrupted || !this.input) {
      // Stopped while starting.
      await this.finishTurn();
      return;
    }
    this.beginReply(turn);
    this.input.push({ type: 'user', message: { role: 'user', content: turn.prompt }, parent_tool_use_id: null } as SDKUserMessage);
    turn.begun = true;
  }

  /** Who runs the next launch's helper tiers (agent/router.ts helperRoster). */
  private async pickRoster(provider: ProviderId): Promise<HelperRoster> {
    const now = Date.now();
    const deepseekReady = provider !== 'deepseek' && deepseekHelpersAllowed() && now >= this.blockedUntil.deepseek && (await this.isConfigured('deepseek'));
    const claudeReady = provider !== 'claude' && claudeHelpersAllowed() && now >= this.blockedUntil.claude && (await this.canSwitchTo('claude'));
    return helperRoster(provider, { deepseekReady, claudeReady, claudeOk: claudeQuotaOk(this.quota, now), split: this.splitInput(), current: this.roster?.work });
  }

  /**
   * Starts a Claude Code process for this provider, resuming the conversation
   * if there is one. `prewarm`: started ahead of the next message and kept as
   * a spare until a reply takes it over (it waits for its first prompt).
   */
  private async ensureQuery(provider: ProviderId, effort: Effort, fresh: boolean, prewarm = false) {
    const key = `${provider}/${effort}`;
    const wanted = await this.pickRoster(provider);
    const asked = `${wanted.work}/${wanted.plan}`;
    const cwd = this.resolveCwd();
    // Moving helpers to the other provider waits for the working ones: a relaunch would kill them.
    // A spare is only taken in the folder it started in (the active file may have moved to another workspace folder).
    if (this.query && this.launchKey === key && (this.helpersAsked === asked || this.tracker.helpersWorking() > 0) && !fresh && (!this.spare || this.spare.cwd === cwd)) {
      if (!prewarm) {
        this.takeSpare(key);
      }
      return;
    }
    if (this.disposed) {
      throw new Error('the chat was closed');
    }
    // Why this process starts: a restart throws the prompt cache away (Claude) and costs a start-up.
    const reason = fresh
      ? 'fresh handoff'
      : !this.lastLaunchKey
        ? undefined
        : this.query && this.launchKey === key
          ? `helpers to ${PROVIDER_LABELS[wanted.work]}, planning on ${PROVIDER_LABELS[wanted.plan]}`
          : this.query
            ? `switch ${this.launchKey} → ${key}`
            : this.lastLaunchKey === key
              ? 'process had ended'
              : `switch ${this.lastLaunchKey} → ${key}`;
    this.closeQuery();
    const generation = this.launchGeneration;
    this.launchStartedAt = Date.now();
    if (reason) {
      this.report({ kind: 'relaunch', provider, detail: prewarm ? `${reason} (ahead of the next message)` : reason });
    }
    if (fresh) {
      this.sessionId = undefined;
      this.historyProviders.clear();
    }
    // The independent steps run together; the memory files are read while they wait.
    // options.ts (zod and the MCP servers) loads here, not at activation.
    const setup = Promise.all([buildLaunch(provider, effort, this.creds, wanted), import('@anthropic-ai/claude-agent-sdk'), this.advisorFor(provider, effort), import('./agent/options.js')]);
    const memory = this.sessionId ? undefined : this.primer(cwd);
    const brief = this.helperBrief(cwd);
    const [launch, sdk, advisor, { agentOptions, helperToolNames, readOnlyHelperTools }] = await setup;
    if (generation !== this.launchGeneration) {
      return;
    }
    const tools = helperToolNames(provider);
    const helpers = Object.fromEntries(
      Object.entries(helperAgents(launch.roster)).map(([name, { readOnly, ...a }]) => [name, { ...a, tools: readOnly ? readOnlyHelperTools() : tools }]),
    );
    this.helperModels = Object.fromEntries(Object.entries(helpers).map(([name, a]) => [name, a.model]));
    this.helpersAsked = asked;
    this.roster = launch.roster;
    const input = new AsyncQueue<SDKUserMessage>();
    const { work, plan } = launch.roster;
    const helperNote = work !== provider || plan !== provider ? `, helpers on ${PROVIDER_LABELS[work]}, planning on ${PROVIDER_LABELS[plan]}` : '';
    const starting = `Starting ${PROVIDER_LABELS[provider]} (${launch.model ?? 'default model'}, ${effort}${helperNote}) session${this.sessionId ? ` (resuming ${this.sessionId})` : ''}${prewarm ? ' ahead of the next message' : ''}`;
    this.log.appendLine(`${starting} in ${cwd}`);
    // Kept once the session id is known (a new session has none until its first message).
    this.launchRow = { kind: 'launch', level: 'info', provider, model: launch.model, detail: starting };
    const q = sdk.query({
      prompt: input,
      options: {
        cwd,
        env: launch.env,
        model: launch.model,
        resume: this.sessionId,
        includePartialMessages: true,
        agents: helpers,
        // Stop ends the current turn only; helpers and background tasks have their own stop.
        perTaskStopAffordance: true,
        settings: { autoCompactWindow: compactWindow(provider), bashOutputMaxChars: BASH_OUTPUT_CHARS, autoMemoryEnabled: true, ...launch.settings },
        thinking: launch.thinking,
        effort: launch.effort,
        permissionMode: this.permissionMode,
        // Lets the chat switch to "Bypass" mid-session; the mode itself stays whatever the user picked.
        allowDangerouslySkipPermissions: true,
        canUseTool: async (toolName, toolInput, opts) => {
          const answer = await this.askUser(toolName, toolInput, opts);
          if (answer.behavior === 'deny') {
            // A build that won't run doesn't hold its repo.
            this.releaseBuild(opts.toolUseID);
          }
          return answer;
        },
        ...agentOptions(sdk, { provider, cwd, hasHelpers: Object.keys(helpers).length > 0, sources: this.sources, onEdit: (h) => this.timed('edit check', () => this.editFeedback(cwd, h)), onTool: (h) => this.timed('after tool', () => this.measureTool(h)), onPreTool: (h) => this.timed('guard', () => this.guardTool(h)), reuse: this.reuse, memory, helperBrief: brief, onHelperBrief: (type) => this.report({ kind: 'memory', level: 'info', code: 'brief', target: type }), noteAuthor: (id) => this.noteAuthor(id), onCompact: (summary, trigger) => {
          this.compacted = { before: this.contextTokens, summaryChars: summary.length, trigger };
          this.keepHandoff(cwd, summary);
        }, onStop: (h) => this.timed('report check', () => this.checkClaims(cwd, h)), stopTimeoutSec: stopTimeoutSec(), afterCompact: () => this.primer(cwd, false), focus: () => this.focus(), advisor }),
        settingSources: ['user', 'project', 'local'],
        stderr: (data) => this.log.append(data),
      },
    });
    this.query = q;
    this.input = input;
    if (provider === 'claude') {
      // Which Claude families this account offers, for the helpers' next launch (models.ts bestClaude).
      q.supportedModels().then(noteClaudeModels, (e) => this.log.appendLine(`Claude model list unavailable: ${errorMessage(e)}`));
    }
    this.usage.processStarted();
    this.meter.newProcess();
    this.turnsThisProcess = 0;
    this.spillDir = undefined;
    this.spillFailed = false;
    this.activeProvider = provider;
    this.activeEffort = effort;
    this.launchKey = key;
    if (prewarm) {
      // The router and the relaunch reasons hear of it only once a reply takes it over.
      this.spare = { cwd, timer: setTimeout(() => this.closeSpare(), SPARE_IDLE_MS) };
    } else {
      this.lastChoice = { provider, effort };
      this.lastLaunchKey = key;
    }
    this.emitState();
    void this.pump(q);
  }

  /** A reply takes over the spare process: from now on it is the reply's own. */
  private takeSpare(key: string) {
    if (!this.spare) {
      return;
    }
    clearTimeout(this.spare.timer);
    this.spare = undefined;
    this.lastChoice = { provider: this.activeProvider!, effort: this.activeEffort! };
    this.lastLaunchKey = key;
    this.meter.prewarmed = true;
    if (this.launchStartedAt) {
      // Still starting: only the wait from the message on counts.
      this.launchStartedAt = Date.now();
    }
  }

  /** A spare unused for SPARE_IDLE_MS holds memory for nothing; the next trigger starts another. */
  private closeSpare() {
    if (this.spare && !this.busy) {
      this.log.appendLine('Closing the agent process started ahead of the next message: unused for 10 minutes.');
      this.closeQuery();
      this.emitState();
    }
  }

  /**
   * Starts the next message's agent process now, so sending doesn't wait for
   * it: when the chat opens, and after a reply when the next model differs.
   * Only while idle, signed in, and with no helpers working (a relaunch kills them).
   */
  prewarm(): Promise<void> {
    return (this.warming ??= this.warmUp().finally(() => (this.warming = undefined)));
  }

  /** Settings changed: a spare started with the old ones starts again with the new. */
  async settingsChanged() {
    if (!this.spare || this.busy) {
      return;
    }
    this.closeQuery();
    try {
      await this.updateNextProvider();
      await this.prewarm();
    } catch (err) {
      swallowed('Restarting the spare agent', err);
    }
  }

  private async warmUp() {
    await this.statusCheck;
    const provider = this.nextProvider;
    const effort = this.nextEffort ?? effortFor(provider);
    const idle = () => !this.disposed && !this.busy && this.tracker.helpersWorking() === 0;
    if (!idle() || !this.statusChecked || (this.query && this.launchKey === `${provider}/${effort}`) || !(await this.canSwitchTo(provider)) || !idle()) {
      return;
    }
    try {
      await this.ensureQuery(provider, effort, false, true);
    } catch (err) {
      swallowed('Starting the agent ahead of the next message', err);
    }
  }

  private async pump(q: Query) {
    let failure: string | undefined;
    try {
      for await (const msg of q) {
        if (q !== this.query) {
          return;
        }
        try {
          this.handle(msg);
        } catch (err) {
          // A bug handling one message must not end the conversation or count as a provider failure.
          swallowed(`Handling a ${msg.type} message`, err);
        }
      }
    } catch (err) {
      failure = errorMessage(err);
      this.report({ kind: 'api_error', code: errorCode(undefined, failure), status: statusIn(failure), detail: failure, target: 'agent process' });
    }
    if (q !== this.query) {
      return;
    }
    // The process ended: never reuse it, whether or not a reply was running.
    const spare = !!this.spare;
    this.closeQuery();
    if (this.turn) {
      this.turn.error ??= 'startup';
      this.turn.errorText ??= failure ?? 'The agent process exited unexpectedly. See the "Dual Agent" output panel.';
      await this.finishTurn();
    } else {
      // A spare's failure is only logged (above): the next message starts another and shows its error.
      if (failure && !spare) {
        this.post({ type: 'notice', level: 'error', text: failure, diagnose: true });
      }
      this.emitState();
    }
  }

  private handle(msg: SDKMessage) {
    this.lastEventAt = Date.now();
    this.stallReported = false;
    let turn = this.turn;
    if (!turn && (msg.type === 'stream_event' || msg.type === 'assistant') && !msg.parent_tool_use_id && this.activeProvider) {
      // Claude Code started a reply on its own, typically to report what a background helper found.
      turn = { ...newTurn('', this.activeProvider, this.activeEffort ?? effortFor(this.activeProvider), true), implicit: true, begun: true };
      // Say why the chat started working without a message: otherwise it looks like it acts on its own.
      const r = this.lastReported && Date.now() - this.lastReported.at < 120_000 ? this.lastReported : undefined;
      turn.wokenBy = r?.helper;
      this.post({ type: 'notice', level: 'info', text: r ? `Helper ${r.status}: ${r.name}. The agent is picking up its report.` : 'A background task reported back; the agent is picking it up.' });
      this.lastReported = undefined;
      this.beginReply(turn);
      this.emitState();
    }
    if ('session_id' in msg && msg.session_id) {
      this.sessionId = msg.session_id;
      this.usage.addSession(msg.session_id);
      if (this.launchRow) {
        this.report(this.launchRow);
        this.launchRow = undefined;
      }
    }
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && this.launchStartedAt) {
          // The new process answered: its start-up time counts toward the turn, unless it started ahead of any message.
          if (!this.spare) {
            this.meter.launched(Date.now() - this.launchStartedAt);
          }
          this.launchStartedAt = 0;
        }
        this.handleSystem(msg);
        break;
      case 'stream_event': {
        this.streamUsage(msg.parent_tool_use_id, msg.event);
        if (msg.parent_tool_use_id || !turn) {
          break;
        }
        const ev = msg.event;
        if (ev.type === 'content_block_delta') {
          // Text, thinking or a tool call's input: the model has started answering.
          this.meter.firstToken();
        }
        if (ev.type === 'content_block_start') {
          this.setActivity(ev.content_block.type === 'thinking' ? 'Thinking' : ev.content_block.type === 'tool_use' ? 'Preparing a tool call' : 'Writing');
        }
        if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta' && !this.sawThinking) {
          this.sawThinking = true;
          this.post({ type: 'thinking' });
        }
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          turn.producedOutput = true;
          this.historyProviders.add(turn.provider);
          this.cards.noteText(ev.delta.text);
          turn.replyText = (turn.replyText ?? '') + ev.delta.text;
          this.deltaText += ev.delta.text;
          this.deltaTimer ??= setTimeout(() => this.flushDelta(), DELTA_FLUSH_MS);
        }
        break;
      }
      case 'assistant':
        this.handleAssistant(msg, turn);
        break;
      case 'user':
        if (msg.parent_tool_use_id && Array.isArray(msg.message.content)) {
          this.tracker.subToolResults(msg.parent_tool_use_id, msg.message.content);
          this.measureResults(msg.message.content);
          this.postAgents();
        } else if (!msg.parent_tool_use_id && Array.isArray(msg.message.content)) {
          this.setActivity('Waiting for the model');
          this.tracker.mainToolResults(msg.message.content);
          this.measureResults(msg.message.content);
          this.postAgents();
        }
        break;
      case 'rate_limit_event': {
        const info = msg.rate_limit_info;
        const window = info.rateLimitType ? WINDOW_MS[info.rateLimitType] : undefined;
        const resetsMs = info.resetsAt === undefined ? undefined : info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
        this.quota = { status: info.status, utilization: info.utilization, resetsAt: resetsMs, windowStart: resetsMs && window ? resetsMs - window : undefined };
        if (info.status === 'rejected' && turn) {
          turn.resetsAt = info.resetsAt;
        } else if (info.status === 'allowed_warning' && info.utilization !== undefined) {
          this.post({ type: 'notice', level: 'info', text: `${this.label()} usage is at ${Math.round(info.utilization * 100)}% of the current limit.` });
        }
        break;
      }
      case 'result':
        void this.finishTurn(msg);
        break;
    }
  }

  private handleSystem(msg: Extract<SDKMessage, { type: 'system' }>) {
    switch (msg.subtype) {
      case 'compact_boundary':
        this.meter.compaction();
        return;
      case 'api_retry': {
        this.meter.retry();
        const code = this.netCode(errorCode(msg.error, '', msg.error_status, !!msg.no_response), this.activeProvider);
        const waited = msg.no_response ? `, no response in ${Math.round(msg.no_response.waited_ms / 1000)}s` : '';
        const row = this.report({ kind: 'api_retry', code, status: msg.error_status, detail: `attempt ${msg.attempt}/${msg.max_retries}, next in ${Math.round(msg.retry_delay_ms / 1000)}s${waited}` });
        // D2: other chats see the same outage, so waiting out more retries won't help.
        const outage = diagnosisOf(row)?.rule === 'D2';
        if (msg.attempt === 1 && canRetry(code)) {
          const status = msg.error_status && code !== 'network' ? `, HTTP ${msg.error_status}` : '';
          this.post({ type: 'notice', level: 'warn', quiet: true, text: `${this.label()} request failed (${describeError(code)}${status}); retrying…` });
        }
        void this.maybeStopRetrying(code, outage ? Math.max(msg.attempt, MAX_RETRIES) : msg.attempt, outage).catch((err) => swallowed('Stopping retries', err));
        return;
      }
      case 'task_started': {
        this.tracker.taskStarted(msg);
        if (msg.tool_use_id) {
          this.helpers.task(msg.task_id, msg.tool_use_id, msg.is_backgrounded);
        }
        const scope = msg.tool_use_id ? this.briefScopes.get(msg.tool_use_id) : undefined;
        if (msg.tool_use_id) {
          this.briefScopes.delete(msg.tool_use_id);
        }
        if (scope) {
          this.agentScopes.set(msg.task_id, scope);
          scope.roots?.forEach((r) => this.workedRepos.add(r));
        }
        break;
      }
      case 'task_progress':
        this.tracker.taskProgress(msg);
        break;
      case 'task_updated':
        this.tracker.taskUpdated(msg);
        break;
      case 'background_tasks_changed':
        this.tracker.liveTasks(msg.tasks.filter((t) => !t.ambient).map((t) => t.task_id));
        break;
      case 'task_notification': {
        const name = this.tracker.snapshot().agents.find((a) => a.taskId === msg.task_id)?.description;
        this.lastReported = { name: name || 'a background task', status: msg.status === 'completed' ? 'finished' : msg.status, at: Date.now(), helper: this.helpers.idOf(msg.task_id) };
        this.tracker.taskEnded(msg);
        this.endHelper(msg.task_id, msg.status === 'completed' ? undefined : 'stopped');
        // A helper stopped without its stop hook (Stop pressed, process closed) leaves nothing behind.
        this.evidence.delete(msg.task_id);
        this.agentScopes.delete(msg.task_id);
        resolved(`refusal:${msg.task_id}:`);
        resolved(`dump:${msg.task_id}`);
        this.loops.forget(msg.task_id);
        // The helper may have fixed what the main agent's earlier calls failed on.
        this.loops.forget('main');
        break;
      }
      default:
        return;
    }
    this.postAgents();
  }

  private handleAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>, turn: Turn | undefined) {
    if (msg.parent_tool_use_id) {
      this.tracker.subMessage(msg.parent_tool_use_id, msg.message.id, msg.message.content, msg.message.usage ?? undefined);
      this.meter.helperCall(msg.message.id);
      this.recordCall(this.tracker.agentName(msg.parent_tool_use_id), msg.message, msg.parent_tool_use_id);
      this.noteToolCalls(msg.message.content, msg.parent_tool_use_id);
      this.postAgents();
      return;
    }
    if (!turn) {
      return;
    }
    turn.reachedModel = true;
    if (msg.error) {
      turn.errorText = msg.message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();
      turn.error = errorCode(msg.error, turn.errorText);
      this.report({ kind: 'api_error', code: turn.error, status: statusIn(turn.errorText), detail: turn.errorText, target: msg.message.id });
      return;
    }
    this.tracker.mainMessage(msg.message.id, msg.message.content, msg.message.usage ?? undefined);
    this.postAgents();
    if (msg.message.usage) {
      this.usage.setContext(msg.message.usage);
      this.recordCall('Main agent', msg.message);
      this.contextTokens = inputTokens(msg.message.usage);
      this.lastCallAt = Date.now();
      if (this.compacted) {
        const c = this.compacted;
        this.compacted = undefined;
        this.report({ kind: 'compaction', level: 'info', code: c.trigger, detail: `context ${formatTokens(c.before)} → ${formatTokens(this.contextTokens)}; summary ${c.summaryChars} chars` });
      }
      this.meter.modelCall(msg.message.id, this.contextTokens);
      void this.maybeEscalate(turn);
      this.stopRunaway(turn);
    }
    for (const block of msg.message.content) {
      if (block.type !== 'tool_use') {
        continue;
      }
      turn.producedOutput = true;
      this.historyProviders.add(turn.provider);
      const input = (block.input ?? {}) as Record<string, unknown>;
      this.noteToolCalls([block]);
      if (SPAWN_TOOLS.has(block.name)) {
        this.helpers.spawn(block.id, typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose', typeof input.prompt === 'string' ? input.prompt.length : 0, this.meter.id, input.run_in_background === true);
      }
      this.noteFirstSteps(block.name, input);
      this.cards.noteToolUse(block.name, input);
      this.setActivity(`Running ${block.name}: ${short(describeToolInput(block.name, input), 70)}`, true);
      this.post({ type: 'tool', name: block.name, detail: describeToolInput(block.name, input), path: typeof input.file_path === 'string' ? input.file_path : undefined });
    }
  }

  /** The final output count of each model call (main or helper), as its stream ends. */
  private streamUsage(parent: string | null, ev: Extract<SDKMessage, { type: 'stream_event' }>['event']) {
    const stream = parent ?? 'main';
    if (ev.type === 'message_start') {
      this.streamIds.set(stream, ev.message.id);
    } else if (ev.type === 'message_delta' && ev.usage?.output_tokens) {
      this.usage.callOutput(this.streamIds.get(stream), ev.usage.output_tokens);
    }
  }

  /** Ends a turn: records usage, recovers from a failure if it can, and otherwise tells the chat the reply is done. */
  private async finishTurn(result?: SDKResultMessage) {
    const turn = this.turn;
    if (!turn || turn.settled) {
      return;
    }
    turn.settled = true;
    let handedOff = false;
    let reset = false;
    let failed = false;
    try {
      this.cards.cancelAll();
      if (result) {
        const fresh = this.usage.record(result, turn.provider, turn.provider === 'claude' && !this.claudeUsesApiKey, this.sessionId);
        this.meter.usage(fresh.tokens, fresh.cost);
      }
      failed = !turn.interrupted && !!(turn.error || result?.is_error);
      if (failed) {
        const outcome = await this.recoverFrom(turn, result);
        handedOff = outcome === 'handed';
        reset = outcome === 'reset';
      } else if (!turn.interrupted) {
        // Diagnoses about this provider's requests and the main agent's refusals: it works again.
        ['outage:', 'request:', 'unknown:', 'refusal:main:', 'dump:main'].forEach((k) => resolved(k));
      }
      if (!failed && result?.subtype === 'success' && !turn.producedOutput && this.sawThinking && !turn.thinkingRetried && !turn.interrupted) {
        // A known DeepSeek failure: the turn ends with thinking and no answer.
        this.post({ type: 'notice', level: 'info', text: 'The model only thought and gave no answer; asking it to answer.' });
        await this.startTurn({ ...newTurn(THINKING_ONLY_PROMPT, turn.provider, turn.effort, turn.fallbackUsed), thinkingRetried: true });
        handedOff = true;
      }
    } catch (err) {
      // Whatever went wrong, the chat must not stay busy.
      swallowed('Finishing the reply', err);
      this.post({ type: 'notice', level: 'error', text: `Something went wrong finishing the reply: ${errorMessage(err)}` });
    }
    if (handedOff || reset || this.turn !== turn) {
      if (handedOff) {
        this.pending.unshift(...this.unreadSteered(turn));
      }
      return;
    }
    this.turn = undefined;
    this.stopLive();
    let summary = PROVIDER_LABELS[turn.provider];
    let metrics: TurnMetrics | undefined;
    try {
      metrics = this.recordFinishedTurn(turn, failed, result);
      summary = summarize(turn.provider, turn.interrupted, result, turn.provider === 'deepseek' || this.claudeUsesApiKey, metrics);
    } catch (err) {
      // Bookkeeping must never keep the chat busy: the reply still ends below.
      swallowed('Recording the finished reply', err);
    }
    this.post({ type: 'done', summary, metrics });
    const background = this.tracker.helpersWorking();
    if (background && !turn.interrupted && !turn.implicit) {
      // The reply is over but work isn't: say so, or the chat looks idle while helpers run.
      this.post({ type: 'notice', level: 'info', text: `${background} helper${background === 1 ? ' is' : 's are'} still working in the background. The agent picks up each report when it arrives; you can keep sending messages.` });
    }
    this.releaseIdleWaiters();
    await this.updateNextProvider().catch((err) => swallowed('Choosing the next provider', err));
    if (failed) {
      this.pending.unshift(...this.unreadSteered(turn));
    }
    const queued = this.pending.shift();
    if (queued) {
      void this.send(queued);
    } else {
      // A planned switch (or an ended process): start the next model's process while the user reads.
      void this.prewarm();
    }
  }

  /** Metrics, signals, memory and the agents panel for a reply that ended. */
  /**
   * Messages steered into a failed turn that may never have been read: those
   * whose process was closed. While the process lives (a plain retry reuses
   * it) they're still in its queue, and sending them again would answer twice.
   */
  private unreadSteered(turn: Turn): SendRequest[] {
    return turn.steered && turn.steerInput !== this.input ? turn.steered : [];
  }

  private recordFinishedTurn(turn: Turn, failed: boolean, result?: SDKResultMessage): TurnMetrics {
    this.tracker.endTurn(turn.interrupted);
    this.postAgents(true);
    const style = efficiency();
    const metrics = this.meter.finish(
      {
        machine: this.usage.machine,
        session: this.sessionId,
        repo: repoKey(this.resolveCwd()),
        provider: turn.provider,
        model: modelFor(turn.provider, turn.effort),
        effort: turn.effort,
        lean: style.lean,
        replyStyle: style.replyStyle,
        outcome: turn.interrupted ? 'stopped' : failed ? 'error' : 'done',
        implicit: turn.implicit,
        wokenBy: turn.wokenBy,
        unverified: turn.unverified,
        firstOfProcess: this.turnsThisProcess === 0 || undefined,
        route: turn.implicit ? undefined : this.routeReason,
      },
      result,
    );
    this.usage.addTurn(metrics);
    const helperCost = metrics.turn ? (this.helperSpend.get(metrics.turn) ?? 0) : 0;
    if (metrics.turn) {
      this.helperSpend.delete(metrics.turn);
    }
    this.taskMeter.add(metrics, helperCost);
    this.updateSignals(metrics);
    this.warnCacheMiss(turn, metrics);
    this.turnsThisProcess++;
    if (turn.replyText) {
      this.lastReply = turn.replyText;
    }
    if (result?.subtype === 'success' && !turn.implicit && Object.keys(metrics.tools).length) {
      this.keepHandoff(this.resolveCwd(), `Asked: ${short(promptText(turn.prompt), 300)}\nResult: ${short(result.result, 1200)}`);
    }
    return metrics;
  }

  /** Project memory for a new conversation, after dropping notes about deleted files; a failure only logs. */
  private primer(cwd: string, prune = true): string | undefined {
    // A new conversation or a compaction starts the context over: notes about files may be shown again.
    this.shownNotes.clear();
    if (prune) {
      // A new conversation (not a compaction): nothing it holds came from the web yet.
      this.untrusted.clear();
      this.heldNoted = false;
    }
    try {
      if (prune) {
        pruneNotes(cwd);
      }
      return memoryOn() ? memoryPrimer(cwd) : undefined;
    } catch (err) {
      swallowed('Reading project memory', err);
      return undefined;
    }
  }

  /** The project's handoff note for the next session (agent/memory); a failed write only logs. */
  private keepHandoff(cwd: string, summary: string) {
    try {
      saveHandoff(cwd, summary);
    } catch (err) {
      swallowed('Saving project memory', err);
    }
  }

  /** The helpers' project brief, built once per agent process; a failure only logs. */
  private helperBrief(cwd: string): string | undefined {
    try {
      return memoryOn() ? helperBrief(cwd) : undefined;
    } catch (err) {
      swallowed('Reading the helpers\' project brief', err);
      return undefined;
    }
  }

  /**
   * Who made a notes_add call: a helper's note waits for its report. A call the
   * guard didn't see is treated as a helper's (pending, never confirmed), so a
   * missed lookup can't let a note skip the gate.
   */
  private noteAuthor(toolUseId: string | undefined): { by: 'main' | 'helper'; helper?: string; reply?: string } {
    const agent = toolUseId ? this.noteCalls.get(toolUseId) : undefined;
    if (toolUseId) {
      this.noteCalls.delete(toolUseId);
    }
    const by = agent === MAIN ? 'main' : 'helper';
    if (agent && this.untrusted.has(agent)) {
      // Memory is a known way to plant instructions: AgentPoison passed 80% with under 0.1% of memory poisoned.
      this.report({ kind: 'memory', level: 'info', code: 'held', agent });
      if (!this.heldNoted) {
        this.heldNoted = true;
        this.post({ type: 'notice', level: 'info', text: 'A project note was held back because this chat read web or tool content. It stays out of agents\' memory until you delete its "Pending: untrusted" line in .dual-agent/memory/notes.md.' });
      }
      return { by, helper: UNTRUSTED, reply: 'This conversation read web or tool content, so the note is kept as a proposal for the user to review.' };
    }
    if (agent === MAIN) {
      return { by: 'main' };
    }
    if (!agent) {
      swallowed('Telling who saved a note', new Error(`notes_add call ${toolUseId ?? '(no id)'} was not seen by the guard; kept as unconfirmed`));
    }
    return { by: 'helper', helper: agent ?? UNKNOWN_AGENT };
  }

  /** A helper's report checked out: its notes are shared. */
  private confirmHelperNotes(roots: string[], helper: string) {
    try {
      const confirmed = roots.reduce((n, root) => n + confirmNotes(root, helper), 0);
      if (confirmed) {
        this.report({ kind: 'memory', level: 'info', code: 'confirm', agent: helper, detail: `${confirmed} note${confirmed === 1 ? '' : 's'} confirmed` });
      }
    } catch (err) {
      swallowed('Confirming a helper\'s notes', err);
    }
  }

  /**
   * Whether a build or test must wait: another agent is running one in the
   * same repo, and two at once fight over build locks and caches (Gradle's
   * .gradle, shared output folders). Otherwise the repo it will hold.
   */
  private buildCheck(agent: string, input: Record<string, unknown> | undefined): { busy?: string; repo?: string } | undefined {
    const command = typeof input?.command === 'string' ? input.command : '';
    if (!command || input?.run_in_background === true || (!TEST_COMMAND.test(command) && !BUILD_COMMAND.test(command))) {
      return undefined;
    }
    const cwd = this.resolveCwd();
    const dir = commandCore(command).dir;
    const at = dir ? path.resolve(cwd, dir.replace(/^~(?=$|\/)/, os.homedir())) : cwd;
    const repo = repoRootOf(at) ?? at;
    const running = this.builds.get(repo);
    if (running && running.agent !== agent && Date.now() - running.at < BUILD_HOLD_MS) {
      return { busy: `Another agent is running \`${short(running.command, 80)}\` in this repo (${Math.round((Date.now() - running.at) / 1000)}s so far). Two builds at once fight over locks and caches: use its result when it reports, or say "not built" in your report. Don't retry this command in a loop.` };
    }
    // Held once the call is allowed (the guard's other checks may still refuse it).
    return { repo };
  }

  private releaseBuild(id: string) {
    for (const [repo, b] of this.builds) {
      if (b.id === id) {
        this.builds.delete(repo);
      }
    }
  }

  /** Tool calls in an assistant message, so each result's size is charged to the right tool and helper. */
  private noteToolCalls(content: unknown, helper?: string) {
    if (!Array.isArray(content)) {
      return;
    }
    for (const b of content as { type?: string; id?: string; name?: string; input?: unknown }[]) {
      if (b?.type === 'tool_use' && b.id && b.name) {
        this.toolCalls.set(b.id, { name: b.name, target: toolTarget(b.input), ...(helper ? { helper } : {}) });
      }
    }
  }

  /**
   * Tool results as the model reads them: their size per tool and helper, a
   * big_output row for one that alone fills a lot of context, and the end of
   * a helper that ran in the foreground (its result is its report).
   */
  private measureResults(content: unknown[]) {
    for (const b of content as { type?: string; tool_use_id?: string; content?: unknown }[]) {
      if (b?.type !== 'tool_result' || !b.tool_use_id) {
        continue;
      }
      const call = this.toolCalls.get(b.tool_use_id);
      this.toolCalls.delete(b.tool_use_id);
      const chars = resultChars(b.content);
      if (call) {
        this.meter.toolOutput(call.name, chars);
        if (call.helper) {
          this.helpers.tool(call.helper, call.name, chars);
        }
        if (chars >= BIG_OUTPUT_CHARS) {
          this.report({ kind: 'big_output', level: 'info', agent: call.helper ? (this.helpers.typeOf(call.helper) ?? 'helper') : 'main', code: call.name, target: call.target, detail: `${formatTokens(chars)} chars (~${formatTokens(Math.round(chars / 4))} tokens)` });
        }
      }
      if (call && SPAWN_TOOLS.has(call.name) && !this.helpers.isBackground(b.tool_use_id)) {
        this.endHelper(b.tool_use_id);
      }
    }
  }

  /** Writes a finished helper's row (metrics/helpers.ts); a failure only logs. */
  private endHelper(key: string, outcome?: HelperOutcome) {
    try {
      const row = this.helpers.end(key, (id) => this.usage.helperTotals(id), { machine: this.usage.machine, session: this.sessionId, repo: repoKey(this.resolveCwd()) }, outcome);
      if (row) {
        this.usage.addHelper(row);
        if (row.spawnTurn) {
          this.helperSpend.set(row.spawnTurn, (this.helperSpend.get(row.spawnTurn) ?? 0) + row.cost);
        }
      }
    } catch (err) {
      swallowed('Recording a helper\'s metrics', err);
    }
  }

  /** Writes the task in progress as a row (metrics/tasks.ts); a failure only logs. */
  private closeTask(how: TaskEnd) {
    try {
      const row = this.taskMeter.end(how);
      if (row) {
        this.taskLog?.append([row]);
      }
    } catch (err) {
      swallowed('Recording a task\'s metrics', err);
    }
  }

  /** A build or test command that just succeeded, kept for the helpers' brief; a failure only logs. */
  private keepCommand(command: string) {
    try {
      if (isCheckCommand(commandCore(command).run)) {
        recordCommand(this.resolveCwd(), command);
      }
    } catch (err) {
      swallowed('Recording a command in project memory', err);
    }
  }

  /**
   * The notes that cite a file an agent is about to read, once per agent and
   * file, for files big enough that a note can save reading most of them.
   * Added beside the read, never instead of it (claude-mem's read gate on small
   * files raised Opus tokens 20%).
   */
  private recallNotes(agent: string, file: unknown): string | undefined {
    if (typeof file !== 'string' || !memoryOn()) {
      return undefined;
    }
    try {
      const root = this.resolveCwd();
      const abs = path.resolve(root, file);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const key = `${agent}|${rel}`;
      if (rel.startsWith('..') || this.shownNotes.has(key) || fs.statSync(abs).size < RECALL_MIN_BYTES) {
        return undefined;
      }
      this.shownNotes.add(key);
      const notes = notesForFile(root, rel);
      if (notes) {
        this.report({ kind: 'memory', level: 'info', code: 'recall', agent, target: rel });
      }
      return notes;
    } catch {
      // A missing file: the Read reports it.
      return undefined;
    }
  }

  /**
   * After a failed turn: retry fresh, retry, or switch providers ('handed': a
   * new turn took over), else report the error (false). 'reset': the chat was
   * reset or closed meanwhile, so nothing carries over.
   */
  private async recoverFrom(turn: Turn, result?: SDKResultMessage): Promise<'handed' | 'reset' | false> {
    const detail = turn.errorText || resultErrorText(result);
    const code = this.netCode(errorCode(turn.error, detail), turn.provider);
    const status = statusIn(detail);
    const plan = recover({ ...turn, code, retries: turn.retries ?? 0 }, await this.canFailOverTo(otherProvider(turn.provider)));
    if (this.turn !== turn) {
      // Reset while checking the other provider.
      return 'reset';
    }
    if (turn.interrupted) {
      return false;
    }
    const failover = (action: string) => this.report({ kind: 'failover', provider: turn.provider, model: modelFor(turn.provider, turn.effort), code, status, detail, action });
    if (turn.implicit) {
      // Claude Code's own turn (a helper's report): retrying would answer an earlier message again.
      failover('reported (background turn)');
      this.post({ type: 'notice', level: 'warn', text: `${PROVIDER_LABELS[turn.provider]} failed while reporting a helper's result (${describeError(code)}).` });
      return false;
    }
    const original = turn.original ?? turn.prompt;
    // The message is in the conversation once already when it reached the model: resending it would duplicate it.
    const again = (continuing: boolean, prompt: UserContent) => ({ prompt: continuing ? prompt : turn.reachedModel ? ANSWER_PROMPT : turn.prompt, original });
    if (turn.provider === 'claude' && code === 'authentication_failed' && !this.claudeUsesApiKey) {
      failover('paused for sign-in');
      const resumed = await this.resumeAfterSignIn(turn, again(turn.producedOutput, RETRY_PROMPT));
      if (resumed !== undefined) {
        return resumed ? (this.turn && this.turn !== turn ? 'handed' : 'reset') : false;
      }
    }
    if (plan.kind === 'freshRetry') {
      failover('fresh retry');
      this.post({ type: 'notice', level: 'warn', text: `${PROVIDER_LABELS[turn.provider]} couldn't read the earlier conversation, so this message starts a new one.` });
      await this.startTurn({ ...newTurn(original, turn.provider, turn.effort, turn.fallbackUsed), freshRetryUsed: true }, true);
      return 'handed';
    }
    const why = describeError(code);
    if (plan.kind === 'retry') {
      const delay = this.retryDelays[plan.attempt - 1] ?? this.retryDelays.at(-1) ?? 0;
      failover(`retry ${plan.attempt}/${MAX_RETRIES}`);
      this.post({
        type: 'notice',
        level: 'warn',
        quiet: true,
        text: `${PROVIDER_LABELS[turn.provider]} failed (${detail ? `${code === 'unknown' ? '' : `${why}: `}${short(detail, 140)}` : why}). Retrying (${plan.attempt}/${MAX_RETRIES})${delay >= 1000 ? ` in ${Math.round(delay / 1000)}s` : ''}…`,
      });
      this.setActivity(`Retrying ${PROVIDER_LABELS[turn.provider]} (${plan.attempt}/${MAX_RETRIES})`, true);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.turn !== turn || this.disposed) {
        return 'reset';
      }
      if (turn.interrupted) {
        return false;
      }
      await this.startTurn({ ...newTurn('', turn.provider, turn.effort, turn.fallbackUsed), ...again(plan.continuing, RETRY_PROMPT), freshRetryUsed: turn.freshRetryUsed, retries: plan.attempt });
      return 'handed';
    }
    if (plan.kind === 'switch') {
      this.meter.fallback();
      this.blockedUntil[turn.provider] = pauseUntil(turn.resetsAt, settings().get<number>('fallbackCooldownMinutes') ?? 30);
      const tried = turn.retries ? ` after ${turn.retries} ${turn.retries === 1 ? 'retry' : 'retries'}` : '';
      const text = `${PROVIDER_LABELS[turn.provider]} failed${tried} (${why}). Switching to ${PROVIDER_LABELS[plan.to]}.`;
      failover(`switch to ${PROVIDER_LABELS[plan.to]}${tried}`);
      this.post({ type: 'notice', level: 'warn', quiet: true, text });
      await this.startTurn({ ...newTurn('', plan.to, effortFor(plan.to), true), ...again(plan.continuing, CONTINUE_PROMPT) });
      return 'handed';
    }
    const reason = code === 'unknown' && detail ? detail : `${why}${detail ? `. ${detail}` : ''}`;
    failover('reported to the user');
    this.post({ type: 'notice', level: 'error', text: `${PROVIDER_LABELS[turn.provider]} failed: ${reason}${hint(turn.provider, code)}`, diagnose: true });
    return false;
  }

  /**
   * Claude refused the sign-in mid-reply: pause and offer to sign in, then
   * continue the message on Claude. True: continued (or the chat moved on);
   * false: stopped; undefined: recover as usual (e.g. on DeepSeek).
   */
  private async resumeAfterSignIn(turn: Turn, next: { prompt: UserContent; original: UserContent }): Promise<boolean | undefined> {
    this.claudeSignedIn = false;
    this.claudeStatus = 'Sign-in expired';
    this.emitState();
    this.setActivity('Paused: sign in to Claude to continue');
    const deepseek = await this.isConfigured('deepseek');
    const pick = await this.cards.choose("Claude's sign-in has expired, so this reply is paused. Sign in and continue on Claude?", 'Claude', [
      { label: SIGN_IN, description: 'Opens the Claude sign-in in a terminal; the reply continues on Claude once you are signed in.' },
      ...(deepseek ? [{ label: 'Continue on DeepSeek', description: 'Carry on with this reply on DeepSeek now.' }] : []),
    ]);
    const settled = () => (this.turn !== turn ? true : turn.interrupted ? false : undefined);
    if (settled() !== undefined || pick !== SIGN_IN) {
      return settled();
    }
    // Not a stall: the user is signing in.
    this.setActivity('Waiting for the Claude sign-in', true);
    const ok = await this.signInAndCheck();
    if (settled() !== undefined) {
      return settled();
    }
    if (!ok) {
      this.post({ type: 'notice', level: 'warn', text: 'Claude still refuses the sign-in.' });
      return undefined;
    }
    this.post({ type: 'notice', level: 'info', text: 'Signed in to Claude: continuing the reply.' });
    // The old process still holds the refused token.
    this.closeQuery();
    await this.startTurn({ ...newTurn('', 'claude', turn.effort, turn.fallbackUsed), ...next, retries: turn.retries });
    return true;
  }

  /** Stops Claude Code's own retries when waiting won't help or the other provider is the better bet. */
  private async maybeStopRetrying(code: string, attempt: number, outage = false) {
    const turn = this.turn;
    if (!turn || turn.error) {
      return;
    }
    const canSwitch = !turn.fallbackUsed && (await this.canFailOverTo(otherProvider(turn.provider)));
    if (!stopRetrying(code, attempt, canSwitch) || this.turn !== turn || turn.error) {
      return;
    }
    turn.error = code;
    turn.errorText ??= `Claude Code was still retrying (attempt ${attempt})`;
    if (outage) {
      this.post({ type: 'notice', level: 'info', text: `Diagnosed: ${PROVIDER_LABELS[turn.provider]} is failing in other chats too (an outage), so this one switches now.` });
    }
    // An API call was made, so the prompt is in the transcript.
    turn.reachedModel = true;
    this.report({ kind: 'failover', code, detail: turn.errorText, action: 'stopped Claude Code retrying' });
    if (attempt >= MAX_RETRIES) {
      // Claude Code has already retried this outage: switch rather than retry again.
      turn.retries = MAX_RETRIES;
    }
    this.closeQuery();
    await this.finishTurn();
  }

  /** Before a tool runs: loops and shell file dumps are refused with a reason the agent can act on. */
  private guardTool(h: HookInput): HookJSONOutput | Promise<HookJSONOutput> {
    if (h.hook_event_name !== 'PreToolUse') {
      return {};
    }
    const input = h.tool_input as Record<string, unknown> | undefined;
    if (EDIT_TOOLS.includes(h.tool_name) && typeof input?.file_path === 'string') {
      this.errorsBefore.set(input.file_path, errorSnapshot(input.file_path));
    }
    if (SPAWN_TOOLS.has(h.tool_name) && !h.agent_id) {
      return this.scopeBrief(h.tool_use_id, input ?? {});
    }
    if (h.tool_name === NOTES_ADD) {
      this.noteCalls.set(h.tool_use_id, h.agent_id ?? MAIN);
    }
    const build = h.tool_name === 'Bash' ? this.buildCheck(h.agent_id ?? MAIN, input) : undefined;
    const busy = build?.busy;
    if (busy) {
      const row = this.report({ kind: 'refusal', agent: h.agent_id ?? MAIN, code: 'Bash', detail: busy, target: toolTarget(input) });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: this.firmer(row, busy, h.agent_type) } };
    }
    const scope = h.agent_id ? this.agentScopes.get(h.agent_id) : undefined;
    if (!scope) {
      return this.guardCall(h, input, build);
    }
    // Asks git about output folders without blocking the extension thread.
    return scopeViolationAsync(scope, this.resolveCwd(), h.tool_name, input).then((outOfScope) => {
      if (!outOfScope) {
        return this.guardCall(h, input, build);
      }
      const row = this.report({ kind: 'refusal', agent: h.agent_id, code: h.tool_name, detail: outOfScope, target: toolTarget(input) });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: this.firmer(row, outOfScope, h.agent_type) } };
    });
  }

  /** guardTool after the scope check: shell file dumps and loops are refused; a Read gets its notes. */
  private guardCall(h: HookInput & { hook_event_name: 'PreToolUse' }, input: Record<string, unknown> | undefined, build: ReturnType<AgentController['buildCheck']>): HookJSONOutput {
    const dump = h.tool_name === 'Bash' && typeof input?.command === 'string' ? fileDumpReason(input.command) : undefined;
    const verdict = dump ? {} : this.loops.check(h.agent_id ?? 'main', h.tool_name, input);
    /** The call goes ahead: a build holds its repo until it ends. */
    const allowed = () => build?.repo && this.builds.set(build.repo, { agent: h.agent_id ?? MAIN, id: h.tool_use_id, command: String(input?.command), at: Date.now() });
    if (verdict.nudge) {
      allowed();
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: verdict.nudge } };
    }
    const reason = dump ?? verdict.deny;
    if (!reason) {
      allowed();
      const recall = h.tool_name === 'Read' ? this.recallNotes(h.agent_id ?? 'main', input?.file_path) : undefined;
      return recall ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: recall } } : {};
    }
    const row = this.report({ kind: 'refusal', agent: h.agent_id ?? 'main', code: h.tool_name, detail: reason, target: toolTarget(input) });
    const firm = this.firmer(row, reason, h.agent_type);
    if (verdict.deny) {
      this.post({ type: 'notice', level: 'warn', text: `Stopped a loop: ${h.agent_type ? `the ${h.agent_type} helper` : 'the agent'} repeated the same ${h.tool_name} call. It was told to change approach or report.` });
      if (!h.agent_id && this.turn) {
        // A loop is trouble: auto mode may move to a stronger model; a third one ends the reply so you can redirect it.
        this.countMainFailure(undefined, 'loop');
        this.turn.loopDenials = (this.turn.loopDenials ?? 0) + 1;
        if (this.turn.loopDenials >= 3) {
          this.post({ type: 'notice', level: 'warn', text: 'The agent kept repeating calls that were refused, so this reply stopped. Tell it what to try next.' });
          void this.stop();
        }
      }
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: firm } };
  }

  /** D1: the same call was refused before; the reason says so plainly, and the chat hears about it once. */
  private firmer(row: DiagRow, reason: string, agentType?: string): string {
    const d = diagnosisOf(row);
    if (d?.rule !== 'D1') {
      return reason;
    }
    const times = recentDiag(10 * 60_000).filter((r) => r.kind === 'refusal' && r.agent === row.agent && r.target === row.target).length;
    if (times === 2) {
      this.post({ type: 'notice', level: 'info', text: `Diagnosed: ${agentType ? `the ${agentType} helper` : 'the agent'} repeated a refused ${row.code} call; it was told to stop and report instead.` });
    }
    return `${reason} This exact call has now been refused ${times} times: do not try it again in any form. Finish what you can and say in your report what needs changing.`;
  }

  /**
   * A helper is only started with a declared scope (files it may edit, files to
   * read first); the brief gets a footer saying so and asking for a short
   * report, and its edits are held to the scope.
   */
  private scopeBrief(toolUseId: string, input: Record<string, unknown>): HookJSONOutput {
    const brief = typeof input.prompt === 'string' ? input.prompt : '';
    // No "Edit only:" line: the files the brief names become the scope, rather than a refusal and a rewrite.
    const scope = parseScope(brief, this.resolveCwd()) ?? inferScope(brief, this.resolveCwd());
    if (!scope) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: missingScopeReason(input)! } };
    }
    this.briefScopes.set(toolUseId, scope);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, prompt: `${brief}${scopeFooter(scope)}` } } };
  }

  /** A reply that runs this many main-loop steps is stopped as a likely loop (dualAgent.maxStepsPerTurn, 0 = no limit). */
  private stopRunaway(turn: Turn) {
    const max = settings().get<number>('maxStepsPerTurn') ?? 150;
    if (max > 0 && this.meter.calls >= max && !turn.interrupted) {
      this.post({ type: 'notice', level: 'warn', text: `Stopped after ${max} steps in one reply: it's likely going in circles. Send a message to continue or redirect it.` });
      void this.stop();
    }
  }

  /** Times and sizes every finished tool call, records it as evidence, and flags failures a pipe hid. */
  private measureTool(h: HookInput): HookJSONOutput | void {
    try {
      return this.afterTool(h);
    } catch (err) {
      // A hook that throws loses only its own bookkeeping, never the tool's result.
      swallowed(`After-tool hook (${'tool_name' in h ? h.tool_name : h.hook_event_name})`, err);
      return undefined;
    }
  }

  private afterTool(h: HookInput): HookJSONOutput | void {
    let note: string | undefined;
    if (h.hook_event_name === 'PostToolUse' || h.hook_event_name === 'PostToolUseFailure') {
      this.releaseBuild(h.tool_use_id);
      if (isExternalTool(h.tool_name)) {
        this.untrusted.add(h.agent_id ?? MAIN);
      }
    }
    if (h.hook_event_name === 'PostToolUse' || (h.hook_event_name === 'PostToolUseFailure' && !h.is_interrupt)) {
      const key = h.agent_id ?? 'main';
      const ev = this.evidence.get(key) ?? newEvidence();
      this.evidence.set(key, ev);
      const input = h.tool_input as Record<string, unknown> | undefined;
      const hidden = h.hook_event_name === 'PostToolUse' && h.tool_name === 'Bash' ? failureIn(outputText(h.tool_response)) : undefined;
      const ok = h.hook_event_name === 'PostToolUse' && !hidden;
      recordTool(ev, h.tool_name, input, ok);
      if (ok && h.tool_name === 'Bash' && typeof input?.command === 'string' && (TEST_COMMAND.test(input.command) || BUILD_COMMAND.test(input.command))) {
        this.keepCommand(input.command);
      }
      if (ok && h.tool_name === 'Bash' && typeof input?.command === 'string') {
        // Files written through the shell (echo >> .gitignore) count as edits too, in or out of git; a test run's log file doesn't.
        const written = shellWrites(input.command, this.resolveCwd());
        written.forEach((f) => ev.edited.add(f));
        if (written.length && !TEST_COMMAND.test(input.command) && !BUILD_COMMAND.test(input.command)) {
          ev.sinceEdit = [];
          // The files changed, so repeating an earlier check is progress, as after an Edit.
          this.loops.forget(h.agent_id ?? 'main');
        }
      }
      this.noteRepos(h.tool_name, input);
      const result = h.hook_event_name === 'PostToolUse' ? h.tool_response : h.error;
      this.loops.result(key, h.tool_name, input, ok, resultHash(outputText(result) || textOf(result)));
      const file = typeof input?.file_path === 'string' ? input.file_path : undefined;
      if (ok && file && EDIT_TOOLS.includes(h.tool_name)) {
        this.editedFiles.add(file);
      }
      if (hidden) {
        note = `The command exited 0 but its output shows a failure: "${hidden}". A pipe (| tail, | grep, | head) hides the exit code. Treat it as failed: fix the cause or report it; don't call it passing.`;
      } else if (h.hook_event_name === 'PostToolUseFailure' && h.tool_name === 'Bash') {
        note = "That command failed. Don't continue as if it worked: read the error, fix the cause, or report it.";
      }
    }
    if (h.hook_event_name === 'PostToolUse') {
      const file = (h.tool_input as { file_path?: unknown } | undefined)?.file_path;
      if (EDIT_TOOLS.includes(h.tool_name) && typeof file === 'string') {
        markSeen(this.seenFiles, file);
      }
      // Output size is counted from the tool result the model reads (measureResults); tool_response holds more (Edit's whole file).
      this.meter.tool(h.tool_name, h.duration_ms ?? 0, 0, true);
      resolved(`tool:${bareTool(h.tool_name)}`);
    } else if (h.hook_event_name === 'PostToolUseFailure' && !h.is_interrupt) {
      this.meter.tool(h.tool_name, h.duration_ms ?? 0, 0, false);
      this.report({ kind: 'tool_error', agent: h.agent_id ?? 'main', code: h.tool_name, detail: h.error, target: toolTarget(h.tool_input) });
      this.countMainFailure(h.agent_id, h.tool_name);
    }
    if (h.hook_event_name === 'PostToolUseFailure') {
      return note ? { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: note } } : undefined;
    }
    if (h.hook_event_name !== 'PostToolUse') {
      return undefined;
    }
    if (note) {
      // A hidden failure counts toward escalating, like one the exit code showed.
      this.countMainFailure(h.agent_id, h.tool_name);
    }
    const notes = [note, this.budgetNote(h.agent_id), this.outlineNote(h)].filter(Boolean).join('\n');
    const trimmed = this.trim(h);
    if (!notes && !trimmed) {
      return undefined;
    }
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', ...(notes ? { additionalContext: notes } : {}), ...(trimmed ? { updatedToolOutput: trimmed } : {}) } };
  }

  /** Long or noisy tool output cut before the model sees it (test runs to failures; the rest saved to a file). */
  private trim(h: Extract<HookInput, { hook_event_name: 'PostToolUse' }>): unknown {
    if (settings().get<boolean>('trimToolOutput') === false) {
      return undefined;
    }
    const cwd = this.resolveCwd();
    if (cwd === os.homedir()) {
      // No .dual-agent folder in the home folder; output is still condensed, just not saved.
      return undefined;
    }
    if (this.spillFailed) {
      return undefined;
    }
    try {
      if (!this.spillDir) {
        this.spillDir = workFolder(cwd, 'outputs');
        pruneSpill(this.spillDir, SPILL_MAX_AGE_MS);
      }
    } catch (err) {
      // Once per process: every tool call would otherwise try (and fail) again.
      this.spillFailed = true;
      swallowed('Creating the tool-output folder (outputs are no longer trimmed)', err);
      return undefined;
    }
    const r = trimToolOutput(h.tool_name, h.tool_input as Record<string, unknown> | undefined, h.tool_response, { spillDir: this.spillDir });
    if (!r) {
      return undefined;
    }
    this.meter.trim(r.savedChars);
    return r.output;
  }

  /** "N steps left" near the usual budget for a finished reply here, once per reply (main agent only). */
  private budgetNote(agentId: string | undefined): string | undefined {
    const turn = this.turn;
    const budget = this.stepBudget;
    if (agentId || !turn || !budget || turn.budgetWarned || this.meter.calls < budget - 5) {
      return undefined;
    }
    turn.budgetWarned = true;
    return `About ${Math.max(1, budget - this.meter.calls)} steps left of this reply's usual budget (${budget} steps). Wrap up: finish the current change, verify it, and report what's done and what's left.`;
  }

  /** A whole long file was read: next time outline it and read a range. Once per file. */
  private outlineNote(h: Extract<HookInput, { hook_event_name: 'PostToolUse' }>): string | undefined {
    const input = h.tool_input as { file_path?: string; offset?: number; limit?: number } | undefined;
    const total = (h.tool_response as { file?: { totalLines?: number } } | undefined)?.file?.totalLines;
    if (h.tool_name !== 'Read' || !input?.file_path || input.offset !== undefined || input.limit !== undefined || !total || total <= LONG_FILE_LINES || this.outlinedHints.has(input.file_path)) {
      return undefined;
    }
    this.outlinedHints.add(input.file_path);
    return `That file has ${total} lines. Next time use code_outline first and Read only the range you need (offset/limit).`;
  }

  /** What the code map ranks first: the files changed in this chat and the user's recent words. */
  private focus(): { files: string[]; words: string[] } {
    const words = this.recentPrompts.join(' ').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
    return { files: [...this.editedFiles], words: [...new Set(words)] };
  }

  /** A reply that re-read most of a large context at full price: say so, since a switch or a long pause caused it. */
  private warnCacheMiss(turn: Turn, m: TurnMetrics) {
    const input = inputSide(m.tokens);
    if (turn.implicit || this.turnsThisProcess === 0 || input < 50_000 || m.tokens.cacheRead / input >= 0.5) {
      return;
    }
    const missed = Math.round((input - m.tokens.cacheRead) / 1000);
    this.post({ type: 'notice', level: 'info', text: `Cache miss: ${missed}k tokens were read at full price this reply. Model switches, pauses over 5 minutes and changed settings drop the cache.` });
  }

  private countMainFailure(agentId: string | undefined, tool: string) {
    if (agentId) {
      return;
    }
    this.mainFailures[tool] = (this.mainFailures[tool] ?? 0) + 1;
    if (this.turn) {
      void this.maybeEscalate(this.turn);
    }
  }

  /** Remembers repos outside the workspace that a tool call wrote to. */
  private noteRepos(tool: string, input: Record<string, unknown> | undefined) {
    const cwd = this.resolveCwd();
    const file = input?.file_path ?? input?.notebook_path;
    const files = typeof file === 'string' ? [file] : tool === 'Bash' && typeof input?.command === 'string' ? shellWrites(input.command, cwd) : [];
    for (const f of files) {
      const root = repoRootOf(path.dirname(path.resolve(cwd, f)));
      if (root && root !== cwd) {
        this.workedRepos.add(root);
      }
    }
  }

  /**
   * The main agent or a helper is about to stop: if its report claims tests,
   * builds, file changes or finished to-dos its work doesn't show, it's sent
   * back once; if it still doesn't match, the chat says what's unverified.
   */
  private async checkClaims(cwd: string, h: HookInput): Promise<HookJSONOutput> {
    if (h.hook_event_name !== 'Stop' && h.hook_event_name !== 'SubagentStop') {
      return {};
    }
    const helper = h.hook_event_name === 'SubagentStop';
    const key = helper ? h.agent_id : 'main';
    if (helper && !h.agent_type) {
      // Claude Code's own side agents (e.g. summaries of background work) have no type, tools or transcript:
      // their text repeats a helper's claims, so checking it only sent them back for nothing (6 times on 2026-10-19).
      this.evidence.delete(key);
      return {};
    }
    if (!helper && this.turn?.implicit) {
      // A turn Claude Code started to take a helper's report: the helper's own report was checked already.
      return {};
    }
    const ev = this.evidence.get(key) ?? newEvidence();
    let sentBack = false;
    try {
      const { contradictions, unverified } = checkReport(h.last_assistant_message ?? '', ev, await gitChangedAcross([cwd, ...this.workedRepos]));
      const report = h.last_assistant_message?.length ?? 0;
      if (helper && report > MAX_REPORT_CHARS) {
        // Logged, not sent back: a rewrite costs a helper call with ~1.5k output tokens, more than the
        // parent saves by reading a shorter report from cache. The brief already asks for ~1,500 tokens.
        this.report({ kind: 'claims', agent: key, target: h.agent_type, detail: `long report: ${Math.round(report / 4)} tokens` });
      }
      if (unverified.length) {
        // Not sent back: the reply's summary line says "not verified", and the log keeps why.
        this.report({ kind: 'claims', agent: key, detail: `unverified: ${unverified.join('; ')}`, target: helper ? h.agent_type : undefined });
        if (!helper && this.turn) {
          this.turn.unverified = true;
        }
      }
      // A note is confirmed by an outcome, not by a report that claims nothing: a build or test passed since its last edit.
      const checked = ev.sinceEdit.some((c) => c.ok);
      if (helper) {
        const outcome: HelperOutcome = contradictions.length ? 'contradicted' : unverified.length ? 'unverified' : checked ? 'checked' : 'unchecked';
        this.helpers.outcome(key, outcome, report);
      }
      if (helper && !contradictions.length && !unverified.length && checked) {
        this.confirmHelperNotes([cwd, ...this.workedRepos], key);
      }
      const checkText = helper ? undefined : await this.autoChecks(cwd, ev);
      if (checkText) {
        sentBack = true;
      }
      if (!contradictions.length && !checkText) {
        return {};
      }
      if (!contradictions.length) {
        this.post({ type: 'notice', level: 'info', text: 'Project checks failed after the edits. Sent the agent back to fix them.' });
        return { decision: 'block', reason: sendBackReason([], checkText) };
      }
      const who = helper ? `The ${h.agent_type} helper` : 'The agent';
      this.report({ kind: 'claims', agent: key, detail: contradictions.join('; '), target: helper ? h.agent_type : undefined });
      if (!h.stop_hook_active) {
        this.post({ type: 'notice', level: 'info', text: `${who}'s report contradicts its work (${contradictions.join('; ')}). Sent it back to fix or correct it.` });
        sentBack = true;
        return { decision: 'block', reason: sendBackReason([...contradictions, ...unverified], checkText) };
      }
      if (checkText) {
        return { decision: 'block', reason: sendBackReason([], checkText) };
      }
      this.post({ type: 'notice', level: 'warn', text: `Check this: ${who.toLowerCase()}'s report still contradicts its work: ${contradictions.join('; ')}.` });
      if (!helper && this.turn) {
        this.turn.unverified = true;
      }
      return {};
    } catch (err) {
      swallowed('Claims check', err);
      return {};
    } finally {
      if (helper) {
        // The parent reports the helper's work as its own: count it as the parent's evidence.
        const main = this.evidence.get('main') ?? newEvidence();
        this.evidence.set('main', main);
        mergeEvidence(main, ev);
      }
      resetEvidence(ev);
      if (helper && !sentBack) {
        // The helper is done: forget its evidence, scope and loop history.
        this.evidence.delete(key);
        this.agentScopes.delete(key);
        this.loops.forget(key);
      }
    }
  }

  /**
   * Runs the project's checks after the main agent edited files (autoCheck.ts).
   * Returns the send-back text for a new failure; otherwise says in the chat
   * what stayed unverified and marks the turn.
   */
  private async autoChecks(cwd: string, ev: Evidence): Promise<string | undefined> {
    const cfg = autoCheckConfig();
    if (cfg.mode === 'off' || !ev.edited.size) {
      return undefined;
    }
    const results = await runAutoChecks(cwd, loadProjectConventions(cwd, memoryOn()), ev, cfg);
    const sends = this.turn?.checkSends ?? [];
    const text = sendBackText(results, sends);
    const notice = unverifiedNotice(results, text !== undefined);
    if (this.turn) {
      this.turn.checkSends = sends;
    }
    if (notice) {
      this.post({ type: 'notice', level: 'warn', text: notice });
      if (this.turn) {
        this.turn.unverified = true;
      }
      this.report({ kind: 'claims', agent: MAIN, detail: notice });
    }
    return text;
  }

  private async editFeedback(cwd: string, h: HookInput): Promise<HookJSONOutput> {
    if (h.hook_event_name !== 'PostToolUse') {
      return {};
    }
    try {
      const input = (h.tool_input ?? {}) as EditInput;
      const file = input.file_path;
      const before = file ? this.errorsBefore.get(file) : undefined;
      if (file) {
        this.errorsBefore.delete(file);
      }
      const notes = await Promise.all([
        checkEdit(cwd, h.tool_name, input, this.reportedDuplicates),
        file ? newErrors(cwd, file, before) : undefined,
      ]);
      const [reuse, errors] = notes;
      const agent = h.agent_id ?? 'main';
      // What the checks found, per edit: how often edits duplicate code or break the build is data for later.
      if (reuse) {
        this.report({ kind: 'edit_check', level: 'warn', agent, code: 'reuse_or_comments', target: file, detail: reuse });
      }
      if (errors) {
        this.report({ kind: 'edit_check', level: 'warn', agent, code: 'new_errors', target: file, detail: errors });
      }
      const note = notes.filter(Boolean).join('\n\n');
      if (note) {
        this.log.appendLine(`Edit check: ${note}`);
        return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } };
      }
    } catch (err) {
      swallowed('Edit check', err);
    }
    return {};
  }

  /** One model call's tokens under the agent that made it, for the usage graph. */
  private recordCall(agent: string, message: { id?: string; model?: string; usage?: ApiUsage | null }, helper?: string) {
    if (!message.usage || !this.activeProvider) {
      return;
    }
    const provider = providerOfModel(message.model, this.activeProvider);
    const billing = provider === 'claude' && !this.claudeUsesApiKey ? 'subscription' : 'api';
    const model = message.model || modelFor(provider, this.activeEffort ?? effortFor(provider)) || provider;
    const turn = this.turn ? this.meter.id : undefined;
    // A background helper's calls come between replies: they're charged to the reply that launched it.
    const spawnTurn = helper && !turn ? this.helpers.spawnTurnOf(helper) : undefined;
    this.usage.call(message.id, { session: this.sessionId, provider, agent, turn, ...(helper ? { helper } : {}), ...(spawnTurn ? { spawnTurn } : {}), model, billing }, message.usage);
    this.enforceLimits(model);
  }

  /** A permission, question or plan card: the agent that asked shows as blocked until it's answered. */
  private async askUser(...[toolName, toolInput, opts]: Parameters<CanUseTool>) {
    if (toolName === 'Bash' && this.permissionMode === 'default' && settings().get<boolean>('autoApproveReadOnly') !== false && typeof toolInput.command === 'string' && isReadOnlyCommand(toolInput.command, this.resolveCwd())) {
      // Reading commands (git status/diff/log, ls, rg…) need no card: each one was a wait for nothing.
      return { behavior: 'allow' as const, updatedInput: toolInput };
    }
    this.tracker.setBlocked(opts.toolUseID, true);
    this.postAgents(true);
    const asked = Date.now();
    try {
      return await this.cards.ask(toolName, toolInput, opts);
    } finally {
      this.meter.blocked(Date.now() - asked);
      this.tracker.setBlocked(opts.toolUseID, false);
      this.postAgents();
    }
  }

  private setActivity(what: string, inTool = false) {
    if (what !== this.activity.what) {
      this.activity = { what, since: Date.now(), inTool };
    }
  }

  /**
   * The live status line: what the main agent is doing and for how long, how
   * many helpers work, and whether the model has gone silent (stalled) rather
   * than a long tool or a card waiting on the user.
   */
  private postActivity() {
    if (!this.turn) {
      return;
    }
    const now = Date.now();
    const secs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
    if (this.tracker.markStalled(now, STALL_MS)) {
      this.postAgents();
    }
    const helpers = this.tracker.helpersWorking();
    const waiting = this.cards.waiting;
    const silent = now - this.lastEventAt;
    const stalled = !waiting && !this.activity.inTool && silent > STALL_MS;
    const parts = [waiting ? 'Waiting for your answer' : `${this.activity.what} · ${secs(now - this.activity.since)}`];
    if (helpers) {
      parts.push(`${helpers} helper${helpers === 1 ? '' : 's'} working`);
    }
    if (stalled) {
      parts.push(`no response for ${secs(silent)}`);
      if (!this.stallReported) {
        this.stallReported = true;
        this.post({ type: 'notice', level: 'warn', quiet: true, text: `${this.label()} hasn't responded for ${secs(silent)}. It may be stuck: press Stop and send again, or keep waiting.` });
      }
    }
    this.post({ type: 'activity', text: parts.join(' · '), stalled });
  }

  private stopLive() {
    clearInterval(this.liveTimer);
    this.liveTimer = undefined;
  }

  /** Sends the streamed text collected since the last batch. */
  private flushDelta() {
    clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    if (this.deltaText) {
      const text = this.deltaText;
      this.deltaText = '';
      this.postRaw({ type: 'delta', text });
    }
  }

  /**
   * The supervisor: while anything works, checks every SUPERVISE_MS that each
   * agent shown working really is, and says so in the chat and the agents pill
   * when one went silent or crashed without reporting back.
   */
  private supervise() {
    if (this.disposed || (!this.busy && !this.tracker.helpersWorking())) {
      clearInterval(this.superviseTimer);
      this.superviseTimer = undefined;
      return;
    }
    const { lost, stuck } = this.tracker.supervise(Date.now(), STALL_MS, LOST_MS, HELPER_STUCK_MS);
    const name = (a: AgentInfo) => a.label || a.description || a.name;
    for (const a of lost) {
      this.endHelper(a.taskId!, 'stopped');
      this.post({ type: 'notice', level: 'error', text: `Helper "${name(a)}" stopped without reporting back; its work may be unfinished. Ask the agent for a status check, or to redo it.` });
    }
    for (const a of stuck) {
      this.post({ type: 'notice', level: 'warn', text: `Helper "${name(a)}" has shown no activity for ${Math.round(HELPER_STUCK_MS / 60_000)} minutes. It may be on a long command, or stuck: stop it from the agents panel if it doesn't move.` });
    }
    this.postAgents();
  }

  /** Tells the chat about the agents when they changed; bursts of updates are sent at most every 150 ms. */
  private postAgents(now = false) {
    if (this.busy || this.tracker.helpersWorking()) {
      this.superviseTimer ??= setInterval(() => this.supervise(), SUPERVISE_MS);
    }
    const send = () => {
      const snapshot = this.tracker.snapshot();
      const json = JSON.stringify(snapshot);
      if (json !== this.agentsSent) {
        this.agentsSent = json;
        this.post({ type: 'agents', ...snapshot });
      }
    };
    if (now) {
      clearTimeout(this.agentsTimer);
      this.agentsTimer = undefined;
      send();
      return;
    }
    this.agentsTimer ??= setTimeout(() => {
      this.agentsTimer = undefined;
      send();
    }, 150);
  }

  private closeQuery() {
    if (this.query) {
      this.tracker.stopHelpers();
      this.postAgents();
    }
    this.launchGeneration++;
    clearTimeout(this.spare?.timer);
    this.spare = undefined;
    this.cards.cancelAll();
    this.input?.close();
    this.query?.close();
    this.query = undefined;
    this.input = undefined;
    this.activeProvider = undefined;
    this.activeEffort = undefined;
    this.launchKey = undefined;
  }

  /**
   * Requests timing out on the way to the provider look like an agent that is
   * working but doing nothing (2026-10-19: 14 ETIMEDOUTs to api.anthropic.com
   * in 3 minutes, unseen). Says so in the chat, at most every 2 minutes.
   */
  private watchNetwork(row: DiagRow) {
    // Only model calls hold off failover: a failed heartbeat or telemetry post says little about the provider.
    if (row.kind === 'proxy' && !row.background && /^\S+ \/v1\/messages(\?\S*)? -> upstream error/.test(row.detail ?? '')) {
      this.netFailAt[row.provider === PROVIDER_LABELS.claude ? 'claude' : 'deepseek'] = Date.now();
    }
    if (row.kind !== 'proxy' || !this.activeProvider || row.provider !== PROVIDER_LABELS[this.activeProvider] || Date.now() - this.networkNoticeAt < 120_000) {
      return;
    }
    const working = this.busy || this.tracker.helpersWorking() > 0;
    const why = /upstream error (\S+)/.exec(row.detail ?? '')?.[1] ?? (row.status && row.status >= 500 ? `HTTP ${row.status}` : undefined);
    if (!working || !why) {
      return;
    }
    this.networkNoticeAt = Date.now();
    this.post({ type: 'notice', level: 'warn', quiet: true, text: `Network: requests to ${row.target ?? PROVIDER_LABELS[this.activeProvider]} are failing (${why}). They are retried automatically; the agent isn't stuck. If this goes on, check your connection.` });
  }

  /**
   * The Diagnose button: the agent gets this chat's recent failure rows (and
   * tool and proxy rows logged meanwhile) and explains the cause.
   */
  async diagnose() {
    const session = this.sessionId;
    const rows = recentDiag(30 * 60_000).filter((r) => (session && r.session === session) || (!r.session && (r.kind === 'proxy' || r.kind === 'tool_error' || r.kind === 'swallowed')));
    if (!rows.length) {
      this.post({ type: 'notice', level: 'info', text: 'The failure log has nothing for this chat in the last 30 minutes.' });
      return;
    }
    await this.send({ text: diagnosePrompt(rows.slice(-25)), display: 'Diagnose the last failure', attachments: [], includeEditor: false });
  }

  /** Runs one of our hooks and adds its time to the turn: every tool call waits for them. */
  private timed<T>(name: string, run: () => T): T {
    const start = Date.now();
    const out = run();
    if (out instanceof Promise) {
      return out.finally(() => this.meter.hook(name, Date.now() - start)) as T;
    }
    this.meter.hook(name, Date.now() - start);
    return out;
  }

  /** A failure row with this chat's session, repo, provider and model filled in. */
  private report(row: DiagInput) {
    const provider = (row.provider ?? this.turn?.provider ?? this.activeProvider) as ProviderId | undefined;
    const effort = this.turn?.effort ?? this.activeEffort;
    return diag({
      session: this.sessionId,
      turn: this.turn ? this.meter.id : undefined,
      repo: repoKey(this.resolveCwd()),
      provider,
      model: provider && effort ? modelFor(provider, effort) : undefined,
      agent: 'main',
      ...row,
    });
  }

  private label(): string {
    return this.activeProvider ? PROVIDER_LABELS[this.activeProvider] : 'Agent';
  }
}

/** Identity of a tool result for loop detection; huge outputs are hashed by their ends, so it stays fast. */
function resultHash(text: string): string {
  const sample = text.length > 131_072 ? `${text.length}:${text.slice(0, 65_536)}${text.slice(-65_536)}` : text;
  return createHash('sha1').update(sample).digest('hex').slice(0, 16);
}

/** Any tool result as text, for hashing. */
function textOf(value: unknown): string {
  try {
    return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  } catch {
    return '';
  }
}

/** A prompt's text without attachments or editor context. */
function promptText(prompt: UserContent): string {
  return typeof prompt === 'string' ? prompt : prompt.flatMap((b) => (b.type === 'text' && !b.text.startsWith('<editor_context>') && !b.text.startsWith('Attached') ? [b.text] : [])).join('\n');
}

/** A Bash result's text: stdout and stderr, or whatever the tool returned. */
function outputText(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }
  const r = response as { stdout?: unknown; stderr?: unknown } | undefined;
  return [r?.stdout, r?.stderr].filter((x) => typeof x === 'string').join('\n');
}

/** How much text a tool returned to the model. */

/** The workspace folder of the file being edited, else the first workspace folder, else that file's folder. */
export function defaultCwd(): string {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri?.scheme === 'file') {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  const first = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (first) {
    return first;
  }
  return uri?.scheme === 'file' ? path.dirname(uri.fsPath) : os.homedir();
}

/** What a tool call acts on, for the failure log: its file, or the start of its command. */
function toolTarget(input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const file = i.file_path ?? i.notebook_path ?? i.path;
  if (typeof file === 'string') {
    return file;
  }
  return typeof i.command === 'string' ? short(i.command.replace(/\s+/g, ' '), 120) : typeof i.query === 'string' ? short(i.query, 120) : undefined;
}

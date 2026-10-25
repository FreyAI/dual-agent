/**
 * The messages between the extension and the chat page (media/chat/*.js):
 * ToWebview goes to the page, FromWebview comes back. Keep media/chat in step
 * with these when adding a message.
 */
import type { AgentsSnapshot } from './agents';
import type { EditorInfo } from './context';
import type { ChatSummary, TranscriptEntry } from './history';
import type { Effort, Mode, PermissionMode, ProviderId } from './providers';
import type { Question } from './questions';
import type { UsageSummary } from './usage';
import type { TurnMetrics, TurnSummary } from './metrics/turns';
import type { UsageTimeline } from './metrics/calls';
import type { BuildMode } from './reuse/modes';

export interface ProviderState {
  ready: boolean;
  detail: string;
  account?: string;
}

/** What the usage panel totals: this chat, this repo (on every machine), today, or everything. */
export type UsageScope = 'chat' | 'repo' | 'today' | 'all';

export interface Usage {
  /** Input incl. cache reads and writes. */
  input: number;
  output: number;
  /** New work: uncached input, cache writes and output (cache reads re-send what was already sent: 95% of tokens on 2026-10-21). */
  fresh?: number;
  cacheRead?: number;
  /** The last 10 minutes across this chat's agents: new tokens and cost at API prices. */
  burn?: { tokens: number; cost: number };
  /** Tokens the conversation currently fills in the model's context. */
  context: number;
  cost: number;
  /** Everything at API prices, subscription use included: what the work costs, live per model call. */
  estimate?: number;
  /** dualAgent.showCostInChat: the pill shows `estimate` after the token count. */
  showCost?: boolean;
}

/** The Cost tab: the limits (0: off), spend since their last reset, and today's against the daily budget. */
export interface CostReport {
  since: number;
  spent: number;
  totalLimit: number;
  spentToday: number;
  dailyBudget: number;
  /** Limited model keys, then other models with spend since the reset (limit 0). */
  models: { key: string; spent: number; limit: number }[];
}

/** Remote Control: not running, its terminal started, or the bridge registered with claude.ai. */
export type RemoteState = 'off' | 'starting' | 'connected';

/** Whose turn it is under the split, how many tokens that stint has run of its size (0: one side only), and the repo's tokens today. */
export interface StintState { provider: ProviderId; used: number; size: number; today: Record<ProviderId, number> }

/** Messages sent to the chat webview. */
export type ToWebview =
  | {
      type: 'state';
      mode: Mode;
      effort: Effort;
      permissionMode: PermissionMode;
      buildMode: BuildMode;
      /** Claude's target share of today's tokens in auto mode (0-100); null when no split is set. */
      split: number | null;
      /** Auto mode under a split: whose stint it is, how far it has run, and the repo's tokens today. */
      stint?: StintState;
      active?: ProviderId;
      /** The provider the next message goes to. */
      next: ProviderId;
      model?: string;
      busy: boolean;
      claude: ProviderState;
      deepseek: ProviderState;
      cwd: string;
      theme: string;
      editor?: EditorInfo;
    }
  | { type: 'user'; text: string; attachments: string[]; editor?: EditorInfo }
  | { type: 'assistantStart'; provider: ProviderId; effort: Effort }
  | { type: 'thinking' }
  /** What the agent is doing now, refreshed every few seconds while it works. */
  | { type: 'activity'; text: string; stalled: boolean }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; detail: string; path?: string }
  /** `diagnose`: the notice offers to have the agent find the failure's cause. */
  /** quiet: routine trouble (retries, network, a provider switch) listed under the agents panel's Warnings, not in the conversation. */
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string; diagnose?: boolean; quiet?: boolean }
  | { type: 'hello'; text: string }
  | { type: 'permission'; id: string; title: string; detail: string; preview?: string; canAlways: boolean }
  | { type: 'permissionResolved'; id: string; decision: PermissionDecision }
  /** The agent asks the user to choose; answered with answerQuestion. */
  | { type: 'question'; id: string; questions: Question[] }
  | { type: 'questionResolved'; id: string; questions: Question[]; answers?: Record<string, string>; skipped?: boolean }
  /** The agent finished planning (plan mode) and wants approval to start; answered with decidePlan. */
  | { type: 'planReview'; id: string; plan: string }
  | { type: 'planResolved'; id: string; plan: string; approved: boolean; feedback?: string }
  | { type: 'usage'; usage: Usage }
  /** Tokens and estimated cost per model, for the usage panel. */
  | { type: 'usageReport'; scope: UsageScope; summary: UsageSummary; peakNow: boolean; efficiency?: TurnSummary; tasks?: string[]; timeline?: UsageTimeline; costs?: CostReport }
  | ({ type: 'agents' } & AgentsSnapshot)
  | { type: 'attached'; files: string[] }
  | { type: 'done'; summary: string; metrics?: TurnMetrics }
  /** The mic: starting (asking macOS, opening the helper), listening (the words so far, the mic's level 0-1), or off (`send`: send the box now). */
  | { type: 'dictation'; state: 'starting' | 'listening' | 'off'; text?: string; level?: number; send?: boolean; problem?: string }
  | { type: 'reset' }

/** A message from the chat box. */
export interface SendRequest {
  text: string;
  attachments: string[];
  /** Whether to tell the agent about the file open in the editor. */
  includeEditor: boolean;
  /** What the chat shows for the message, when it differs from what the agent gets. */
  display?: string;
  /** Sent while the agent works: wait for its own turn instead of steering the current task. */
  queue?: boolean;
}

export type PermissionDecision = 'allow' | 'always' | 'deny';

/** Messages received from the chat webview. */
export type FromWebview =
  | { type: 'ready' }
  | ({ type: 'send' } & SendRequest)
  | { type: 'stop' }
  | { type: 'stopAgent'; taskId: string }
  | { type: 'newChat' }
  | { type: 'setMode'; mode: Mode }
  | { type: 'setEffort'; effort: Effort }
  | { type: 'setBuildMode'; mode: BuildMode }
  | { type: 'setPermissionMode'; mode: PermissionMode }
  /** Claude's share for the delegation split (0-100), or null to turn the split off. */
  | { type: 'setSplit'; claude: number | null }
  /** The Cost tab: only the limits given change. */
  | { type: 'setCostLimits'; total?: number; daily?: number; perModel?: Record<string, number> }
  | { type: 'setTheme'; theme: string }
  | { type: 'attach' }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openChat'; id: string }
  | { type: 'clearHistory' }
  | { type: 'permission'; id: string; decision: PermissionDecision }
  | { type: 'answer'; id: string; answers?: Record<string, string>; notes?: Record<string, string>; skipped?: boolean }
  /** `steps` (approve only): the user's edited plan steps; absent when the plan is unchanged. */
  | { type: 'planDecision'; id: string; approve: boolean; feedback?: string; steps?: string[] }
  /** The usage panel opened or changed scope (undefined: closed). */
  | { type: 'usageReport'; scope?: UsageScope }
  | { type: 'command'; command: string }
  /** The mic button: start recording, or finish and send. */
  | { type: 'dictate' }
  /** Stop recording without sending (the text was edited or sent). */
  | { type: 'dictationCancel' }
  /** The Diagnose button on a failure notice. */
  | { type: 'diagnose' };

/** Everything the page is sent: the agent's messages plus history. */
export type ViewMessage =
  | ToWebview
  | { type: 'restore'; messages: TranscriptEntry[] }
  | { type: 'history'; items: ChatSummary[]; current?: string }
  | { type: 'remote'; state: RemoteState };


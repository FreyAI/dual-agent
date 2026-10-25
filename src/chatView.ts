/**
 * One chat page (sidebar view or editor tab): loads media/chat/*.js, relays
 * messages between it and the AgentController (types in protocol.ts), queues
 * messages until the page is ready, and records the chat to history.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { AgentController, defaultCwd } from './agentController';
import { editedPlanText } from './agent/interactions';
import type { FromWebview, ToWebview, ViewMessage } from './protocol';
import type { UsageLedger } from './usage';
import type { TurnLog } from './metrics/turns';
import type { CallLog } from './metrics/calls';
import type { HelperLog } from './metrics/helpers';
import type { TaskLog } from './metrics/tasks';
import { ChatHistory, ChatRecorder, ChatSummary, TranscriptEntry } from './history';
import { saveBuildMode, saveCostLimits, saveTokenSplit, settings } from './providers';
import { onRemoteState, remoteState } from './remote';
import { warmProxyProcess } from './proxy/registry';
import { canDictate, cancelDictation, dictationApp, openApp, toggleDictation } from './dictation';
import { swallowed } from './diag/log';
import { errorMessage } from './text';
import type { Credentials, Effort, Mode, PermissionMode } from './providers';

export interface SessionHost {
  extensionUri: vscode.Uri;
  creds: Credentials;
  log: vscode.OutputChannel;
  /** This repo's saved chats. */
  history: ChatHistory;
  /** Token usage per model, shared by every chat. */
  ledger?: UsageLedger;
  /** Every turn's efficiency metrics, shared by every chat. */
  turnLog?: TurnLog;
  /** Every model call's tokens by agent, shared by every chat. */
  callLog?: CallLog;
  /** Every helper launch's summary, shared by every chat. */
  helperLog?: HelperLog;
  /** Every task's cost and outcome, shared by every chat. */
  taskLog?: TaskLog;
  onStateChange: (session: ChatSession) => void;
  /** A chat was saved or deleted, so every open chat's history list is stale. */
  onHistoryChange: () => void;
  /** Asks, then deletes this repo's saved chats, in every open chat. */
  clearHistory: () => Promise<void>;
}

/** One chat (sidebar view or editor tab) with its own conversation and agent process. */
export class ChatSession implements vscode.Disposable {
  readonly controller: AgentController;
  private ready = false;
  private backlog: ViewMessage[] = [];
  private readonly recorder: ChatRecorder;
  /** The last state sent to the chat, and listeners for everything sent (used by the tests). */
  lastState?: Extract<ToWebview, { type: 'state' }>;
  /** The last state the page was sent, to skip unchanged ones. */
  private sentState?: string;
  private readonly listeners = new Set<(msg: ToWebview) => void>();
  private readonly subscription: vscode.Disposable;
  private readonly remoteWatch = onRemoteState((state) => this.send({ type: 'remote', state }));

  constructor(
    private readonly webview: vscode.Webview,
    private readonly host: SessionHost,
    private readonly resolveCwd: () => string = defaultCwd,
    /** Reopen this repo's most recent chat (the sidebar does, new tabs start fresh). */
    private readonly restoreLatest = false,
  ) {
    this.recorder = new ChatRecorder(host.history, (line) => host.log.appendLine(line));
    this.controller = new AgentController(
      host.creds,
      host.log,
      (msg) => this.post(msg),
      () => host.onStateChange(this),
      resolveCwd,
      host.ledger,
      host.turnLog,
      host.callLog,
      host.helperLog,
      host.taskLog,
    );
    const media = vscode.Uri.joinPath(host.extensionUri, 'media');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    webview.html = html(webview, media, settings().get<string>('theme') ?? 'graphite');
    this.subscription = webview.onDidReceiveMessage((msg: FromWebview) => this.handle(msg));
    void this.controller.refreshStatus();
  }

  dispose() {
    void this.save();
    this.subscription.dispose();
    this.remoteWatch.dispose();
    cancelDictation(this);
    this.controller.dispose();
  }

  /** Whether the chat page has loaded and said hello. */
  get webviewReady(): boolean {
    return this.ready;
  }

  /** The saved chat this session is showing, if it has started one. */
  get chatId(): string | undefined {
    return this.recorder.chat?.id;
  }

  onDidPost(listener: (msg: ToWebview) => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Sends this repo's chat list to the page (for the history menu). */
  sendHistory() {
    this.send({ type: 'history', items: this.host.history.list(), current: this.recorder.chat?.id });
  }

  /** Shows a saved chat and resumes its conversation with the agent. */
  openChat(id: string): boolean {
    const chat = this.host.history.get(id);
    if (!chat) {
      return false;
    }
    if (this.controller.busy) {
      this.post({ type: 'notice', level: 'warn', text: 'Stop the current task before opening another chat.' });
      return false;
    }
    void this.save();
    const usage = chat.transcript.find((e) => e.type === 'usage')?.usage as any;
    const agents = chat.transcript.find((e) => e.type === 'agents') as any;
    this.controller.restoreConversation(chat.sessionId, chat.providers, usage, agents);
    this.recorder.load(chat);
    this.send({ type: 'restore', messages: chat.transcript });
    this.sendHistory();
    this.controller.emitState();
    return true;
  }

  private async save() {
    await this.recorder.save(this.controller.conversationId);
    this.host.onHistoryChange();
  }

  private post(msg: ToWebview) {
    if (msg.type === 'state') {
      this.lastState = msg;
    }
    if (msg.type === 'reset') {
      // A new chat: keep the old one saved, record the next one separately.
      void this.save();
      this.recorder.load(undefined);
    } else {
      this.recorder.record(msg);
      // Save when the reply ends and soon after a message is sent, so a crash or reload loses little.
      if (msg.type === 'done') {
        void this.save();
      } else if (msg.type === 'user') {
        this.recorder.saveSoon(() => void this.save());
      }
    }
    this.listeners.forEach((listener) => listener(msg));
    this.send(msg);
  }

  private send(msg: ViewMessage) {
    if (this.ready) {
      if (msg.type === 'state') {
        // Re-sent on every cursor move: an unchanged one would only redraw the same header and chips.
        const json = JSON.stringify(msg);
        if (json === this.sentState) {
          return;
        }
        this.sentState = json;
      }
      void this.webview.postMessage(msg);
    } else if (msg.type !== 'state') {
      this.backlog.push(msg);
    }
  }

  private async attach() {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      title: 'Attach files to the conversation',
      defaultUri: vscode.Uri.file(this.resolveCwd()),
    });
    if (picked?.length) {
      this.post({ type: 'attached', files: picked.map((uri) => uri.fsPath) });
    }
  }

  /** A page action failed: logged, and told to the page when the user asked for it. */
  private failed(what: string, err: unknown, notice?: string) {
    swallowed(`chatView.${what}`, err);
    if (notice) {
      this.send({ type: 'notice', level: 'error', text: `${notice}: ${errorMessage(err)}` });
    }
  }

  /** The saved chats were deleted: keep showing this one, but don't save it back. */
  forgetSavedChat() {
    this.recorder.load(undefined);
  }

  private handle(msg: FromWebview) {
    const c = this.controller;
    switch (msg.type) {
      case 'ready': {
        const first = !this.ready;
        this.ready = true;
        // A reloaded page has no state yet.
        this.sentState = undefined;
        for (const queued of this.backlog.splice(0)) {
          void this.webview.postMessage(queued);
        }
        if (!first && this.recorder.chat) {
          // The page reloaded: redraw this chat instead of a blank page.
          this.send({ type: 'restore', messages: this.recorder.chat.transcript });
        }
        const latest = first && this.restoreLatest && !this.recorder.chat ? this.host.history.latest() : undefined;
        if (!latest || !this.openChat(latest.id)) {
          this.sendHistory();
          c.emitState();
        }
        this.send({ type: 'remote', state: remoteState() });
        if (canDictate(this.host.extensionUri.fsPath)) {
          // Shows the mic.
          this.send({ type: 'dictation', state: 'off' });
        }
        if (first) {
          // The first message then needn't wait for Claude Code to start.
          void c.prewarm();
        }
        break;
      }
      case 'send':
        void c.send({ text: msg.text, attachments: msg.attachments ?? [], includeEditor: !!msg.includeEditor, queue: !!msg.queue });
        break;
      case 'stop':
        void c.stop();
        break;
      case 'stopAgent':
        void c.stopAgent(msg.taskId);
        break;
      case 'newChat':
        c.newChat();
        break;
      case 'diagnose':
        void c.diagnose();
        break;
      case 'openChat':
        this.openChat(msg.id);
        break;
      case 'clearHistory':
        void this.host.clearHistory();
        break;
      case 'setMode':
        void c.setMode(msg.mode);
        break;
      case 'setEffort':
        void c.setEffort(msg.effort);
        break;
      case 'setBuildMode':
        saveBuildMode(msg.mode).then(() => c.emitState(), (err) => this.failed('saveBuildMode', err, "The build mode couldn't be saved"));
        break;
      case 'setPermissionMode':
        void c.setPermissionMode(msg.mode);
        break;
      case 'setSplit':
        saveTokenSplit(msg.claude).then(undefined, (err) => this.failed('saveTokenSplit', err, "The token split couldn't be saved"));
        break;
      case 'setCostLimits':
        saveCostLimits(msg).then(() => c.refreshUsage(), (err) => this.failed('saveCostLimits', err, "The cost limits couldn't be saved"));
        break;
      case 'setTheme':
        settings().update('theme', msg.theme, vscode.ConfigurationTarget.Global).then(undefined, (err) => this.failed('theme', err, "The theme couldn't be saved"));
        break;
      case 'attach':
        void this.attach();
        break;
      case 'openFile': {
        const at = msg.line ? new vscode.Range(msg.line - 1, 0, msg.line - 1, 0) : undefined;
        vscode.window.showTextDocument(vscode.Uri.file(msg.path), { preview: true, viewColumn: vscode.ViewColumn.One, selection: at }).then(undefined, () =>
          vscode.window.showWarningMessage(`Couldn't open ${msg.path}: it may have been moved or deleted.`),
        );
        break;
      }
      case 'permission':
        c.answerPermission(msg.id, msg.decision);
        break;
      case 'answer':
        c.answerQuestion(msg.id, msg.skipped || !msg.answers ? undefined : { answers: msg.answers, notes: msg.notes });
        break;
      case 'planDecision':
        // Edited steps ride in `feedback` (ignored on approve otherwise), so the controller needs no change.
        c.decidePlan(msg.id, msg.approve, msg.approve && msg.steps?.length ? editedPlanText(msg.steps) : msg.feedback);
        break;
      case 'usageReport':
        this.host.ledger?.reload();
        this.host.turnLog?.reload();
        this.host.callLog?.reload();
        c.usageReport(msg.scope);
        break;
      case 'dictate':
        toggleDictation(this, (m) => this.send(m), openApp(dictationApp(this.host.extensionUri.fsPath)));
        break;
      case 'dictationCancel':
        cancelDictation(this);
        break;
      case 'command':
        if (msg.command.startsWith('dualAgent.')) {
          // A command may change what the usage panel shows (Reset Cost Limits).
          vscode.commands.executeCommand(msg.command).then(() => c.refreshUsage(), (err) => this.failed(msg.command, err, `${msg.command} failed`));
        }
        break;
    }
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'dualAgent.chat';

  constructor(
    private readonly host: SessionHost,
    private readonly onSession: (session: ChatSession, view: vscode.WebviewView) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    // Warm-up while the page loads, so the first launch doesn't wait for the proxy fork or the SDK's load.
    warmProxyProcess();
    void import('@anthropic-ai/claude-agent-sdk').catch((err) => swallowed('Loading the Agent SDK', err));
    // The sidebar picks up where this repo's last chat left off.
    this.onSession(new ChatSession(view.webview, this.host, defaultCwd, true), view);
  }
}

const icon = (body: string, cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  gear: icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  expand: icon('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  send: icon('<path d="M12 19V5M5 12l7-7 7 7"/>', 'icon send-icon'),
  stop: `<svg class="icon stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>`,
  clip: icon('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  chevron: icon('<path d="m6 9 6 6 6-6"/>', 'icon chevron'),
  bolt: icon('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'),
  shield: icon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  file: icon('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>'),
  gauge: icon('<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),
  mic: icon('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/>'),
  // Material Symbols' "tune", drawn inline: the page's content policy allows no web fonts.
  tune: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>`,
  agents: icon('<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M12 7.5v4M12 11.5l-5.5 4.5M12 11.5l5.5 4.5"/>'),
  history: icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>'),
  palette: icon('<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 0 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-4.9-4.5-8.6-10-8.6z"/>'),
};

/**
 * The page's files under media/: stylesheets in cascade order, then plain scripts in load order,
 * sharing their top-level names, each using what earlier ones declare.
 */
type PageFiles = { css: string[]; js: string[] };
const PAGE_FILES = require('../media/files.json') as PageFiles;

/** The packaged build has them joined in that order into chat.css and chat.js (scripts/bundle.mjs). */
const pageFiles = (media: vscode.Uri): PageFiles =>
  fs.existsSync(vscode.Uri.joinPath(media, 'chat.js').fsPath) ? { css: ['chat.css'], js: ['chat.js'] } : PAGE_FILES;

/** The chat page. Exported for the webview tests. */
export function html(webview: Pick<vscode.Webview, 'cspSource' | 'asWebviewUri'>, media: vscode.Uri, theme = 'graphite'): string {
  const nonce = randomBytes(16).toString('base64');
  const { css, js } = pageFiles(media);
  const styles = css.map((f) => `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, f))}">`).join('\n');
  const scripts = js.map((f) => `<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, f))}"></script>`).join('\n');
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(media, 'logo.svg'));
  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme.replace(/[^a-z]/g, '')}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${styles}
<title>Dual Agent</title>
</head>
<body>
<header class="topbar">
  <img class="brand-mark" src="${logo}" alt="">
  <div class="brand">
    <div class="brand-name"><span class="brand-title">Dual Agent</span><span id="liveDot" class="live-dot"></span></div>
    <div class="brand-status">
      <button class="model-pill" id="modelPill" data-menu="model" aria-haspopup="menu"><span class="dot" id="providerDot"></span><span id="modelLabel">Starting…</span>${ICONS.chevron}</button>
    </div>
  </div>
  <div class="top-actions">
    <button class="icon-btn" id="newChat" title="New chat" aria-label="New chat">${ICONS.plus}</button>
    <button class="icon-btn" id="historyBtn" data-menu="history" title="Chats in this repo" aria-label="Chat history">${ICONS.history}</button>
    <button class="icon-btn" id="themeBtn" data-menu="theme" title="Theme" aria-label="Theme">${ICONS.palette}</button>
    <button class="icon-btn" data-command="dualAgent.openInEditor" title="Open in a new tab" aria-label="Open in a new tab">${ICONS.expand}</button>
    <button class="icon-btn" data-command="dualAgent.openSettings" title="Settings" aria-label="Settings">${ICONS.gear}</button>
  </div>
</header>
<main id="log"></main>
<footer>
  <section class="agents-panel" id="agentsPanel" aria-label="Agents" hidden></section>
  <section class="agents-panel usage-panel" id="usagePanel" aria-label="Token usage" hidden></section>
  <div class="composer" id="composer">
    <div class="chips" id="chips"></div>
    <textarea id="prompt" rows="1" placeholder="Ask, or describe a change…" aria-label="Message"></textarea>
    <div class="composer-bar">
      <button class="icon-btn small" id="attach" title="Attach files" aria-label="Attach files">${ICONS.clip}</button>
      <button class="icon-btn small tune" id="tunePill" data-menu="tune" data-remote="off" aria-haspopup="menu" aria-expanded="false" aria-label="Remote Control, cost alerts and the split" title="Remote Control, cost alerts and the split">${ICONS.tune}</button>
      <button class="pill" id="agentsPill" aria-expanded="false" aria-controls="agentsPanel">${ICONS.agents}<span id="agentsLabel">0 running</span></button>
      <button class="pill" id="permPill" data-menu="permission" aria-haspopup="menu" title="Permissions">${ICONS.shield}<span id="permLabel">Ask</span>${ICONS.chevron}</button>
      <button class="pill usage" id="usage" aria-expanded="false" aria-controls="usagePanel" title="Tokens used in this chat">${ICONS.gauge}<span id="usageLabel">0</span></button>
      <button class="mic" id="mic" data-state="off" hidden aria-label="Dictate" title="Dictate (⇧⌘D): pause to send">${ICONS.mic}</button>
      <button class="send" id="send" title="Send (Enter)" aria-label="Send">${ICONS.send}${ICONS.stop}</button>
    </div>
  </div>
</footer>
<div class="menu" id="menu" role="menu" hidden></div>
${scripts}
</body>
</html>`;
}

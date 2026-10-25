/**
 * The extension's entry point: activate() registers the chat views (sidebar
 * and editor tabs), the commands and the status bar item, and tracks which
 * chat the commands apply to. Each chat is a ChatSession (chatView.ts) with
 * its own AgentController (agentController.ts).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { defaultCwd } from './agentController';
import { ChatSession, ChatViewProvider, SessionHost } from './chatView';
import { trackEditor } from './context';
import { ChatHistory } from './history';
import { UsageLedger } from './usage';
import { TurnLog, turnsToCsv } from './metrics/turns';
import { CallLog } from './metrics/calls';
import { HelperLog } from './metrics/helpers';
import { TaskLog } from './metrics/tasks';
import * as os from 'os';
import { Credentials, Effort, Mode, PROVIDER_LABELS, ProviderId, autoPrimary, claudeBinary, configuredLimits, effortFor, mainConfigDir, saveBuildMode, settings, useRepoSettings } from './providers';
import { ReplyStyle, checkCompression, compressPrompt, compressRefusal } from './lean';
import type { BuildMode } from './reuse/modes';
import { flushIndex } from './code/repoIndex';
import { runProxiesInChildProcess, setProxyLog, stopProxies } from './proxy/registry';
import { refreshDeepSeekModels } from './models';
import { applySplit, planSplit } from './rules/split';
import { LOG_KEEP_DAYS, pruneDiag, savedDiag, setDiagSink } from './diag/log';
import { failuresReport } from './diag/report';
import { burnReport } from './diag/burn';
import { startRemoteControl } from './remote';
import { limitStatus, limitsResetAt, resetLimits, spendSince, usd } from './costLimits';

export function activate(context: vscode.ExtensionContext) {
  const creds = new Credentials(context.secrets);
  const log = vscode.window.createOutputChannel('Dual Agent');
  setProxyLog((line) => log.appendLine(line));
  runProxiesInChildProcess(true);
  // The newest DeepSeek models, checked once a day; a failure keeps the defaults (models.ts).
  void creds.getDeepSeekKey().then(async (key) => {
    const problem = key && (await refreshDeepSeekModels(context.globalState, settings().get<string>('deepseek.baseUrl') || 'https://api.deepseek.com/anthropic', key));
    if (problem) {
      log.appendLine(problem);
    }
  });
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'dualAgent.switchProvider';

  const sessions = new Set<ChatSession>();
  // workspaceState is VS Code's storage for this workspace, so each repo keeps its own chats.
  const history = new ChatHistory(context.workspaceState);
  /** Every open chat picks its next model again, e.g. after the split changed. */
  const reroute = () => {
    sessions.forEach((s) => void s.controller.updateNextProvider());
    updateStatusItem();
  };
  useRepoSettings(context.workspaceState, reroute);
  // Token usage per model and per-turn metrics: one file each per machine, in a folder the user may sync between machines.
  const usageDir = settings().get<string>('usageFolder') || path.join(context.globalStorageUri.fsPath, 'usage');
  const machine = `${os.hostname().replace(/\.local$/, '')}-${vscode.env.machineId.slice(0, 8)}`;
  const ledger = new UsageLedger(usageDir, machine);
  const turnLog = new TurnLog(usageDir, machine);
  const callLog = new CallLog(usageDir, machine);
  const helperLog = new HelperLog(usageDir, machine);
  const taskLog = new TaskLog(usageDir, machine);
  // Every failure, with its cause, next to the usage files (and in the output channel).
  setDiagSink({ dir: usageDir, machine, out: (line) => log.appendLine(line) });
  // The logs to learn from are kept dualAgent.logRetentionDays; usage rows are the billing history and stay.
  // Pruned once a day (in any window), 30 s after startup so it stays off the startup path.
  const pruneTimer = setTimeout(() => {
    const today = new Date().toDateString();
    if (context.globalState.get('dualAgent.prunedOn') === today) {
      return;
    }
    void context.globalState.update('dualAgent.prunedOn', today);
    const keepDays = Math.max(1, settings().get<number>('logRetentionDays') ?? LOG_KEEP_DAYS);
    const cutoff = Date.now() - keepDays * 86_400_000;
    pruneDiag(keepDays);
    void turnLog.pruneAsync(cutoff, (r) => r.at);
    void callLog.pruneAsync(cutoff, (r) => r.at);
    void helperLog.pruneAsync(cutoff, (r) => r.at);
    void taskLog.pruneAsync(cutoff, (r) => r.at);
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearTimeout(pruneTimer) });
  /** The chat that commands like "New Chat" apply to: the one used most recently. */
  let current: ChatSession | undefined;

  const host: SessionHost = {
    extensionUri: context.extensionUri,
    creds,
    log,
    history,
    ledger,
    turnLog,
    callLog,
    helperLog,
    taskLog,
    onHistoryChange: () => sessions.forEach((s) => s.sendHistory()),
    clearHistory: async () => {
      const answer = await vscode.window.showWarningMessage("Delete all saved chats for this repo? This can't be undone.", { modal: true }, 'Delete');
      if (answer === 'Delete') {
        await history.clear();
        sessions.forEach((s) => s.forgetSavedChat());
        sessions.forEach((s) => s.sendHistory());
      }
    },
    onStateChange: (session) => {
      if (session === current) {
        updateStatusItem();
      }
    },
  };

  function track(session: ChatSession, disposeEvent: vscode.Event<void>) {
    sessions.add(session);
    current = session;
    disposeEvent(() => {
      session.dispose();
      sessions.delete(session);
      if (current === session) {
        current = [...sessions].pop();
      }
      updateStatusItem();
    });
    updateStatusItem();
  }

  function updateStatusItem() {
    const mode = settings().get<Mode>('mode') ?? 'auto';
    const c = current?.controller;
    const running = c?.active ? PROVIDER_LABELS[c.active] : undefined;
    const modeLabel = mode === 'auto' ? 'Auto' : PROVIDER_LABELS[mode];
    const provider = c?.active ?? (mode === 'deepseek' ? 'deepseek' : mode === 'claude' ? 'claude' : autoPrimary());
    const effort = effortFor(provider) === 'flash' ? (provider === 'deepseek' ? 'Flash' : 'Fast') : 'Thinking';
    statusItem.text = `$(${c?.busy ? 'sync~spin' : 'hubot'}) ${modeLabel}${mode === 'auto' && running ? ` → ${running}` : ''} · ${effort}`;
    statusItem.tooltip = 'Dual Agent provider. Click to switch.';
    statusItem.show();
  }

  function openInEditor() {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    // A tab stays on the codebase it was opened from, even if focus moves to another folder.
    const cwd = defaultCwd();
    const panel = vscode.window.createWebviewPanel(
      'dualAgent.chatPanel',
      `Dual Agent · ${path.basename(cwd)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    panel.iconPath = vscode.Uri.joinPath(media, 'logo.svg');
    const session = new ChatSession(panel.webview, host, () => cwd);
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        current = session;
        updateStatusItem();
      }
    });
    track(session, panel.onDidDispose);
  }

  /** The chat commands act on, opening a tab when there is none. */
  function chatForCommand(): ChatSession | undefined {
    if (!current) {
      openInEditor();
    }
    return current;
  }

  /** Memory files the agent loads every session: this workspace's and the user's own. */
  function memoryCandidates(): string[] {
    const files: string[] = [];
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') {
      files.push(active.fsPath);
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      files.push(...['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md')].map((f) => path.join(root, f)));
      const rules = path.join(root, '.claude', 'rules');
      try {
        files.push(...fs.readdirSync(rules).filter((f) => f.endsWith('.md')).map((f) => path.join(rules, f)));
      } catch {
        // No rules folder.
      }
    }
    files.push(path.join(mainConfigDir(), 'CLAUDE.md'));
    return [...new Set(files)].filter((f) => fs.existsSync(f) && !compressRefusal(f));
  }

  async function compressMemory(target?: vscode.Uri) {
    let file = target?.fsPath;
    if (!file) {
      const browse = 'Choose a file…';
      const picked = await vscode.window.showQuickPick(
        [...memoryCandidates().map((f) => ({ label: path.basename(f), description: f, file: f })), { label: browse, description: '', file: '' }],
        { title: 'Compress a memory file', placeHolder: 'The agent rewrites it in compressed form; the original is backed up.' },
      );
      if (!picked) {
        return;
      }
      file = picked.file;
      if (!file) {
        const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Text: ['md', 'mdc', 'markdown', 'txt'] } });
        file = chosen?.[0]?.fsPath;
        if (!file) {
          return;
        }
      }
    }
    const refusal = compressRefusal(file);
    if (refusal) {
      vscode.window.showWarningMessage(refusal);
      return;
    }
    const session = chatForCommand();
    if (!session) {
      return;
    }
    if (session.controller.busy) {
      vscode.window.showWarningMessage('The chat is busy. Wait for the reply to finish, or press Stop, then try again.');
      return;
    }
    const original = fs.readFileSync(file, 'utf8');
    // Kept outside the repo so Claude Code never loads the backup as a memory file.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(context.globalStorageUri.fsPath, 'compress-backups', path.basename(path.dirname(file)));
    const backup = path.join(backupDir, `${path.basename(file, path.extname(file))}.${stamp}.original${path.extname(file) || '.md'}`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(backup, original);

    await session.controller.send({
      text: compressPrompt(file, backup),
      display: `Compress ${path.basename(file)} (original backed up to ${backup})`,
      attachments: [],
      includeEditor: false,
    });
    await session.controller.whenIdle();

    const compressed = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (compressed === original) {
      vscode.window.showInformationMessage(`${path.basename(file)} was not changed.`);
      return;
    }
    const check = checkCompression(original, compressed);
    const saved = check.before ? Math.round((1 - check.after / check.before) * 100) : 0;
    const sizes = `${check.before.toLocaleString()} → ${check.after.toLocaleString()} characters (${saved}% smaller, about ${Math.round((check.before - check.after) / 4).toLocaleString()} tokens per session)`;
    const restore = 'Restore original';
    const answer = check.problems.length
      ? await vscode.window.showWarningMessage(
          `${path.basename(file)} compressed, but some content changed that must not: ${check.problems.join('; ')}.`,
          restore,
          'Keep',
        )
      : await vscode.window.showInformationMessage(`${path.basename(file)} compressed: ${sizes}.`, 'Keep', restore);
    if (answer === restore) {
      fs.writeFileSync(file, original);
      vscode.window.showInformationMessage(`${path.basename(file)} restored.`);
    }
  }

  /** `recheck`: after a sign-in, check Claude really answers instead of trusting the last check. */
  async function refreshAll(recheck = false) {
    await Promise.all([...sessions].map((s) => s.controller.refreshStatus(recheck)));
  }

  async function promptForKey(label: string, placeholder: string, save: (key: string) => Thenable<void>) {
    const key = await vscode.window.showInputBox({
      title: `${label} API key`,
      prompt: `Stored in VS Code's secret storage on this machine.`,
      placeHolder: placeholder,
      password: true,
      ignoreFocusOut: true,
    });
    if (key?.trim()) {
      await save(key.trim());
      await refreshAll();
      vscode.window.showInformationMessage(`${label} API key saved.`);
    }
  }

  const viewProvider = new ChatViewProvider(host, (session, view) => {
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        current = session;
        updateStatusItem();
      }
    });
    track(session, view.onDidDispose);
  });

  let editorTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    trackEditor(() => {
      // Selection changes fire per keystroke; the chat only needs the settled state.
      clearTimeout(editorTimer);
      editorTimer = setTimeout(() => sessions.forEach((s) => s.controller.emitState()), 150);
    }),
    { dispose: () => clearTimeout(editorTimer) },
    log,
    statusItem,
    { dispose: () => sessions.forEach((s) => s.dispose()) },
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('dualAgent.openInEditor', openInEditor),

    vscode.commands.registerCommand('dualAgent.switchProvider', async () => {
      const items: (vscode.QuickPickItem & { mode: Mode })[] = [
        { mode: 'auto', label: 'Auto', description: 'Use the primary provider, switch when it fails' },
        { mode: 'claude', label: 'Claude', description: 'Your Claude sign-in or Anthropic API key' },
        { mode: 'deepseek', label: 'DeepSeek', description: 'DeepSeek API key' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `Provider (current: ${settings().get<Mode>('mode') ?? 'auto'})`,
      });
      if (!picked) {
        return;
      }
      if (current) {
        await current.controller.setMode(picked.mode);
      } else {
        await settings().update('mode', picked.mode, vscode.ConfigurationTarget.Global);
      }
    }),

    vscode.commands.registerCommand('dualAgent.newChat', () => {
      if (current) {
        current.controller.newChat();
      } else {
        openInEditor();
      }
    }),

    // Resolves once the sign-in terminal closes and every chat has checked Claude again, so a paused reply can continue.
    vscode.commands.registerCommand('dualAgent.signInClaude', () => new Promise<void>((resolve) => {
      // Run the binary directly: no shell, so no quoting rules that differ between bash and PowerShell.
      const terminal = vscode.window.createTerminal({ name: 'Claude sign-in', shellPath: claudeBinary(), shellArgs: ['auth', 'login'] });
      terminal.show();
      const sub = vscode.window.onDidCloseTerminal((closed) => {
        if (closed === terminal) {
          sub.dispose();
          void refreshAll(true).finally(resolve);
        }
      });
      vscode.window.showInformationMessage('Finish signing in in the terminal, then close it. The agent will pick up the sign-in.');
    })),

    vscode.commands.registerCommand('dualAgent.setDeepSeekKey', () =>
      promptForKey('DeepSeek', 'sk-…', (key) => creds.setDeepSeekKey(key)),
    ),

    vscode.commands.registerCommand('dualAgent.setAnthropicKey', () =>
      promptForKey('Anthropic', 'sk-ant-…', (key) => creds.setAnthropicKey(key)),
    ),

    vscode.commands.registerCommand('dualAgent.setReplyStyle', async () => {
      const items: (vscode.QuickPickItem & { style: ReplyStyle })[] = [
        { style: 'off', label: 'Off', description: 'Normal replies' },
        { style: 'lite', label: 'Lite', description: 'Full sentences, no filler or hedging' },
        { style: 'full', label: 'Full', description: 'Fragments, no articles; every technical fact kept' },
        { style: 'ultra', label: 'Ultra', description: 'Maximum compression' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `Reply style (current: ${settings().get<ReplyStyle>('replyStyle') ?? 'full'})`,
      });
      if (picked) {
        await settings().update('replyStyle', picked.style, vscode.ConfigurationTarget.Global);
      }
    }),

    vscode.commands.registerCommand('dualAgent.setBuildMode', async () => {
      const items: (vscode.QuickPickItem & { mode: BuildMode })[] = [
        { mode: 'hybrid', label: 'Hybrid', description: 'Decide per component: reuse open-source code or write it (default)' },
        { mode: 'reuse', label: 'Reuse', description: 'Look for established open-source code first' },
        { mode: 'craft', label: 'Craft', description: 'Write everything from scratch' },
      ];
      const picked = await vscode.window.showQuickPick(items, { title: `Build mode for this project (current: ${settings().get<BuildMode>('buildMode') ?? 'hybrid'})` });
      if (picked) {
        await saveBuildMode(picked.mode);
        vscode.window.showInformationMessage(`Build mode: ${picked.label}. Applies to new chats.`);
      }
    }),

    vscode.commands.registerCommand('dualAgent.exportMetrics', async () => {
      turnLog.reload();
      const rows = turnLog.all();
      if (!rows.length) {
        vscode.window.showInformationMessage('No turn metrics yet: they are recorded as you chat.');
        return;
      }
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), 'dual-agent-metrics.csv')), filters: { CSV: ['csv'] } });
      if (target) {
        fs.writeFileSync(target.fsPath, turnsToCsv(rows));
        vscode.window.showInformationMessage(`Exported ${rows.length} turns to ${target.fsPath}.`);
      }
    }),

    vscode.commands.registerCommand('dualAgent.compressMemory', (uri?: vscode.Uri) => compressMemory(uri)),

    vscode.commands.registerCommand('dualAgent.showFailures', async () => {
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: failuresReport(savedDiag(), Date.now() - 24 * 3_600_000, Date.now(), turnLog.all(), callLog.all()) });
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    }),
    vscode.commands.registerCommand('dualAgent.diagnoseBurn', async () => {
      const span = await vscode.window.showQuickPick(
        [
          { label: 'Last hour', hours: 1 },
          { label: 'Last 6 hours', hours: 6 },
          { label: 'Last 24 hours', hours: 24 },
          { label: 'Last 7 days', hours: 168 },
        ],
        { placeHolder: 'Where did the tokens go: over which window?' },
      );
      if (!span) {
        return;
      }
      // Other windows and machines append to the logs too.
      [turnLog, callLog, helperLog].forEach((l) => l.reload());
      const content = burnReport({ calls: callLog.all(), turns: turnLog.all(), helpers: helperLog.all(), diag: savedDiag(), since: Date.now() - span.hours * 3_600_000 });
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    }),
    vscode.commands.registerCommand('dualAgent.startRemoteControl', () =>
      startRemoteControl(creds, defaultCwd(), ledger, callLog).catch((err) => vscode.window.showErrorMessage(`Remote Control didn't start: ${err instanceof Error ? err.message : String(err)}`)),
    ),
    vscode.commands.registerCommand('dualAgent.resetCostLimits', async () => {
      const limits = configuredLimits();
      const since = limitsResetAt(usageDir);
      ledger.reload();
      const status = limits && since ? limitStatus(spendSince(ledger.all(), since), limits) : undefined;
      const lines = status ? [...(status.total ? [`All models: ${usd(status.total.spent)} of ${usd(status.total.limit)}`] : []), ...status.models.map((m) => `${m.key}: ${usd(m.spent)} of ${usd(m.limit)}`)] : [];
      const detail = limits
        ? `${since ? `Spent since ${new Date(since).toLocaleString()}:\n${lines.join('\n')}` : 'Nothing counted yet.'}\n\nResetting counts spend from now and unblocks every model.`
        : 'No cost limit is set (dualAgent.costLimitUsd, dualAgent.modelCostLimitsUsd). Resetting only restarts the count.';
      if ((await vscode.window.showWarningMessage('Reset the cost limits?', { modal: true, detail }, 'Reset')) === 'Reset') {
        resetLimits(usageDir);
        vscode.window.showInformationMessage('Cost limits reset: spend counts from now.');
      }
    }),
    vscode.commands.registerCommand('dualAgent.splitClaudeMd', () => splitClaudeMd(path.join(context.globalStorageUri.fsPath, 'rules-backups'))),

    vscode.commands.registerCommand('dualAgent.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),

    vscode.commands.registerCommand('dualAgent.clearHistory', () => host.clearHistory()),

    vscode.commands.registerCommand('dualAgent.clearKeys', async () => {
      await creds.clear();
      await refreshAll();
      vscode.window.showInformationMessage('Stored API keys cleared.');
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dualAgent')) {
        if (e.affectsConfiguration('dualAgent.deepseek.apiKeyFile')) {
          void refreshAll();
        }
        if (e.affectsConfiguration('dualAgent.permissionMode')) {
          sessions.forEach((s) => void s.controller.applyPermissionMode());
        }
        if (['costLimitUsd', 'modelCostLimitsUsd', 'dailyBudgetUsd', 'showCostInChat'].some((k) => e.affectsConfiguration(`dualAgent.${k}`))) {
          sessions.forEach((s) => s.controller.refreshUsage());
        }
        if (!e.affectsConfiguration('dualAgent.theme')) {
          sessions.forEach((s) => void s.controller.settingsChanged());
        }
        reroute();
      }
    }),
  );

  updateStatusItem();
  return { sessions: () => [...sessions], history } satisfies DualAgentApi;
}

/** What `activate` returns; the integration tests use it to look inside open chats. */
export interface DualAgentApi {
  sessions(): ChatSession[];
  history: ChatHistory;
}

export function deactivate() {
  return Promise.all([flushIndex(), stopProxies()]);
}

/**
 * Moves path-specific sections of the workspace CLAUDE.md into .claude/rules/
 * files that load only when matching files are touched; CLAUDE.md loads on
 * every request of every session.
 */
async function splitClaudeMd(backupDir: string) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const file = root && path.join(root, 'CLAUDE.md');
  if (!file || !fs.existsSync(file)) {
    vscode.window.showInformationMessage('No CLAUDE.md in the workspace folder.');
    return;
  }
  const repoFiles = (await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/.dual-agent/**}', 20_000)).map((u) => path.relative(root, u.fsPath));
  const plan = planSplit(fs.readFileSync(file, 'utf8'), repoFiles);
  if (!plan.rules.length) {
    vscode.window.showInformationMessage('Every section of CLAUDE.md applies to the whole project, so nothing was moved.');
    return;
  }
  const list = plan.rules.map((r) => `${path.basename(r.path)} (${r.paths.join(', ')})`).join('\n');
  const choice = await vscode.window.showInformationMessage(
    `Move ${plan.movedLines} of ${plan.movedLines + plan.keptLines} lines into ${plan.rules.length} rule file(s) that load only for matching files?`,
    { modal: true, detail: list },
    'Split',
  );
  if (choice !== 'Split') {
    return;
  }
  try {
    const { backup, written } = applySplit(root, plan, backupDir);
    vscode.window.showInformationMessage(`Wrote ${written.length} file(s). The original CLAUDE.md is backed up at ${backup}.`);
  } catch (err) {
    vscode.window.showErrorMessage(`Couldn't split CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`);
  }
}

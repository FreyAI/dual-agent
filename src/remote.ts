/**
 * Remote Control (the Claude app, claude.ai/code) for this folder, with
 * DeepSeek in the same sessions. Claude Code allows Remote Control only for a
 * first-party session: the claude.ai sign-in and requests to api.anthropic.com
 * itself, so no ANTHROPIC_BASE_URL. The local proxy becomes its HTTPS proxy
 * instead and decrypts that one host with a certificate made here for it
 * (proxy/cert.ts). Claude requests pass through unchanged; DeepSeek-model ones
 * (`/model deepseek-flash`), and Claude ones while Claude is out of quota, go
 * to DeepSeek. Measured 2026-10-20: the bridge registered and connected, and
 * one session answered from Haiku, then from deepseek-flash. SDK sessions (the
 * chat panel) can't start Remote Control, so this runs Claude Code's own
 * `remote-control` server in a terminal.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Credentials, claudeBinary, configuredLimits, deepseekRoute } from './providers';
import { proxyUrl, routeDeepSeekHelpers, setRemoteHooks } from './proxy/registry';
import { hostCert } from './proxy/cert';
import { UsageLedger, UsageRow, providerOfModel, repoKey } from './usage';
import { CallLog, callTokens } from './metrics/calls';
import { countingSince, limitRefusal, limitStatus, spendSince } from './costLimits';
import { diag } from './diag/log';
import type { RemoteState } from './protocol';

/** The api.anthropic.com certificate, trusted only by the terminal's Claude Code; a bundle already in NODE_EXTRA_CA_CERTS is kept alongside. */
function remoteCert(): { key: string; cert: string; certFile: string } {
  const dir = process.env.DUAL_AGENT_TLS_DIR || path.join(os.homedir(), '.dual-agent-tls');
  const host = hostCert(dir, 'api.anthropic.com');
  const own = process.env.NODE_EXTRA_CA_CERTS;
  if (!own || !fs.existsSync(own)) {
    return host;
  }
  const bundle = path.join(dir, 'bundle.pem');
  fs.writeFileSync(bundle, `${fs.readFileSync(own, 'utf8').trim()}\n${host.cert}`);
  return { ...host, certFile: bundle };
}

/** The terminal's environment: first party, through the proxy; nothing that would turn Claude Code into an API-key or custom-endpoint session. */
export function remoteEnv(proxy: string, certFile: string): Record<string, string | null> {
  return {
    HTTPS_PROXY: proxy,
    NODE_EXTRA_CA_CERTS: certFile,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    ANTHROPIC_BASE_URL: null,
    ANTHROPIC_API_KEY: null,
    ANTHROPIC_AUTH_TOKEN: null,
    CLAUDE_CODE_OAUTH_TOKEN: null,
    ANTHROPIC_UNIX_SOCKET: null,
    // Both turn off the feature flags Remote Control needs.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: null,
    DISABLE_GROWTHBOOK: null,
    // The bundled Claude Code is pinned; otherwise it updates the user's global install (it did, 2026-10-20).
    DISABLE_AUTOUPDATER: '1',
  };
}

/**
 * Remote Control sessions have no chat to record them: the proxy reports each
 * reply's usage (kept like a chat's, agent 'remote') and checks the cost limits
 * before each request (dualAgent.costLimitUsd and modelCostLimitsUsd).
 */
function watchRemote(cwd: string, ledger: UsageLedger, callLog: CallLog) {
  const repo = repoKey(cwd);
  const dir = path.dirname(ledger.file);
  setRemoteHooks({
    onUsage: ({ model, usage, session }) => {
      const provider = providerOfModel(model, 'claude');
      // Claude here is always the claude.ai sign-in (Remote Control allows nothing else).
      const row: UsageRow = { at: Date.now(), machine: ledger.machine, session, repo, provider, model, billing: provider === 'claude' ? 'subscription' : 'api', ...callTokens(usage) };
      try {
        ledger.record([row]);
        callLog.append([{ ...row, agent: 'remote' }]);
      } catch (err) {
        diag({ kind: 'swallowed', target: 'Remote Control usage', agent: 'remote', detail: err instanceof Error ? err.message : String(err) });
      }
    },
    refuse: (meta) => {
      const limits = configuredLimits();
      if (!limits) {
        return undefined;
      }
      // Chats in other windows and machines spend too.
      ledger.reload();
      const why = limitRefusal(limitStatus(spendSince(ledger.all(), countingSince(dir)), limits), meta.model);
      if (why) {
        diag({ kind: 'notice', level: 'error', agent: 'remote', repo, ...meta, detail: why });
      }
      return why;
    },
    onResponse: (pathname, status) => {
      const next = bridgeState(pathname, status);
      // A late reply after the terminal closed doesn't turn it back on.
      if (next && terminal?.exitStatus === undefined) {
        setState(next);
      }
    },
  });
}

/**
 * What a response to Claude Code's bridge means: registering or polling for
 * work succeeded (connected), or it went offline. Paths from the bundled CLI
 * (2026-10-21): POST /v1/environments/bridge, then /v1/environments/{id}/work/poll.
 */
export function bridgeState(pathname: string, status: number): RemoteState | undefined {
  if (!pathname.startsWith('/v1/environments/')) {
    return undefined;
  }
  if (/\/bridge\/[^/]+\/offline$/.test(pathname)) {
    return 'starting';
  }
  if (/^\/v1\/environments\/(bridge|[^/]+\/work\/poll|[^/]+\/bridge\/reconnect)$/.test(pathname)) {
    return status < 300 ? 'connected' : status >= 400 && status < 500 ? 'starting' : undefined;
  }
  return undefined;
}

let state: RemoteState = 'off';
const changed = new vscode.EventEmitter<RemoteState>();
/** Remote Control's state, for the phone dot in each chat. */
export const remoteState = () => state;
export const onRemoteState = changed.event;
function setState(next: RemoteState) {
  if (next !== state) {
    state = next;
    changed.fire(next);
  }
}

let terminal: vscode.Terminal | undefined;

export async function startRemoteControl(creds: Credentials, cwd: string, ledger: UsageLedger, callLog: CallLog): Promise<void> {
  if (terminal && terminal.exitStatus === undefined) {
    terminal.show();
    return;
  }
  const route = await deepseekRoute(creds);
  if (route) {
    routeDeepSeekHelpers(route);
  }
  watchRemote(cwd, ledger, callLog);
  const cert = remoteCert();
  const proxy = await proxyUrl('https://api.anthropic.com', 'claude', cert);
  if (!proxy) {
    throw new Error('the local proxy could not start (see the Dual Agent output)');
  }
  terminal = vscode.window.createTerminal({
    name: 'Dual Agent: Remote Control',
    cwd,
    env: remoteEnv(proxy, cert.certFile),
    shellPath: claudeBinary(),
    shellArgs: ['remote-control', '--name', path.basename(cwd)],
    iconPath: new vscode.ThemeIcon('remote'),
  });
  setState('starting');
  const opened = terminal;
  const closed = vscode.window.onDidCloseTerminal((t) => {
    if (t === opened) {
      closed.dispose();
      setState('off');
    }
  });
  terminal.show();
  if (!route) {
    vscode.window.showWarningMessage('Remote Control is running on Claude only: set a DeepSeek key for DeepSeek models and for answers once Claude is out of quota.');
  }
}

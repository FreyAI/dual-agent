/**
 * Dictation into the chat box, on macOS. The chat page can't use the mic (VS
 * Code allows none in webviews) and a process VS Code starts can't use speech
 * recognition (VS Code doesn't declare it), so the bundled "Dual Agent
 * Dictation" app (native/dictation) is opened as its own app, asks macOS for
 * both itself, and streams the words here over a local socket. One recording
 * at a time across every chat.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import type { ToWebview } from './protocol';

type Post = (msg: Extract<ToWebview, { type: 'dictation' }>) => void;
/** Opens the helper with the port and token to connect back with. */
export type Launch = (port: number, token: string) => Promise<void>;

export const dictationApp = (extensionPath: string) => path.join(extensionPath, 'bin', 'Dual Agent Dictation.app');

export const canDictate = (extensionPath: string) => process.platform === 'darwin' && fs.existsSync(dictationApp(extensionPath));

/** `open -n` starts a fresh copy as its own app (so the permissions are its own); `-g` leaves VS Code in front. */
export const openApp = (app: string): Launch => (port, token) =>
  new Promise((resolve, reject) =>
    execFile('open', ['-n', '-g', '-a', app, '--args', '--port', String(port), '--token', token], (err) => (err ? reject(err) : resolve())),
  );

/** How long the helper gets to connect back. */
const HELLO_MS = 10_000;

class Recording {
  private server = net.createServer();
  private socket?: net.Socket;
  private ended = false;
  /** A stop asked for before the helper connected. */
  private pending?: 'stop' | 'cancel';
  private timer?: NodeJS.Timeout;

  constructor(readonly owner: object, private readonly post: Post) {}

  async start(launch: Launch) {
    this.post({ type: 'dictation', state: 'starting' });
    const token = randomBytes(16).toString('hex');
    this.server.on('connection', (s) => this.connected(s, token));
    try {
      await new Promise<void>((resolve, reject) => this.server.once('error', reject).listen(0, '127.0.0.1', resolve));
      // Waiting for the helper never keeps VS Code's extension host alive.
      this.server.unref();
      this.timer = setTimeout(() => this.end(false, "Dictation didn't start: its helper app didn't answer."), HELLO_MS);
      await launch((this.server.address() as net.AddressInfo).port, token);
    } catch (err) {
      this.end(false, `Dictation didn't start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private connected(s: net.Socket, token: string) {
    let buf = '';
    let trusted = false;
    s.setEncoding('utf8');
    s.on('data', (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { type?: string; token?: string; text?: string; level?: number; send?: boolean; problem?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!trusted) {
          // Only the copy opened here knows the token.
          if (msg.type !== 'hello' || msg.token !== token || this.socket) {
            s.destroy();
            return;
          }
          trusted = true;
          this.socket = s;
          clearTimeout(this.timer);
          this.server.close();
          if (this.pending) {
            s.write(`${this.pending}\n`);
          }
          continue;
        }
        if (this.ended) {
          continue;
        }
        if (msg.type === 'listening') {
          this.post({ type: 'dictation', state: 'listening', level: 0 });
        } else if (msg.type === 'text' && typeof msg.text === 'string') {
          this.post({ type: 'dictation', state: 'listening', text: msg.text });
        } else if (msg.type === 'level' && typeof msg.level === 'number') {
          this.post({ type: 'dictation', state: 'listening', level: msg.level });
        } else if (msg.type === 'done') {
          this.end(!!msg.send, msg.problem);
        }
      }
    });
    s.on('close', () => trusted && this.end(false, this.ended ? undefined : 'Dictation stopped unexpectedly. Click the mic to try again.'));
    s.on('error', () => s.destroy());
  }

  /** Finish and send what was said (`stop`), or stop without sending (`cancel`). */
  stop(how: 'stop' | 'cancel') {
    if (this.socket) {
      this.socket.write(`${how}\n`);
    } else if (how === 'cancel') {
      // Not connected yet: the helper is told when it does; the chat is free now.
      this.pending = how;
      this.end(false);
    } else {
      this.pending = how;
    }
  }

  private end(send: boolean, problem?: string) {
    if (this.ended) {
      return;
    }
    this.ended = true;
    clearTimeout(this.timer);
    // A cancel before the helper connected still has to reach it, if it comes.
    if (this.pending && !this.socket) {
      setTimeout(() => this.server.close(), HELLO_MS).unref();
    } else {
      this.server.close();
    }
    this.socket?.end();
    if (active === this) {
      active = undefined;
    }
    this.post({ type: 'dictation', state: 'off', send, problem });
  }
}

let active: Recording | undefined;

/** The mic button: starts recording for `owner` (its chat), or finishes the recording it has and sends. */
export function toggleDictation(owner: object, post: Post, launch: Launch) {
  if (active?.owner === owner) {
    active.stop('stop');
    return;
  }
  active?.stop('cancel');
  active = new Recording(owner, post);
  void active.start(launch);
}

/** The text was edited, the message was sent, or the chat closed: stop without sending. */
export function cancelDictation(owner: object) {
  if (active?.owner === owner) {
    active.stop('cancel');
  }
}

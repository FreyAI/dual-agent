import type * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { ProviderId } from './providers';
import { errorMessage } from './text';
import { swallowed } from './diag/log';

/**
 * Chat history for one repo, kept in VS Code's per-workspace storage
 * (`workspaceState`), so each project has its own list of chats that survives
 * reloads and restarts.
 */

/** A message as the chat displays it; replayed to redraw a saved chat. */
export type TranscriptEntry = { type: string; [key: string]: unknown };

export interface SavedChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** The Claude Code session to resume, so the agent remembers the conversation too. */
  sessionId?: string;
  providers: ProviderId[];
  transcript: TranscriptEntry[];
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  messages: number;
}

/** The old store: every chat in one array. Split into the keys below on first load. */
const OLD_KEY = 'dualAgent.chats';
/** The saved chats without their transcripts, for the list and the caps. */
const INDEX = 'dualAgent.chatIndex';
/** One key per chat, so a save writes only that chat. */
const CHAT = 'dualAgent.chat:';
const MAX_CHATS = 50;
const MAX_ENTRIES = 2000;
const MAX_TEXT = 100_000;
/** One saved chat's serialized size: the oldest entries go first. */
export const MAX_CHAT_CHARS = 1_000_000;
/** Every saved chat together: the oldest chats go first, the newest always stays. */
export const MAX_TOTAL_CHARS = 8_000_000;

/** What gets saved: what the chat shows, not transient UI (state, typing, pending permissions). */
// Answered questions and plans are kept (as their resolved form), open ones are not.
const KEPT = new Set(['user', 'assistantStart', 'delta', 'tool', 'notice', 'permissionResolved', 'questionResolved', 'planResolved', 'done', 'usage', 'agents']);
/** Kept only as their latest value: running totals and snapshots. */
const LATEST_ONLY = new Set(['usage', 'agents']);

/** A saved chat in the index: its serialized size counts toward the total budget. */
interface IndexEntry extends ChatSummary {
  size: number;
}

const indexEntry = (c: SavedChat): IndexEntry => ({
  id: c.id,
  title: c.title,
  updatedAt: c.updatedAt,
  messages: c.transcript.filter((e) => e.type === 'user').length,
  size: JSON.stringify(c).length,
});

export class ChatHistory {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly maxTotalChars = MAX_TOTAL_CHARS,
  ) {
    this.migrate().catch((err) => swallowed('history.migrate', err));
  }

  list(): ChatSummary[] {
    return this.index().map(({ id, title, updatedAt, messages }) => ({ id, title, updatedAt, messages }));
  }

  get(id: string): SavedChat | undefined {
    return this.index().some((e) => e.id === id) ? this.memento.get<SavedChat>(CHAT + id) : undefined;
  }

  latest(): SavedChat | undefined {
    const newest = this.index()[0];
    return newest && this.get(newest.id);
  }

  async save(chat: SavedChat) {
    const stored = { ...chat, transcript: newestWithin(chat.transcript, MAX_CHAT_CHARS) };
    await this.write([indexEntry(stored), ...this.index().filter((e) => e.id !== chat.id)], [stored]);
  }

  async delete(id: string) {
    await Promise.all([this.memento.update(INDEX, this.index().filter((e) => e.id !== id)), this.memento.update(CHAT + id, undefined)]);
  }

  async clear() {
    const keys = this.memento.keys().filter((k) => k.startsWith(CHAT));
    await Promise.all([this.memento.update(INDEX, []), this.memento.update(OLD_KEY, undefined), ...keys.map((k) => this.memento.update(k, undefined))]);
  }

  /** Newest first. */
  private index(): IndexEntry[] {
    return [...this.memento.get<IndexEntry[]>(INDEX, [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Stores `chats` and the index of `entries` within the caps (the oldest go first, the newest always stays);
   * chats left out lose their keys. Every update is issued at once (each changes the memento before it
   * resolves), so a save running alongside can't drop this one from the index.
   */
  private write(entries: IndexEntry[], chats: SavedChat[]) {
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    let size = 0;
    const kept = entries.slice(0, MAX_CHATS).filter((e, i) => (size += e.size) <= this.maxTotalChars || i === 0);
    const keep = new Set(kept.map((e) => e.id));
    return Promise.all([
      ...chats.filter((c) => keep.has(c.id)).map((c) => this.memento.update(CHAT + c.id, c)),
      this.memento.update(INDEX, kept),
      ...entries.filter((e) => !keep.has(e.id)).map((e) => this.memento.update(CHAT + e.id, undefined)),
    ]);
  }

  /**
   * Moves the old one-array store into per-chat keys, then removes it. A chat already stored at least as new
   * is left alone, so running it again (after a crash, or in a second window) loses nothing.
   */
  private async migrate() {
    const old = this.memento.get<SavedChat[]>(OLD_KEY);
    if (!old) {
      return;
    }
    const index = this.index();
    const stored = new Map(index.map((e) => [e.id, e.updatedAt]));
    const moved = old.filter((c) => c?.id && Array.isArray(c.transcript) && (stored.get(c.id) ?? -Infinity) < c.updatedAt);
    const ids = new Set(moved.map((c) => c.id));
    await this.write([...moved.map(indexEntry), ...index.filter((e) => !ids.has(e.id))], moved);
    await this.memento.update(OLD_KEY, undefined);
  }
}

/** Collects one chat's transcript as it happens. */
export class ChatRecorder {
  chat?: SavedChat;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly history: ChatHistory,
    /** Where a failed save is reported; saves run unawaited, so they never reject. */
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Starts recording into a saved chat (when one is reopened) or a fresh one on the next message. */
  load(chat: SavedChat | undefined) {
    this.chat = chat ? { ...chat, transcript: [...chat.transcript] } : undefined;
  }

  record(message: TranscriptEntry | { type: string }) {
    const msg = message as TranscriptEntry;
    if (!KEPT.has(msg.type)) {
      return;
    }
    if (msg.type === 'user') {
      this.chat ??= {
        id: randomUUID(),
        title: titleFrom(String(msg.text ?? '')),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        providers: [],
        transcript: [],
      };
    }
    const chat = this.chat;
    if (!chat) {
      return;
    }
    const t = chat.transcript;
    const last = t[t.length - 1];
    if (msg.type === 'delta' && last?.type === 'delta') {
      // Streamed text arrives in many small pieces; keep it as one. Once capped, the rest is dropped.
      const prev = String(last.text);
      if (prev.length <= MAX_TEXT) {
        const text = prev + String(msg.text);
        t[t.length - 1] = { type: 'delta', text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text };
      }
    } else if (LATEST_ONLY.has(msg.type)) {
      // Only the latest total or snapshot matters.
      const prev = t.findIndex((e) => e.type === msg.type);
      if (prev >= 0) {
        t.splice(prev, 1);
      }
      t.push(msg);
    } else {
      t.push(msg);
    }
    if (msg.type === 'assistantStart' && !chat.providers.includes(msg.provider as ProviderId)) {
      chat.providers.push(msg.provider as ProviderId);
    }
    if (t.length > MAX_ENTRIES) {
      t.splice(0, t.length - MAX_ENTRIES);
    }
    chat.updatedAt = Date.now();
  }

  /** Runs `save` after `ms`, once for a burst of messages; save() runs sooner and cancels it. */
  saveSoon(save: () => void, ms = 1000) {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      save();
    }, ms);
  }

  async save(sessionId: string | undefined) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.chat) {
      return;
    }
    if (sessionId) {
      this.chat.sessionId = sessionId;
    }
    await this.history.save(this.chat).catch((err) => this.log(`Saving the chat failed: ${errorMessage(err)}`));
  }
}

/** The newest entries whose JSON fits in `maxChars` (the newest one always stays). */
export function newestWithin(entries: TranscriptEntry[], maxChars: number): TranscriptEntry[] {
  let size = 2;
  let start = entries.length;
  while (start > 0) {
    size += JSON.stringify(entries[start - 1]).length + 1;
    if (size > maxChars && start < entries.length) {
      break;
    }
    start--;
  }
  return start ? entries.slice(start) : entries;
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'Untitled chat';
}

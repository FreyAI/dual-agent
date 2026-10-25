/**
 * Append-only JSONL records, one file per machine in a folder the user may sync
 * between machines (`<prefix>-<machine>.jsonl`). Reading merges every machine's
 * file; lines cut short by a crash or that don't parse are skipped.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Bytes compared to tell a rewritten file (pruned, or replaced by a sync) from one only appended to. */
const HEAD = 256;

/** How far a file has been read. */
interface Cursor {
  /** Bytes read, up to the end of the last whole line. */
  offset: number;
  /** The file's first bytes when it was first read. */
  head: Buffer;
}

export class JsonlLog<T> {
  private rows?: T[];
  /** Files may have grown since the last read. */
  private stale = false;
  private readonly seen = new Set<string>();
  private readonly cursors = new Map<string, Cursor>();
  /** Whether this machine's file ends mid-line; checked on the first append, then known. */
  private midLine?: boolean;

  constructor(
    private readonly dir: string,
    private readonly prefix: string,
    readonly machine: string,
    /** Drops rows that aren't the expected shape (files can be edited or synced half-written). */
    private readonly valid: (row: unknown) => row is T = (row): row is T => !!row && typeof row === 'object',
    /** Rows with the same key are read once (drops duplicates already in the files). */
    private readonly key?: (row: T) => string,
  ) {}

  get file(): string {
    return path.join(this.dir, `${this.prefix}-${this.machine.replace(/[^\w.-]/g, '_')}.jsonl`);
  }

  /** Every machine's rows, read once and cached; after reload() only the bytes added since are read. */
  all(): T[] {
    if (!this.rows) {
      this.forget();
    }
    if (this.stale) {
      this.stale = false;
      this.readNew();
    }
    return this.rows!;
  }

  /** Picks up rows written since (by another window or machine) on the next all(). */
  reload() {
    this.stale = true;
  }

  /** Drops this machine's rows older than `cutoff` (other machines prune their own files); never throws. */
  prune(cutoff: number, at: (row: T) => number) {
    try {
      this.rewrite(fs.readFileSync(this.file), cutoff, at);
    } catch {
      // No file yet.
    }
  }

  /** prune() with the read off the extension thread; the rows it parsed become the cache. */
  async pruneAsync(cutoff: number, at: (row: T) => number) {
    try {
      this.rewrite(await fs.promises.readFile(this.file), cutoff, at);
    } catch {
      // No file yet.
    }
  }

  /** Appends rows; throws when the folder can't be written, so callers can tell the user. */
  append(rows: T[]) {
    if (!rows.length) {
      return;
    }
    const lead = (this.midLine ??= endsMidLine(this.file)) ? '\n' : '';
    const text = lead + rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    try {
      fs.appendFileSync(this.file, text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file, text);
    }
    this.midLine = false;
    // Loaded: read the new bytes back (with any another window wrote), so nothing counts twice. Not loaded: the next read gets them.
    if (this.rows && !this.readFile(path.basename(this.file))) {
      this.rows = undefined;
    }
  }

  private forget() {
    this.rows = [];
    this.seen.clear();
    this.cursors.clear();
    this.stale = true;
  }

  /** Every file's new whole lines; everything again when one was rewritten or removed. */
  private readNew() {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.startsWith(`${this.prefix}-`) && f.endsWith('.jsonl'));
    } catch {
      // No folder yet.
    }
    const gone = [...this.cursors.keys()].some((f) => !files.includes(f));
    if (gone || !files.every((f) => this.readFile(f))) {
      this.forget();
      this.stale = false;
      files.forEach((f) => this.readFile(f));
    }
  }

  /** `name`'s whole lines added since the last read; false when it was rewritten since (another window's prune, or a sync). */
  private readFile(name: string): boolean {
    const cursor = this.cursors.get(name) ?? { offset: 0, head: Buffer.alloc(0) };
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(this.dir, name), 'r');
      const size = fs.fstatSync(fd).size;
      if (size < cursor.offset || !readAt(fd, 0, cursor.head.length).equals(cursor.head)) {
        return false;
      }
      // From the last newline read, which must still be one.
      const from = Math.max(0, cursor.offset - 1);
      const buf = readAt(fd, from, size - from);
      if (cursor.offset && buf[0] !== 0x0a) {
        return false;
      }
      const start = cursor.offset ? 1 : 0;
      // A last line still being written is read once it ends.
      const end = buf.lastIndexOf(0x0a) + 1;
      if (end > start) {
        this.ingest(buf.toString('utf8', start, end));
        if (!cursor.offset) {
          cursor.head = Buffer.from(buf.subarray(0, Math.min(HEAD, end)));
        }
        cursor.offset = from + end;
        this.cursors.set(name, cursor);
      }
      return true;
    } catch {
      // Unreadable or gone: skipped, tried again on the next read.
      return true;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }

  private ingest(text: string) {
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        this.add(JSON.parse(line));
      } catch {
        // A line cut short by a crash; skip it.
      }
    }
  }

  private add(row: unknown) {
    if (!this.valid(row)) {
      return;
    }
    const k = this.key?.(row);
    if (k !== undefined) {
      if (this.seen.has(k)) {
        return;
      }
      this.seen.add(k);
    }
    this.rows!.push(row);
  }

  /**
   * Writes back `buf` (this machine's file as read) without rows older than `cutoff`. Synchronous from the
   * size check to the write, so no append from this window lands in between; bytes appended since the read
   * (or a line still being written) are carried over as they are.
   */
  private rewrite(buf: Buffer, cutoff: number, at: (row: T) => number) {
    const end = buf.lastIndexOf(0x0a) + 1;
    const lines = buf.toString('utf8', 0, end).split('\n').filter((l) => l.trim());
    const parsed: unknown[] = [];
    const kept = lines.filter((line) => {
      try {
        const row = JSON.parse(line);
        const t = at(row);
        if (Number.isFinite(t) && t < cutoff) {
          return false;
        }
        parsed.push(row);
        return true;
      } catch {
        // A line cut short by a crash: nothing to keep.
        return false;
      }
    });
    let body = buf.subarray(0, end);
    if (kept.length < lines.length) {
      const fd = fs.openSync(this.file, 'r');
      let size: number, head: Buffer, rest: Buffer;
      try {
        size = fs.fstatSync(fd).size;
        head = readAt(fd, 0, Math.min(HEAD, end));
        rest = readAt(fd, end, size - end);
      } finally {
        fs.closeSync(fd);
      }
      if (size < buf.length || !head.equals(buf.subarray(0, head.length))) {
        // Another window rewrote it meanwhile.
        return;
      }
      body = Buffer.from(kept.length ? kept.join('\n') + '\n' : '');
      fs.writeFileSync(this.file, Buffer.concat([body, rest]));
    } else if (this.rows) {
      return;
    }
    // The rows parsed here are this file's cache; the rest (and other machines' files) are read on the next all().
    this.forget();
    parsed.forEach((row) => this.add(row));
    if (body.length) {
      this.cursors.set(path.basename(this.file), { offset: body.length, head: Buffer.from(body.subarray(0, HEAD)) });
    }
  }
}

/** The file exists, isn't empty and its last line was cut short (a crash mid-write): the next row must start on a new line. */
function endsMidLine(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    return !!size && readAt(fd, size - 1, 1)[0] !== 0x0a;
  } catch {
    // No file yet.
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** Up to `length` bytes of `fd` from `position` (fewer at the end of the file). */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, length));
  return buf.subarray(0, buf.length && fs.readSync(fd, buf, 0, buf.length, position));
}

/**
 * Unpacks a downloaded repository tarball (.tar.gz) into a folder without ever
 * trusting its contents: only regular files are written, never with execute
 * permission; anything that would land outside the folder (absolute paths,
 * `..`), symlinks, hard links and devices are skipped and reported; sizes and
 * file counts are capped so an archive bomb can't fill the disk.
 */
import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync } from 'zlib';

export interface ExtractLimits {
  /** Uncompressed bytes in total. */
  maxTotalBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}

export const DEFAULT_LIMITS: ExtractLimits = { maxTotalBytes: 100 * 1024 * 1024, maxFiles: 20_000, maxFileBytes: 5 * 1024 * 1024 };

export interface ExtractResult {
  files: string[];
  /** Entries left out, with why: links, unsafe paths, oversized files. */
  skipped: { path: string; reason: string }[];
  /** The commit the archive was made from (GitHub records it in a global header). */
  commit?: string;
  totalBytes: number;
}

const BLOCK = 512;

function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
}

const octal = (header: Buffer, start: number, length: number) => parseInt(field(header, start, length).trim() || '0', 8);

/** Pax extended-header records ("<len> key=value\n"). */
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) {
      break;
    }
    const length = parseInt(data.subarray(at, space).toString('utf8'), 10);
    if (!length || length <= 0) {
      break;
    }
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) {
      out[record.slice(0, eq)] = record.slice(eq + 1);
    }
    at += length;
  }
  return out;
}

/**
 * A path from the archive made safe to join under the destination, or a reason
 * it can't be. GitHub archives put everything under one "<repo>-<sha>/" folder,
 * which is dropped.
 */
export function safeEntryPath(name: string): string | { reason: string } {
  if (name.includes('\\')) {
    return { reason: 'backslash in the path' };
  }
  const parts = name.split('/').filter((p) => p && p !== '.');
  parts.shift();
  if (!parts.length) {
    return { reason: 'top-level folder' };
  }
  if (/^[a-zA-Z]:|^\//.test(name) || parts.some((p) => p === '..')) {
    return { reason: 'path escapes the folder' };
  }
  if (parts.some((p) => /[\u0000-\u001f]/.test(p))) {
    return { reason: 'control characters in the name' };
  }
  // Git metadata (hooks, config with fsmonitor) would make any later git command run code.
  if (parts.some((p) => p.toLowerCase() === '.git')) {
    return { reason: 'git metadata' };
  }
  return parts.join('/');
}

/** Unpacks `gz` (a .tar.gz) into `dest`, which must not exist yet. */
export function extractTarball(gz: Buffer, dest: string, limits: ExtractLimits = DEFAULT_LIMITS): ExtractResult {
  // maxOutputLength stops a small archive from inflating without bound.
  const tar = gunzipSync(gz, { maxOutputLength: limits.maxTotalBytes + 1024 * 1024 });
  fs.mkdirSync(dest, { recursive: true });
  const root = fs.realpathSync(dest);
  const result: ExtractResult = { files: [], skipped: [], totalBytes: 0 };
  const seen = new Set<string>();
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  for (let at = 0; at + BLOCK <= tar.length; ) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) {
      break;
    }
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const data = tar.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'g') {
      result.commit = paxRecords(data).comment ?? result.commit;
      continue;
    }
    if (type === 'x') {
      pax = paxRecords(data);
      continue;
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    const prefix = field(header, 345, 155);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    pax = {};
    longName = undefined;
    const rel = safeEntryPath(name);
    if (typeof rel !== 'string') {
      if (rel.reason !== 'top-level folder') {
        result.skipped.push({ path: name, reason: rel.reason });
      }
      continue;
    }
    if (type === '5') {
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') {
      const reason = type === '2' ? 'symlink' : type === '1' ? 'hard link' : `entry type ${JSON.stringify(type)}`;
      result.skipped.push({ path: rel, reason });
      continue;
    }
    if (size > limits.maxFileBytes) {
      result.skipped.push({ path: rel, reason: `larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB` });
      continue;
    }
    if (result.files.length >= limits.maxFiles) {
      throw new Error(`the repository has more than ${limits.maxFiles} files; pick a smaller one or a subfolder`);
    }
    if (result.totalBytes + size > limits.maxTotalBytes) {
      throw new Error(`the repository is larger than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB unpacked`);
    }
    // Two names differing only in case would overwrite each other on macOS and Windows.
    const key = rel.normalize('NFC').toLowerCase();
    if (seen.has(key)) {
      result.skipped.push({ path: rel, reason: 'same name as another file, differing only in case' });
      continue;
    }
    seen.add(key);
    const target = path.join(root, rel);
    if (!target.startsWith(root + path.sep)) {
      result.skipped.push({ path: rel, reason: 'path escapes the folder' });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Never executable, and never through a link: 'wx' fails rather than follow or overwrite.
    fs.writeFileSync(target, data, { mode: 0o644, flag: 'wx' });
    result.files.push(rel);
    result.totalBytes += size;
  }
  return result;
}

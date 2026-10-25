/**
 * The workspace's `.dual-agent` folder (index, memory, downloads) and safe file
 * writes into it. The folder's own .gitignore keeps it out of git, and with it
 * out of Claude Code's searches and the code index.
 */
import * as fs from 'fs';
import * as path from 'path';

/** A path under `<root>/.dual-agent`; nothing is created. */
export const workPath = (root: string, ...parts: string[]) => path.join(root, '.dual-agent', ...parts);

/** `<root>/.dual-agent/<sub>`, created along with the .gitignore that hides the whole folder. */
export function workFolder(root: string, sub: string): string {
  const dir = workPath(root, sub);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = workPath(root, '.gitignore');
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, '# Dual Agent working files (code index, project memory, downloads). Not part of the project.\n*\n');
  }
  return dir;
}

/**
 * A file's text, or undefined when it's missing or larger than `maxBytes`.
 * Other errors (EIO, EACCES, a sleeping external drive) throw, so a caller
 * never rewrites a file it merely failed to read.
 */
export function readText(file: string, maxBytes = Infinity): string | undefined {
  try {
    if (fs.statSync(file).size > maxBytes) {
      return undefined;
    }
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/** `readText` that never throws, for read-only uses where a failed read loses nothing. */
export function readTextOrUndefined(file: string, maxBytes = Infinity): string | undefined {
  try {
    return readText(file, maxBytes);
  } catch {
    return undefined;
  }
}

/** Writes through a temporary file and a rename, so a crash or a second window never leaves half a file. */
export function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Control characters removed (tabs and newlines kept, CRLF made LF). */
export const stripControl = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

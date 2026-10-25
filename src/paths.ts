/** Path helpers shared across the extension. */
import * as fs from 'fs';
import * as path from 'path';

/**
 * `p` with symlinks resolved; for a path that doesn't exist yet, its nearest
 * existing ancestor's, with the rest appended. Claude Code reports resolved
 * paths (macOS's /var is /private/var), so paths from it are compared with
 * this applied to both sides.
 */
export function resolvedPath(p: string): string {
  const missing: string[] = [];
  for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync(dir), ...missing.reverse());
    } catch {
      if (path.dirname(dir) === dir) {
        return path.resolve(p);
      }
      missing.push(path.basename(dir));
    }
  }
}

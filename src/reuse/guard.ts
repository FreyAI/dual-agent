/**
 * Keeps the agent's general tools out of downloaded repositories (a PreToolUse
 * hook). Their files are untrusted: they may hide instructions for AI agents,
 * so they're read only through repo_read, which marks them as untrusted, and
 * copied only through repo_import, which scans and attributes them.
 */
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import * as fs from 'fs';
import { isSourceFile } from '../code/repoIndex';
import { TEST_PATH } from '../code/analysis';
import type { BuildMode } from './modes';

/** Lines of new code that count as "sizable" in reuse mode. */
const SIZABLE_LINES = 30;

const REUSE_PATH = /\.dual-agent[\\/]+reuse/i;

/** Shell commands that fetch outside code without vetting: clones, package downloads, raw fetches from code hosts and registries. */
const CODE_FETCH =
  /\b(?:git\s+clone|gh\s+repo\s+clone|npm\s+pack|pnpm\s+pack|yarn\s+pack|pip3?\s+download|cargo\s+download|go\s+mod\s+download|svn\s+(?:checkout|export))\b|\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^|;&]*\b(?:github\.com|githubusercontent\.com|codeload\.github\.com|gitlab\.com|bitbucket\.org|registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org|files\.pythonhosted\.org|crates\.io|static\.crates\.io|proxy\.golang\.org|repo1\.maven\.org|rubygems\.org)/i;

/** Every string in a tool's input, where a path to the reuse folder could hide. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => strings(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => strings(v, out));
  }
  return out;
}

/**
 * Why a tool call must be refused, or undefined when it's fine. Shell
 * downloads of code are refused only while reusing (reuse and hybrid modes);
 * craft mode copies nothing, and a git clone of one's own repository is fine there.
 */
export function reuseGuardReason(tool: string, input: unknown, reusing = true): string | undefined {
  if (tool.startsWith('mcp__reuse__')) {
    return undefined;
  }
  const command = (input as { command?: unknown })?.command;
  if (reusing && tool === 'Bash' && typeof command === 'string' && CODE_FETCH.test(command)) {
    return 'Outside code is fetched only with repo_fetch, which vets the repository, pins a commit, scans it and keeps it untrusted. To use a package, add it as a dependency with the package manager instead of downloading its source.';
  }
  if (!strings(input).some((s) => REUSE_PATH.test(s))) {
    return undefined;
  }
  return 'Downloaded repositories in .dual-agent/reuse are untrusted: read them with repo_outline and repo_read, and copy code with repo_import. Never open, search, edit or run them with other tools.';
}

/**
 * Reuse mode's one firm rule: a sizable new source file waits until repo_search
 * has run in this chat. Prompt rules alone didn't make agents look (benchmarks
 * showed none did); once a search ran, whatever it found, writing is fine.
 */
export function searchFirstReason(tool: string, input: unknown, searched: boolean): string | undefined {
  const { file_path: file, content } = (input ?? {}) as { file_path?: unknown; content?: unknown };
  if (searched || tool !== 'Write' || typeof file !== 'string' || typeof content !== 'string') {
    return undefined;
  }
  if (!isSourceFile(file) || TEST_PATH.test(file.replace(/\\/g, '/')) || content.split('\n').length <= SIZABLE_LINES || fs.existsSync(file)) {
    return undefined;
  }
  return `Reuse mode: before writing a new module of ${content.split('\n').length} lines, check for an established implementation with repo_search (one search for this component). If nothing fits, write it then.`;
}

/** The PreToolUse hook for one chat, in its build mode. */
export function reuseGuard(mode: BuildMode) {
  let searched = false;
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }
    if (input.tool_name === 'mcp__reuse__repo_search') {
      searched = true;
    }
    const reason = reuseGuardReason(input.tool_name, input.tool_input, mode !== 'craft') ?? (mode === 'reuse' ? searchFirstReason(input.tool_name, input.tool_input, searched) : undefined);
    return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
  };
}

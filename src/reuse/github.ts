/**
 * GitHub access for reuse mode: repository search, metadata, resolving a ref to
 * an exact commit, and downloading that commit as a tarball into the
 * workspace's reuse folder. Only GitHub's own servers are contacted
 * (api.github.com, codeload.github.com); nothing from the repository runs.
 * A GITHUB_TOKEN in the credentials file raises the rate limits.
 */
import * as fs from 'fs';
import * as path from 'path';
import { HttpResponse, httpRequest, parseJson } from '../web/http';
import { ExtractResult, extractTarball } from './tarball';
import { workFolder } from '../memory/files';

export interface RepoInfo {
  fullName: string;
  description: string;
  url: string;
  stars: number;
  forks: number;
  openIssues: number;
  /** ISO dates. */
  createdAt: string;
  pushedAt: string;
  archived: boolean;
  fork: boolean;
  /** SPDX id, "NOASSERTION" for an unrecognized license, undefined for none. */
  license?: string;
  defaultBranch: string;
  /** Repository size in KB, as GitHub reports it. */
  sizeKb: number;
  topics: string[];
  language?: string;
  ownerType: string;
  /** Only in single-repository answers, not search results. */
  disabled?: boolean;
  /** The upstream "owner/repo" of a fork, when GitHub reports it. */
  parent?: string;
}

export interface Contributor { login: string; contributions: number }
export interface Release { tag: string; publishedAt?: string }

const API = 'https://api.github.com';

/** GitHub's API quota is used up; the reuse tools can fall back to web search and deps.dev. */
export class RateLimitError extends Error {}
const MAX_TARBALL_BYTES = 30 * 1024 * 1024;

function toInfo(r: any): RepoInfo {
  return {
    fullName: r.full_name,
    description: r.description ?? '',
    url: r.html_url,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    openIssues: r.open_issues_count ?? 0,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    archived: !!r.archived,
    fork: !!r.fork,
    license: r.license?.spdx_id ?? undefined,
    defaultBranch: r.default_branch ?? 'main',
    sizeKb: r.size ?? 0,
    topics: r.topics ?? [],
    language: r.language ?? undefined,
    ownerType: r.owner?.type ?? 'User',
    ...(r.disabled ? { disabled: true } : {}),
    ...(r.parent?.full_name ? { parent: r.parent.full_name } : {}),
  };
}

/** "owner/repo" from that form or a github.com URL; throws on anything else. */
export function parseRepo(input: string): { owner: string; repo: string } {
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') {
    throw new Error(`"${input}" isn't a GitHub repository; use owner/repo`);
  }
  return { owner: m[1], repo: m[2] };
}

const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README.rst', 'README.txt', 'README'];
const MAX_README_BYTES = 200_000;

/**
 * A repository's README from GitHub's raw-file server (not the API, so no
 * quota), at its default branch; undefined if it has none.
 */
export async function fetchReadme(owner: string, repo: string, http = httpRequest): Promise<{ name: string; text: string } | undefined> {
  for (const name of README_NAMES) {
    const res = await http(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${name}`, { timeoutMs: 15_000, maxBytes: MAX_README_BYTES, accept: 'text/plain', publicOnly: true });
    if (res.status === 200) {
      return { name, text: res.text() };
    }
  }
  return undefined;
}

/**
 * README text as the agent should see it: images, badges and HTML tags removed
 * (nothing is rendered, so no tracking pixel or badge server is contacted), blank runs collapsed.
 */
export function cleanReadme(text: string): string {
  return text
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<\/?(?:p|div|a|b|i|em|strong|center|picture|source|br|h\d|span|sup|sub|details|summary|table|tr|td|th)\b[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class GitHub {
  constructor(private readonly token?: string) {}

  private async api(pathAndQuery: string, accept = 'application/vnd.github+json'): Promise<HttpResponse> {
    const res = await httpRequest(`${API}${pathAndQuery}`, {
      timeoutMs: 20_000,
      maxBytes: 5 * 1024 * 1024,
      accept,
      headers: { 'X-GitHub-Api-Version': '2022-11-28', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
    });
    // A 403 is a rate limit only when GitHub says so; otherwise access is refused (blocked repo, bad token scope).
    if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) {
      // Worded for the agent to relay, not act on: it must never go looking for tokens itself.
      throw new RateLimitError(
        `GitHub's rate limit was reached${this.token ? '' : ' (60 requests an hour without a token)'}. Stop using the reuse tools for now and tell the user; ` +
          'they can wait, or add a GitHub token to their credentials file themselves. Do not search for, read or use any token or credential yourself.',
      );
    }
    if (res.status === 404) {
      throw new Error('not found on GitHub (or private)');
    }
    if (res.status >= 400) {
      const why = /"message"\s*:\s*"([^"]{1,200})"/.exec(res.text())?.[1];
      throw new Error(`GitHub answered HTTP ${res.status}${why ? `: ${why}` : ''}`);
    }
    return res;
  }

  /** Repository search, most-starred first; `query` may use GitHub qualifiers. */
  async search(query: string, perPage = 10): Promise<RepoInfo[]> {
    const q = encodeURIComponent(query);
    const body = await this.json(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}`);
    return (body?.items ?? []).map(toInfo);
  }

  async repo(owner: string, repo: string): Promise<RepoInfo> {
    return toInfo(parseJson(await this.api(`/repos/${owner}/${repo}`)));
  }

  /** The exact commit a branch, tag or SHA points to. */
  async commit(owner: string, repo: string, ref: string): Promise<string> {
    const sha = (await this.api(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, 'application/vnd.github.sha')).text().trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`couldn't resolve ${ref} to a commit`);
    }
    return sha;
  }

  /** Parsed JSON; null for an empty body (GitHub sends 204 for an empty repository's contributors). */
  private async json(pathAndQuery: string): Promise<any> {
    const res = await this.api(pathAndQuery);
    return res.text().trim() ? parseJson(res) : null;
  }

  /** Top contributors by commits; anonymous (unlinked) authors left out. */
  async contributors(owner: string, repo: string): Promise<Contributor[]> {
    const body = await this.json(`/repos/${owner}/${repo}/contributors?per_page=30&anon=0`);
    return (body ?? []).map((c: any) => ({ login: c.login, contributions: c.contributions ?? 0 }));
  }

  /** The latest few releases, newest first. */
  async releases(owner: string, repo: string): Promise<Release[]> {
    const body = await this.json(`/repos/${owner}/${repo}/releases?per_page=5`);
    return (body ?? []).map((r: any) => ({ tag: r.tag_name, publishedAt: r.published_at ?? undefined }));
  }

  /** A user's or organization's account age and type. */
  async user(login: string): Promise<{ createdAt: string; type: string }> {
    const u = await this.json(`/users/${encodeURIComponent(login)}`);
    return { createdAt: u.created_at, type: u.type ?? 'User' };
  }

  /** The detected license and its full text, optionally at a ref. */
  async license(owner: string, repo: string, ref?: string): Promise<{ spdx?: string; text: string }> {
    const body = await this.json(`/repos/${owner}/${repo}/license${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
    return { spdx: body.license?.spdx_id ?? undefined, text: Buffer.from(body.content ?? '', 'base64').toString('utf8') };
  }

  /** Every path in a commit or branch (GitHub truncates very large trees). */
  async tree(owner: string, repo: string, sha: string): Promise<string[]> {
    const body = await this.json(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`);
    return (body?.tree ?? []).map((e: any) => e.path);
  }

  /** Downloads one commit as a tarball and unpacks it safely into `dest`. */
  download(owner: string, repo: string, sha: string, dest: string): Promise<ExtractResult> {
    return removeOnFailure(dest, async () => {
      const result = await this.archive(owner, repo, sha, dest);
      // The archive names the commit it was made from: it must be the one asked for.
      if (result.commit && result.commit !== sha) {
        throw new Error(`the download was of commit ${result.commit.slice(0, 7)}, not the requested ${sha.slice(0, 7)}`);
      }
      return result;
    });
  }

  /**
   * Downloads the default branch's latest commit without any API call (the
   * archive server isn't rate-limited); the commit it pins comes from the archive.
   */
  downloadLatest(owner: string, repo: string, dest: string): Promise<ExtractResult & { commit: string }> {
    return removeOnFailure(dest, async () => {
      const result = await this.archive(owner, repo, 'HEAD', dest);
      if (!result.commit || !/^[0-9a-f]{40}$/.test(result.commit)) {
        throw new Error(`the archive of ${owner}/${repo} doesn't name its commit, so it can't be pinned`);
      }
      return result as ExtractResult & { commit: string };
    });
  }

  private async archive(owner: string, repo: string, ref: string, dest: string): Promise<ExtractResult> {
    const res = await httpRequest(`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`, {
      timeoutMs: 120_000,
      maxBytes: MAX_TARBALL_BYTES,
      accept: 'application/gzip',
      publicOnly: true,
      // No token: public downloads stay anonymous, and a token never travels with them.
    });
    if (res.status !== 200) {
      throw new Error(`downloading ${owner}/${repo} failed (HTTP ${res.status})`);
    }
    if (res.truncated) {
      throw new Error(`${owner}/${repo} is larger than ${MAX_TARBALL_BYTES / 1024 / 1024} MB compressed; reuse a smaller repository`);
    }
    return extractTarball(res.bytes, dest);
  }
}

/**
 * Moves a finished download from its staging folder to `target`. When another
 * chat already put the same commit there, its copy is kept and ours deleted.
 */
export function moveIntoPlace(staging: string, target: string) {
  try {
    if (!fs.existsSync(target)) {
      fs.renameSync(staging, target);
      return;
    }
  } catch (err) {
    // Lost a race: the other chat's rename landed first.
    if (!fs.existsSync(target)) {
      throw err;
    }
  }
  fs.rmSync(staging, { recursive: true, force: true });
}

/** A staging folder no other chat or process uses, next to where the download ends up. */
export const stagingDir = (root: string, owner: string, repo: string) =>
  path.join(reuseFolder(root), `${owner}__${repo}@staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

/** Runs `work`, deleting `dir` if it fails, so a broken download or unpack leaves no half-filled folder. */
export async function removeOnFailure<T>(dir: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * The workspace folder downloads go in. Its own .gitignore keeps it out of git,
 * and with it out of Claude Code's searches and the code index.
 */
export const reuseFolder = (root: string) => workFolder(root, 'reuse');

/** Where one downloaded commit lives: <workspace>/.dual-agent/reuse/<owner>__<repo>@<sha7>. */
export const checkoutDir = (root: string, owner: string, repo: string, sha: string) => path.join(reuseFolder(root), `${owner}__${repo}@${sha.slice(0, 7)}`);

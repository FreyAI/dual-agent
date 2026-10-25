/**
 * Reuse without GitHub's API, for when its quota is used up: candidates come
 * from web search (site:github.com), metadata and the OpenSSF score from
 * deps.dev, and downloads from the archive server, which isn't rate-limited.
 * Vetting is limited (no age, push, contributor or lookalike checks), so the
 * bar is higher: deps.dev must know the project and it needs 100+ stars.
 */
import { httpRequest } from '../web/http';
import { Assessment, WEIGHTS } from './assess';
import type { RepoInfo } from './github';
import { licensePolicy } from './license';

export interface WebHit {
  url: string;
  title?: string;
  snippet?: string;
}

export type WebSearch = (query: string, count: number) => Promise<WebHit[]>;

export const FALLBACK_MIN_STARS = 100;

/** GitHub paths that look like owner/repo but aren't repositories. */
const NOT_REPOS = new Set(['topics', 'orgs', 'sponsors', 'features', 'marketplace', 'collections', 'settings', 'apps', 'login', 'about', 'search', 'trending', 'explore', 'pricing', 'enterprise', 'security', 'site', 'readme', 'events', 'customer-stories', 'team']);

/** Distinct owner/repo pairs from search results, in order. */
export function reposFromHits(hits: WebHit[]): { owner: string; repo: string }[] {
  const seen = new Set<string>();
  const out: { owner: string; repo: string }[] = [];
  for (const hit of hits) {
    const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/.exec(hit.url);
    if (!m || NOT_REPOS.has(m[1].toLowerCase())) {
      continue;
    }
    const key = `${m[1]}/${m[2]}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ owner: m[1], repo: m[2] });
    }
  }
  return out;
}

/** A repository as deps.dev knows it, or undefined if it doesn't. */
export async function depsDevRepo(owner: string, repo: string, http = httpRequest): Promise<{ info: RepoInfo; scorecard?: number } | undefined> {
  const res = await http(`https://api.deps.dev/v3/projects/${encodeURIComponent(`github.com/${owner}/${repo}`)}`, { timeoutMs: 15_000, accept: 'application/json' });
  if (res.status !== 200) {
    return undefined;
  }
  const d = JSON.parse(res.text());
  return {
    info: {
      fullName: `${owner}/${repo}`,
      description: d.description ?? '',
      url: `https://github.com/${owner}/${repo}`,
      stars: d.starsCount ?? 0,
      forks: d.forksCount ?? 0,
      openIssues: d.openIssuesCount ?? 0,
      // Unknown without GitHub's API.
      createdAt: '',
      pushedAt: '',
      archived: false,
      fork: false,
      license: d.license || undefined,
      defaultBranch: 'HEAD',
      sizeKb: 0,
      topics: [],
      ownerType: 'User',
    },
    scorecard: d.scorecard?.overallScore,
  };
}

/** Candidates from web search, each looked up on deps.dev; projects deps.dev doesn't know are left out. */
export async function fallbackSearch(web: WebSearch, query: string, language: string | undefined, limit: number, http = httpRequest): Promise<RepoInfo[]> {
  const hits = await web(`site:github.com ${query}${language ? ` ${language}` : ''}`, 10);
  const found: RepoInfo[] = [];
  for (const { owner, repo } of reposFromHits(hits).slice(0, limit + 4)) {
    const known = await depsDevRepo(owner, repo, http).catch(() => undefined);
    if (known) {
      found.push({ ...known.info, language });
    }
    if (found.length >= limit) {
      break;
    }
  }
  return found.sort((a, b) => b.stars - a.stars);
}

/** The vetting possible from deps.dev alone; unknown signals count half, and the gaps are stated. */
export function limitedAssessment(info: RepoInfo, scorecard: number | undefined, projectSpdx?: string): Assessment {
  const license = licensePolicy(info.license, projectSpdx);
  const hardFailures: string[] = [];
  if (!license.allowed) {
    hardFailures.push(`license: ${license.reason}`);
  }
  if (info.stars < FALLBACK_MIN_STARS) {
    hardFailures.push(`only ${info.stars} stars; without GitHub's API the bar is ${FALLBACK_MIN_STARS}+, since age and lookalike checks can't run`);
  }
  const parts: Record<string, number> = {
    maintenance: 0.5,
    scorecard: scorecard === undefined ? 0.5 : scorecard / 10,
    busFactor: 0.5,
    testsCi: 0.5,
    adoption: Math.min(1, Math.log10(info.stars + 1) / 4),
    issues: info.stars ? (info.openIssues / info.stars < 0.05 ? 1 : info.openIssues / info.stars < 0.2 ? 0.6 : 0.3) : 0.3,
  };
  const trust = Math.round(Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * parts[k], 0));
  return {
    repo: info,
    hardFailures,
    warnings: [
      "limited vetting (GitHub's API quota is used up): repository and owner age, last push, archived and fork status, contributors, tests and lookalike repositories weren't checked",
      ...(scorecard !== undefined && scorecard < 4 ? [`low OpenSSF Scorecard (${scorecard}/10)`] : []),
    ],
    trust,
    parts,
    license,
    scorecard,
  };
}

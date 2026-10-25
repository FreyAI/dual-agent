/**
 * Vetting a candidate repository before reuse: hard filters that rule it out,
 * then a 0–100 trust score from cheap public signals. Stars alone are never
 * trusted, and a missing signal costs a warning, never an exception.
 */
import { httpRequest } from '../web/http';
import { Contributor, GitHub, Release, RepoInfo } from './github';
import { LicenseVerdict, licensePolicy } from './license';

export interface Assessment {
  repo: RepoInfo;
  sha?: string;
  hardFailures: string[];
  warnings: string[];
  trust: number;
  /** Each signal as a fraction 0–1, before weighting. */
  parts: Record<string, number>;
  license: LicenseVerdict;
  scorecard?: number;
}

export interface AssessDeps {
  gh: Pick<GitHub, 'repo' | 'contributors' | 'releases' | 'user' | 'tree' | 'search'>;
  scorecard?: (owner: string, repo: string) => Promise<number | undefined>;
  now?: number;
}

export const WEIGHTS: Record<string, number> = { maintenance: 25, scorecard: 20, busFactor: 15, testsCi: 15, adoption: 15, issues: 10 };
const STAR_INFLATION_PENALTY = 30;
const DAY = 86_400_000;
const MONTH = 30.44 * DAY;

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)(\/|$|\.[^/]+$)|[._](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/i;
const CI_PATH = /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.travis\.yml|\.circleci\/|azure-pipelines\.ya?ml|Jenkinsfile|\.drone\.yml|appveyor\.yml|\.buildkite\/|bitbucket-pipelines\.yml)/i;

const ageMs = (iso: string | undefined, now: number) => (iso ? now - Date.parse(iso) : Infinity);

function maintenance(info: RepoInfo, releases: Release[] | undefined, now: number): number {
  const since = ageMs(info.pushedAt, now);
  const base = since <= 6 * MONTH ? 1 : since <= 12 * MONTH ? 0.7 : since <= 24 * MONTH ? 0.3 : 0;
  const recentRelease = releases?.some((r) => ageMs(r.publishedAt, now) <= 12 * MONTH);
  return Math.min(1, base + (recentRelease ? 0.3 : 0));
}

/** Contributors with at least 5% of the commits: one is a bus factor of one. */
function significant(contributors: Contributor[]): number {
  const total = contributors.reduce((n, c) => n + c.contributions, 0);
  return contributors.filter((c) => total > 0 && c.contributions / total >= 0.05).length;
}

const busFactor = (n: number) => (n >= 3 ? 1 : n === 2 ? 0.6 : 0.2);

/** Open issues (and PRs) per star; a cheap stand-in for real issue response times. */
function issueProxy(info: RepoInfo): number {
  const ratio = info.openIssues / Math.max(info.stars, 1);
  return ratio < 0.05 ? 1 : ratio < 0.2 ? 0.6 : 0.3;
}

/** Runs an optional lookup; a failure becomes a warning and undefined. */
async function optional<T>(warnings: string[], label: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    warnings.push(`${label} unavailable (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}

function hardFilters(info: RepoInfo, license: LicenseVerdict, rivals: RepoInfo[] | undefined, ownerCreated: string | undefined, now: number): string[] {
  const fails: string[] = [];
  const name = info.fullName.split('/')[1]?.toLowerCase();
  if (info.archived || info.disabled) {
    fails.push(`the repository is ${info.archived ? 'archived' : 'disabled'}`);
  }
  if (info.fork) {
    fails.push(`it's a fork; use the parent ${info.parent ?? 'repository'} instead`);
  }
  if (!license.allowed) {
    fails.push(`license: ${license.reason}`);
  }
  if (ageMs(info.createdAt, now) < 90 * DAY) {
    fails.push('the repository is less than 90 days old');
  }
  if (ownerCreated && ageMs(ownerCreated, now) < 180 * DAY) {
    fails.push('the owner account is less than 180 days old');
  }
  const rival = rivals?.find((r) => r.fullName.toLowerCase() !== info.fullName.toLowerCase() && r.fullName.split('/')[1]?.toLowerCase() === name && r.stars >= 10 * Math.max(info.stars, 1));
  if (rival) {
    fails.push(`possible repo confusion: ${rival.fullName} has the same name and ${rival.stars} stars (vs ${info.stars}); use that one if it's what you meant`);
  }
  return fails;
}

export async function assessRepo(deps: AssessDeps, owner: string, repo: string, projectSpdx?: string): Promise<Assessment> {
  const now = deps.now ?? Date.now();
  const { gh } = deps;
  const info = await gh.repo(owner, repo);
  const [o, r] = info.fullName.split('/');
  const warnings: string[] = [];
  const [contributors, releases, user, tree, rivals, scorecard] = await Promise.all([
    optional(warnings, 'contributor list', () => gh.contributors(o, r)),
    optional(warnings, 'release list', () => gh.releases(o, r)),
    optional(warnings, 'owner account age', () => gh.user(o)),
    optional(warnings, 'file tree', () => gh.tree(o, r, info.defaultBranch)),
    optional(warnings, 'repo-confusion check', () => gh.search(`${r} in:name fork:false`)),
    deps.scorecard ? optional(warnings, 'OpenSSF Scorecard', () => deps.scorecard!(o, r)) : Promise.resolve(undefined),
  ]);
  const license = licensePolicy(info.license, projectSpdx);
  const hardFailures = hardFilters(info, license, rivals, user?.createdAt, now);

  const maintainers = contributors?.length ? significant(contributors) : undefined;
  const hasTests = tree?.some((p) => TEST_PATH.test(p));
  const hasCi = tree?.some((p) => CI_PATH.test(p));
  const parts: Record<string, number> = {
    maintenance: maintenance(info, releases, now),
    scorecard: scorecard === undefined ? 0.5 : Math.max(0, Math.min(1, scorecard / 10)),
    busFactor: maintainers === undefined ? 0.5 : busFactor(maintainers),
    testsCi: tree ? (hasTests ? 0.5 : 0) + (hasCi ? 0.5 : 0) : 0.5,
    adoption: Math.min(1, Math.log10(info.stars + 1) / 4),
    issues: issueProxy(info),
  };

  if (releases && !releases.some((x) => ageMs(x.publishedAt, now) <= 24 * MONTH)) {
    warnings.push('no GitHub release in the last 24 months');
  }
  if (maintainers === 1) {
    warnings.push('single maintainer (bus factor 1)');
  }
  if (tree && !hasTests) {
    warnings.push('no tests found');
  }
  if (tree && !hasCi) {
    warnings.push('no CI configuration found');
  }
  if (scorecard === undefined) {
    warnings.push('OpenSSF Scorecard unknown; counted as 5/10');
  } else if (scorecard < 4) {
    warnings.push(`low OpenSSF Scorecard (${scorecard}/10)`);
  }
  const inflated = info.stars > 1000 && info.forks / info.stars < 0.01 && contributors !== undefined && contributors.length <= 2;
  if (inflated) {
    warnings.push(`possible star inflation: ${info.stars} stars but only ${info.forks} forks and ${contributors.length} contributor(s); −${STAR_INFLATION_PENALTY} trust`);
  }

  const score = Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * parts[k], 0);
  const trust = Math.max(0, Math.min(100, Math.round(score) - (inflated ? STAR_INFLATION_PENALTY : 0)));
  return { repo: info, hardFailures, warnings, trust, parts, license, scorecard };
}

/** A Scorecard number between 0 and 10, or undefined. */
const validScore = (n: unknown) => (typeof n === 'number' && n >= 0 && n <= 10 ? n : undefined);

async function fetchJson(url: string): Promise<any> {
  const res = await httpRequest(url, { timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024, accept: 'application/json' });
  return res.status === 200 ? JSON.parse(res.text()) : undefined;
}

/** OpenSSF Scorecard from its own API, falling back to deps.dev; undefined when neither knows the repo. */
export function scorecardFromApis(): (owner: string, repo: string) => Promise<number | undefined> {
  return async (owner, repo) => {
    const o = encodeURIComponent(owner);
    const r = encodeURIComponent(repo);
    const sources: [string, (b: any) => unknown][] = [
      [`https://api.securityscorecards.dev/projects/github.com/${o}/${r}`, (b) => b?.score],
      [`https://api.deps.dev/v3/projects/github.com%2F${o}%2F${r}`, (b) => b?.scorecard?.overallScore],
    ];
    for (const [url, pick] of sources) {
      const score = validScore(pick(await fetchJson(url).catch(() => undefined)));
      if (score !== undefined) {
        return score;
      }
    }
    return undefined;
  };
}

const LABELS: Record<string, string> = { maintenance: 'maintenance', scorecard: 'scorecard', busFactor: 'bus factor', testsCi: 'tests+CI', adoption: 'adoption', issues: 'issues (open/star proxy)' };

/** A compact summary for the model and the approval card. */
export function formatAssessment(a: Assessment): string {
  const r = a.repo;
  const verdict = a.hardFailures.length ? 'REJECTED' : `trust ${a.trust}/100`;
  const lines = [`${r.fullName}${a.sha ? `@${a.sha.slice(0, 7)}` : ''} · ★${r.stars} · ${r.license ?? 'no license'} · ${verdict}`];
  if (r.description) {
    lines.push(r.description.slice(0, 200));
  }
  lines.push(...a.hardFailures.map((f) => `FAIL: ${f}`));
  lines.push(...a.warnings.map((w) => `warn: ${w}`));
  lines.push(`score: ${Object.entries(WEIGHTS).map(([k, w]) => `${LABELS[k]} ${Math.round(w * a.parts[k])}/${w}`).join(', ')}`);
  const scope = a.license.scope ? ` (${a.license.scope})` : '';
  lines.push(`license: ${a.license.allowed ? 'allowed' : 'blocked'}${scope}; ${a.license.obligations.length ? a.license.obligations.join('; ') : a.license.reason}`);
  return lines.join('\n');
}

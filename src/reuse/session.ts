/**
 * One chat's reuse state: the repositories it fetched, vetted and scanned, and
 * what each reuse tool does with them. The MCP server over it (zod schemas) is
 * in tools.ts, loaded only when an agent starts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { extractSymbols, workspacePath } from '../code/repoIndex';
import { wrapUntrusted } from '../web/untrusted';
import { Assessment, assessRepo, formatAssessment, scorecardFromApis } from './assess';
import { GitHub, RateLimitError, RepoInfo, checkoutDir, cleanReadme, fetchReadme, moveIntoPlace, parseRepo, removeOnFailure, reuseFolder, stagingDir } from './github';
import { WebSearch, depsDevRepo, fallbackSearch, limitedAssessment } from './fallback';
import { ImportSpec, PROVENANCE, importFiles } from './importer';

export { PROVENANCE as PROVENANCE_FILE };
import { detectFileLicense, extractCopyright, licensePolicy } from './license';
import { ScanResult, formatFindings, scanTree } from './scan';

/** Tools that change nothing in the project; repo_import is left out so it always asks. */
export const REUSE_AUTO_TOOLS = ['repo_search', 'repo_readme', 'repo_fetch', 'repo_outline', 'repo_read', 'repo_cleanup'].map((t) => `mcp__reuse__${t}`);
export const MAX_README_LINES = 150;
export const REUSE_IMPORT_TOOL = 'mcp__reuse__repo_import';

export const MAX_READ_LINES = 400;
const DAY = 86_400_000;

interface Checkout {
  owner: string;
  repo: string;
  sha: string;
  dir: string;
  assessment: Assessment;
  scan: ScanResult;
  /** Vetted from deps.dev alone because GitHub's API quota was used up. */
  limited: boolean;
}

/** The project's own license, which decides whether copyleft code may come in. */
export function projectLicense(root: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg.license === 'string') {
      return pkg.license;
    }
  } catch {
    // No package.json.
  }
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
    try {
      return detectFileLicense(fs.readFileSync(path.join(root, name), 'utf8'));
    } catch {
      // Not there.
    }
  }
  return undefined;
}

/** One line per search result, with the cheap checks that need no extra requests. */
function candidateLine(r: RepoInfo, projectSpdx: string | undefined, now: number): string {
  const license = licensePolicy(r.license, projectSpdx);
  // Dates are unknown when the candidates came from the fallback.
  const ageDays = r.createdAt ? Math.round((now - Date.parse(r.createdAt)) / DAY) : undefined;
  const pushedDays = r.pushedAt ? Math.round((now - Date.parse(r.pushedAt)) / DAY) : undefined;
  const flags = [
    !license.allowed ? `license blocked (${license.reason})` : '',
    ageDays !== undefined && ageDays < 90 ? 'repository under 90 days old' : '',
    pushedDays !== undefined && pushedDays > 730 ? 'no push in 2 years' : '',
  ].filter(Boolean);
  const pushed = pushedDays === undefined ? 'last push unknown' : `pushed ${pushedDays}d ago`;
  return `${r.fullName} ★${r.stars} · ${r.language ?? '?'} · ${r.license ?? 'no license'} · ${pushed} · ${r.description.slice(0, 120)}${flags.length ? `\n    ⚠ ${flags.join('; ')}` : ''}`;
}

/** The state of one chat's downloads, and the reuse MCP server over it. */
export class ReuseSession {
  private checkouts = new Map<string, Checkout>();

  constructor(
    private readonly root: () => string,
    private readonly token: () => string | undefined,
    /** Whether a person sees an approval card for imports (false in Bypass mode). */
    private readonly approvalShown: () => boolean,
    /** Web search, for finding candidates when GitHub's API quota is used up. */
    private readonly web?: WebSearch,
  ) {}

  private find(repo: string): Checkout {
    const { owner, repo: name } = parseRepo(repo);
    const hit = this.checkouts.get(`${owner}/${name}`.toLowerCase());
    if (!hit) {
      throw new Error(`${owner}/${name} isn't fetched; call repo_fetch first`);
    }
    return hit;
  }

  /** What the approval card shows for an import: license, obligations and the scan findings in those files. */
  describeImport(input: Record<string, unknown>): string | undefined {
    try {
      const c = this.find(String(input.repo));
      const files = (Array.isArray(input.files) ? input.files : []) as ImportSpec[];
      const findings = c.scan.findings.filter((f) => files.some((s) => s.from === f.file));
      return [
        `Import from ${c.owner}/${c.repo} at ${c.sha.slice(0, 7)} (trust ${c.assessment.trust}/100)`,
        ...(c.limited ? ['⚠ Limited vetting: GitHub\'s API quota was used up, so age, last push, contributors and lookalike checks didn\'t run.'] : []),
        `License: ${c.assessment.license.spdx ?? 'none'}: ${c.assessment.license.reason}`,
        ...(c.assessment.license.obligations.length ? [`Obligations: ${c.assessment.license.obligations.join('; ')}`] : []),
        '',
        ...files.map((s) => `  ${s.from} → ${s.to}`),
        '',
        findings.length ? formatFindings({ findings, filesScanned: files.length, counts: { critical: 0, high: 0, medium: 0, low: 0 } }, 20) : 'No scan findings in these files.',
      ].join('\n');
    } catch {
      return undefined;
    }
  }

  async search(query: string, language?: string, minStars = 100, limit = 6): Promise<string> {
    // Web search plus deps.dev first: it costs none of GitHub's small API quota, which repo_fetch's vetting needs.
    let results: RepoInfo[] = [];
    let source = 'web search + deps.dev; last push shows after repo_fetch';
    if (this.web) {
      results = await fallbackSearch(this.web, query, language, Math.min(limit, 10)).catch(() => []);
      results = results.filter((r) => r.stars >= minStars);
    }
    if (!results.length) {
      const q = [query, language ? `language:${language}` : '', `stars:>=${minStars}`, 'archived:false', 'fork:false'].filter(Boolean).join(' ');
      results = await new GitHub(this.token()).search(q, Math.min(limit, 10));
      source = 'GitHub search';
    }
    if (!results.length) {
      return `No repositories match "${query}". Try other words or a lower min_stars, or write it yourself.`;
    }
    const spdx = projectLicense(this.root());
    return `Candidates for "${query}" (${source}; most stars first, and stars alone can be faked). Read the READMEs of the likely ones with repo_readme, then repo_fetch the best fit, which vets it fully:\n${results.map((r) => candidateLine(r, spdx, Date.now())).join('\n')}`;
  }

  /** A candidate's README, before anything is downloaded: to judge fit. Untrusted, never rendered. */
  async readme(repo: string): Promise<string> {
    const { owner, repo: name } = parseRepo(repo);
    const found = await fetchReadme(owner, name);
    if (!found) {
      return `${owner}/${name} has no README at its default branch.`;
    }
    const lines = cleanReadme(found.text).split('\n');
    const more = lines.length > MAX_README_LINES ? `\n(first ${MAX_README_LINES} of ${lines.length} lines)` : '';
    return `${wrapUntrusted(`repo_readme ${owner}/${name}/${found.name}`, lines.slice(0, MAX_README_LINES).join('\n'))}${more}`;
  }

  async fetch(repo: string, ref?: string): Promise<string> {
    const { owner, repo: name } = parseRepo(repo);
    const gh = new GitHub(this.token());
    const spdx = projectLicense(this.root());
    let assessment: Assessment;
    let limited = false;
    try {
      assessment = await assessRepo({ gh, scorecard: scorecardFromApis() }, owner, name, spdx);
    } catch (err) {
      if (!(err instanceof RateLimitError)) {
        throw err;
      }
      const known = await depsDevRepo(owner, name);
      if (!known) {
        throw new Error(`GitHub's API quota is used up and deps.dev doesn't know ${owner}/${name}, so it can't be vetted. Pick a better-known repository, or wait for the quota to reset.`);
      }
      assessment = limitedAssessment(known.info, known.scorecard, spdx);
      limited = true;
    }
    if (assessment.hardFailures.length) {
      throw new Error(`${owner}/${name} fails the checks, so it wasn't downloaded:\n${formatAssessment(assessment)}`);
    }
    // The commit is pinned through the API, or, without quota, read from the archive itself.
    let sha: string | undefined;
    if (!limited) {
      sha = await gh.commit(owner, name, ref ?? assessment.repo.defaultBranch).catch((err) => {
        if (err instanceof RateLimitError) {
          return undefined;
        }
        throw err;
      });
    }
    if (!sha && ref) {
      throw new Error(`a specific ref (${ref}) needs GitHub's API, whose quota is used up; fetch without ref for the latest commit, or wait`);
    }
    // Unpacked in a folder of this call's own and then moved, so two chats fetching the same commit don't collide.
    const staging = stagingDir(this.root(), owner, name);
    const pinned = sha;
    const extracted = await removeOnFailure(staging, async () => {
      const got = pinned ? await gh.download(owner, name, pinned, staging) : await gh.downloadLatest(owner, name, staging);
      moveIntoPlace(staging, checkoutDir(this.root(), owner, name, pinned ?? got.commit!));
      return got;
    });
    sha = pinned ?? extracted.commit!;
    const dir = checkoutDir(this.root(), owner, name, sha);
    const scan = await scanTree(dir, extracted.files);
    this.checkouts.set(`${owner}/${name}`.toLowerCase(), { owner, repo: name, sha, dir, assessment: { ...assessment, sha }, scan, limited });
    const skipped = extracted.skipped.length ? `\nLeft out while unpacking: ${extracted.skipped.slice(0, 10).map((s) => `${s.path} (${s.reason})`).join(', ')}` : '';
    return [
      formatAssessment({ ...assessment, sha }),
      `Downloaded ${extracted.files.length} files at commit ${sha.slice(0, 7)} into .dual-agent/reuse (not part of the project).${skipped}`,
      `Scan: ${scan.counts.critical} critical, ${scan.counts.high} high, ${scan.counts.medium} medium, ${scan.counts.low} low.`,
      scan.findings.length ? formatFindings(scan, 25) : '',
      'Next: repo_outline to find the part you need, repo_read only those files, then repo_import. Files with critical findings can\'t be imported.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  outline(repo: string, sub = ''): string {
    const c = this.find(repo);
    const base = workspacePath(c.dir, sub || '.');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          files.push(path.relative(c.dir, full).split(path.sep).join('/'));
        }
      }
    };
    fs.statSync(base).isDirectory() ? walk(base) : files.push(path.relative(c.dir, base).split(path.sep).join('/'));
    const lines: string[] = [];
    for (const rel of files.sort()) {
      const size = fs.statSync(path.join(c.dir, rel)).size;
      const symbols = size < 500_000 ? extractSymbols(fs.readFileSync(path.join(c.dir, rel), 'utf8'), path.extname(rel)) : [];
      const flagged = c.scan.findings.filter((f) => f.file === rel && f.severity !== 'low').length;
      lines.push(`${rel} (${size.toLocaleString()} bytes${flagged ? `, ${flagged} findings` : ''})`);
      lines.push(...symbols.slice(0, 15).map((s) => `  L${s.line} ${s.signature.slice(0, 110)}`));
      if (lines.length > 300) {
        lines.push(`… ${files.length} files in all; outline a subfolder with path.`);
        break;
      }
    }
    return wrapUntrusted(`repo_outline ${c.owner}/${c.repo}`, lines.join('\n'));
  }

  read(repo: string, file: string, start = 1, end?: number): string {
    const c = this.find(repo);
    const all = fs.readFileSync(workspacePath(c.dir, file), 'utf8').split('\n');
    const last = Math.min(all.length, end ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
    const body = all.slice(start - 1, last).map((l, i) => `${start + i}| ${l}`).join('\n');
    const findings = c.scan.findings.filter((f) => f.file === file);
    const more = last < all.length ? `\n(lines ${start}-${last} of ${all.length}; ask for more with start/end)` : '';
    return `${wrapUntrusted(`repo_read ${c.owner}/${c.repo}/${file}`, body)}${more}${findings.length ? `\nScan findings in this file:\n${formatFindings({ ...c.scan, findings }, 15)}` : ''}`;
  }

  import(repo: string, files: ImportSpec[], overwrite = false): string {
    const c = this.find(repo);
    const licenseFile = fs.readdirSync(c.dir).find((n) => /^(licen[cs]e|copying)/i.test(n));
    const result = importFiles(
      this.root(),
      c.dir,
      files,
      {
        fullName: `${c.owner}/${c.repo}`,
        url: c.assessment.repo.url,
        sha: c.sha,
        license: c.assessment.license,
        copyright: licenseFile ? extractCopyright(fs.readFileSync(path.join(c.dir, licenseFile), 'utf8')) : undefined,
        findings: c.scan.findings,
      },
      { findingsApproved: this.approvalShown(), projectSpdx: projectLicense(this.root()), overwrite },
    );
    const done = result.imported.map((f) => `  ${f.from} → ${f.to} (${f.spdx})`);
    const refused = result.refused.map((f) => `  ${f.from}: ${f.reason}`);
    return [
      done.length ? `Imported, with attribution headers, THIRD_PARTY_NOTICES.md and THIRD_PARTY_PROVENANCE.json updated:\n${done.join('\n')}` : 'Nothing imported.',
      refused.length ? `Refused:\n${refused.join('\n')}` : '',
      result.provenanceBackup ? `${PROVENANCE} wasn't a readable list, so it was copied to ${path.basename(result.provenanceBackup)} and a new one started; merge the old records back by hand.` : '',
      done.length ? 'Next: adapt the code to this project (names, style, framework), keep the headers, run the tests, then repo_cleanup.' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  cleanup(repo?: string): string {
    const targets = repo ? [this.find(repo)] : [...this.checkouts.values()];
    for (const c of targets) {
      fs.rmSync(c.dir, { recursive: true, force: true });
      this.checkouts.delete(`${c.owner}/${c.repo}`.toLowerCase());
    }
    if (!repo) {
      fs.rmSync(reuseFolder(this.root()), { recursive: true, force: true });
    }
    return targets.length ? `Deleted ${targets.map((c) => `${c.owner}/${c.repo}`).join(', ')}. Provenance records stay in the project.` : 'Nothing to clean up.';
  }
}

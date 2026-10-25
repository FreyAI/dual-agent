/**
 * Copies chosen files from a downloaded repository into the project, with
 * every obligation handled: license allowed (per file, since a file header can
 * differ from the repository's license), no critical scan findings, no editor
 * config or binaries, an attribution header on each file, the upstream license
 * and NOTICE text in THIRD_PARTY_NOTICES.md, and a provenance record.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { workspacePath } from '../code/repoIndex';
import { readText, writeAtomic } from '../memory/files';
import { LicenseVerdict, commentStyleFor, detectFileLicense, licensePolicy, noticeHeader } from './license';
import { Finding, doNotCopy } from './scan';

export interface ImportSpec {
  /** Path inside the downloaded repository. */
  from: string;
  /** Path inside the project. */
  to: string;
}

export interface ImportSource {
  fullName: string;
  url: string;
  sha: string;
  /** The repository's license and its verdict for this project. */
  license: LicenseVerdict;
  copyright?: string;
  /** Scan findings for the downloaded repository. */
  findings: Finding[];
}

export interface ImportOptions {
  /** A person approved the medium and high findings in these files (the permission card); false in Bypass mode. */
  findingsApproved: boolean;
  projectSpdx?: string;
  overwrite?: boolean;
  now?: Date;
}

export interface ImportResult {
  imported: { from: string; to: string; spdx: string }[];
  refused: { from: string; reason: string }[];
  /** Where an unreadable provenance file was copied before a new one was started. */
  provenanceBackup?: string;
}

const NOTICES = 'THIRD_PARTY_NOTICES.md';
export const PROVENANCE = 'THIRD_PARTY_PROVENANCE.json';
const LICENSE_FILES = /^(licen[cs]e|copying)(\.(md|txt|rst))?$/i;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** Why one file can't be imported, or undefined. */
function refusal(spec: ImportSpec, text: string, source: ImportSource, opts: ImportOptions, root: string): string | undefined {
  const notCopyable = doNotCopy(spec.from);
  if (notCopyable) {
    return notCopyable;
  }
  const fileSpdx = detectFileLicense(text);
  const verdict = fileSpdx ? licensePolicy(fileSpdx, opts.projectSpdx) : source.license;
  if (!verdict.allowed) {
    return `license: ${verdict.reason}`;
  }
  const findings = source.findings.filter((f) => f.file === spec.from);
  const critical = findings.filter((f) => f.severity === 'critical');
  if (critical.length) {
    return `blocked by the scan: ${critical.map((f) => `${f.rule} L${f.line ?? '?'}`).join(', ')}`;
  }
  const serious = findings.filter((f) => f.severity === 'high' || f.severity === 'medium');
  if (serious.length && !opts.findingsApproved) {
    return `needs a person's approval for ${serious.map((f) => f.rule).join(', ')}; switch permissions to Ask so the import shows an approval card`;
  }
  if (spec.to.split(/[\\/]/).includes('.dual-agent')) {
    return 'the destination is inside the reuse folder';
  }
  if (fs.existsSync(path.join(root, spec.to)) && !opts.overwrite) {
    return `${spec.to} already exists; pick another path or pass overwrite`;
  }
  return undefined;
}

/** The file's text with an attribution header after any shebang. */
function withHeader(text: string, to: string, from: string, spdx: string, source: ImportSource, date: string): string {
  const style = commentStyleFor(to);
  if (!style) {
    return text;
  }
  const header = noticeHeader({ spdx, copyright: source.copyright, repoUrl: source.url, sha: source.sha, path: from, modified: false, date }, style);
  const shebang = text.startsWith('#!') ? text.slice(0, text.indexOf('\n') + 1) : '';
  return `${shebang}${header}\n${text.slice(shebang.length)}`;
}

/** The repository's license and NOTICE text, which permissive licenses require to travel with the code. */
function upstreamTexts(checkout: string): string {
  const parts: string[] = [];
  for (const name of fs.readdirSync(checkout)) {
    if (LICENSE_FILES.test(name) || /^notice(\.(md|txt))?$/i.test(name)) {
      parts.push(`#### ${name}\n\n\`\`\`text\n${fs.readFileSync(path.join(checkout, name), 'utf8').trim()}\n\`\`\``);
    }
  }
  return parts.join('\n\n');
}

function recordNotices(root: string, checkout: string, source: ImportSource, files: ImportResult['imported'], date: string) {
  const file = path.join(root, NOTICES);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Third-party notices\n\nCode in this project adapted from other open-source projects, with their licenses.\n';
  const marker = `<!-- ${source.fullName}@${source.sha} -->`;
  const list = files.map((f) => `- \`${f.to}\` from \`${f.from}\` (${f.spdx})`).join('\n');
  let next: string;
  if (existing.includes(marker)) {
    // Same commit imported again: add the new files to its list.
    next = existing.replace(marker, `${marker}\n${list}`);
  } else {
    const section = [`## ${source.fullName}`, '', marker, list, '', `Source: ${source.url} at commit \`${source.sha}\`, imported ${date}. License: ${source.license.spdx ?? 'see below'}.`, ...(source.license.obligations.length ? ['', `Obligations: ${source.license.obligations.join('; ')}.`] : []), '', upstreamTexts(checkout)].join('\n');
    next = `${existing.trimEnd()}\n\n${section}\n`;
  }
  fs.writeFileSync(file, next);
}

interface Provenance {
  records: unknown[];
  /** The file exists but isn't a JSON array: back it up rather than drop its records. */
  corrupt: boolean;
}

/** The provenance records so far, read before any file is written (a read error throws). */
function readProvenance(root: string): Provenance {
  const text = readText(path.join(root, PROVENANCE));
  if (text === undefined) {
    return { records: [], corrupt: false };
  }
  try {
    const records = JSON.parse(text);
    return Array.isArray(records) ? { records, corrupt: false } : { records: [], corrupt: true };
  } catch {
    return { records: [], corrupt: true };
  }
}

/** Appends this import's record; returns the backup path when a corrupt file had to be set aside. */
function recordProvenance(root: string, prior: Provenance, source: ImportSource, entries: { from: string; to: string; spdx: string; sourceSha256: string }[], date: string): string | undefined {
  const file = path.join(root, PROVENANCE);
  let backup: string | undefined;
  if (prior.corrupt) {
    backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  }
  const records = [...prior.records];
  const approved = [...new Set(source.findings.filter((f) => entries.some((e) => e.from === f.file) && f.severity !== 'low').map((f) => `${f.rule}:${f.file}`))];
  records.push({ repo: source.fullName, url: source.url, sha: source.sha, license: source.license.spdx, importedAt: date, files: entries, approvedFindings: approved });
  writeAtomic(file, JSON.stringify(records, null, 2) + '\n');
  return backup;
}

/** Copies the allowed files, writes notices and provenance, and reports what was refused and why. */
export function importFiles(root: string, checkout: string, specs: ImportSpec[], source: ImportSource, opts: ImportOptions): ImportResult {
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const result: ImportResult = { imported: [], refused: [] };
  const entries: { from: string; to: string; spdx: string; sourceSha256: string }[] = [];
  const prior = readProvenance(root);
  for (const spec of specs) {
    let text: string;
    let target: string;
    try {
      text = fs.readFileSync(workspacePath(checkout, spec.from), 'utf8');
      target = workspacePath(root, spec.to);
    } catch (err) {
      result.refused.push({ from: spec.from, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const reason = refusal(spec, text, source, opts, root);
    if (reason) {
      result.refused.push({ from: spec.from, reason });
      continue;
    }
    const spdx = detectFileLicense(text) ?? source.license.spdx ?? 'NOASSERTION';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, withHeader(text, spec.to, spec.from, spdx, source, date), { mode: 0o644 });
    result.imported.push({ from: spec.from, to: spec.to, spdx });
    entries.push({ from: spec.from, to: spec.to, spdx, sourceSha256: sha256(text) });
  }
  if (result.imported.length) {
    recordNotices(root, checkout, source, result.imported, date);
    result.provenanceBackup = recordProvenance(root, prior, source, entries, date);
  }
  return result;
}

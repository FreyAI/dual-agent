import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { extractTarball, safeEntryPath } from '../../reuse/tarball';
import { reuseGuardReason, searchFirstReason } from '../../reuse/guard';
import { buildModeInstructions } from '../../reuse/modes';
import { importFiles, PROVENANCE } from '../../reuse/importer';
import { licensePolicy } from '../../reuse/license';
import { fallbackSearch, limitedAssessment, reposFromHits } from '../../reuse/fallback';
import { GitHub, RateLimitError, cleanReadme, moveIntoPlace, removeOnFailure } from '../../reuse/github';

interface Entry {
  name: string;
  body?: string;
  type?: string;
  mode?: number;
  linkname?: string;
}

/** Builds a .tar.gz the way GitHub does (a pax global header with the commit, then "<repo>-<sha>/…"). */
export function tarball(entries: Entry[], commit = 'abc123'): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string, mode = 0o644, linkname = '') => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write(mode.toString(8).padStart(7, '0'), 100);
    h.write('0000000', 108);
    h.write('0000000', 116);
    h.write(size.toString(8).padStart(11, '0'), 124);
    h.write('00000000000', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write(linkname, 157);
    h.write('ustar', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) {
      sum += b;
    }
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const record = `comment=${commit}\n`;
  // A pax record's length counts its own digits.
  let length = record.length + 2;
  while (`${length} ${record}`.length !== length) {
    length = `${length} ${record}`.length;
  }
  const pax = Buffer.from(`${length} ${record}`);
  blocks.push(header('pax_global_header', pax.length, 'g'), pad(pax));
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    blocks.push(header(e.name, e.type && e.type !== '0' ? 0 : body.length, e.type ?? '0', e.mode, e.linkname));
    if (!e.type || e.type === '0') {
      blocks.push(pad(body));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const dest = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-tar-')), 'out');

test('a GitHub tarball unpacks without its top folder, and the commit is read from the header', () => {
  const out = dest();
  const r = extractTarball(tarball([{ name: 'repo-abc/', type: '5' }, { name: 'repo-abc/src/a.js', body: 'module.exports = 1;\n' }, { name: 'repo-abc/README.md', body: '# hi\n' }], 'deadbeef'), out);
  assert.deepEqual(r.files.sort(), ['README.md', 'src/a.js']);
  assert.equal(r.commit, 'deadbeef');
  assert.equal(fs.readFileSync(path.join(out, 'src/a.js'), 'utf8'), 'module.exports = 1;\n');
});

test('unsafe entries are skipped and reported: traversal, absolute paths, symlinks, hard links, devices, case clashes', () => {
  const out = dest();
  const r = extractTarball(
    tarball([
      { name: 'repo-abc/../../escape.js', body: 'x' },
      { name: 'repo-abc/ok/../../../escape2.js', body: 'x' },
      { name: 'repo-abc/link', type: '2', linkname: '/etc/passwd' },
      { name: 'repo-abc/hard', type: '1', linkname: 'repo-abc/ok.js' },
      { name: 'repo-abc/dev', type: '3' },
      { name: 'repo-abc/Readme.md', body: 'a' },
      { name: 'repo-abc/README.md', body: 'b' },
    ]),
    out,
  );
  assert.deepEqual(r.files, ['Readme.md']);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons['repo-abc/../../escape.js'], 'path escapes the folder');
  assert.equal(reasons['repo-abc/ok/../../../escape2.js'], 'path escapes the folder');
  assert.equal(reasons.link, 'symlink');
  assert.equal(reasons.hard, 'hard link');
  assert.match(reasons.dev, /entry type/);
  assert.match(reasons['README.md'], /differing only in case/);
  assert.ok(!fs.existsSync(path.join(out, '..', 'escape.js')));
  assert.equal(safeEntryPath('/etc/passwd').toString(), safeEntryPath('/etc/passwd').toString());
  assert.deepEqual(safeEntryPath('C:/x/y'), { reason: 'path escapes the folder' });
  assert.deepEqual(safeEntryPath('repo-abc/.GIT/hooks/post-checkout'), { reason: 'git metadata' });
  assert.deepEqual(safeEntryPath('repo-abc\\..\\evil'), { reason: 'backslash in the path' });
});

test('nothing is unpacked executable, even when the archive says so', () => {
  const out = dest();
  extractTarball(tarball([{ name: 'repo-abc/run.sh', body: '#!/bin/sh\necho hi\n', mode: 0o755 }]), out);
  assert.equal(fs.statSync(path.join(out, 'run.sh')).mode & 0o111, 0);
});

test('limits: oversized files are skipped; too many files or too many bytes stop the unpacking', () => {
  const big = 'x'.repeat(2000);
  const r = extractTarball(tarball([{ name: 'repo-abc/big.bin', body: big }, { name: 'repo-abc/small.js', body: 'ok' }]), dest(), { maxTotalBytes: 1e6, maxFiles: 10, maxFileBytes: 1000 });
  assert.deepEqual(r.files, ['small.js']);
  assert.match(r.skipped[0].reason, /larger than/);
  assert.throws(
    () => extractTarball(tarball([1, 2, 3].map((i) => ({ name: `repo-abc/f${i}.js`, body: 'x' }))), dest(), { maxTotalBytes: 1e6, maxFiles: 2, maxFileBytes: 1e6 }),
    /more than 2 files/,
  );
  // An archive bomb: tiny compressed, huge inflated.
  const bomb = tarball([{ name: 'repo-abc/zeros.txt', body: '0'.repeat(3_000_000) }]);
  assert.ok(bomb.length < 50_000);
  assert.throws(() => extractTarball(bomb, dest(), { maxTotalBytes: 100_000, maxFiles: 10, maxFileBytes: 10_000_000 }), /larger than|Cannot create a Buffer|buffer/i);
});


test('the guard keeps general tools out of downloaded repositories, but not the reuse tools', () => {
  assert.match(reuseGuardReason('Read', { file_path: '/p/.dual-agent/reuse/a__b@1234567/index.js' }) ?? '', /untrusted/);
  assert.match(reuseGuardReason('Bash', { command: 'cat .dual-agent/reuse/x/y.js | node' }) ?? '', /repo_read/);
  assert.match(reuseGuardReason('Grep', { pattern: 'x', path: 'C:\\p\\.dual-agent\\reuse' }) ?? '', /untrusted/);
  assert.match(reuseGuardReason('Edit', { file_path: '.Dual-Agent/Reuse/a/b.js', new_string: '' }) ?? '', /untrusted/);
  assert.equal(reuseGuardReason('Read', { file_path: '/p/src/index.js' }), undefined);
  assert.equal(reuseGuardReason('mcp__reuse__repo_read', { repo: 'a/b', path: '.dual-agent/reuse/x' }), undefined);
  for (const command of [
    'git clone https://github.com/a/b /tmp/b',
    'mkdir -p /tmp/x && cd /tmp/x && curl -sL https://registry.npmjs.org/escape-string-regexp/-/escape-string-regexp-5.0.0.tgz | tar xz',
    'wget https://codeload.github.com/a/b/tar.gz/main',
    'npm pack left-pad',
    'pip download requests',
    'gh repo clone a/b',
  ]) {
    assert.match(reuseGuardReason('Bash', { command }) ?? '', /only with repo_fetch/, command);
  }
  assert.equal(reuseGuardReason('Bash', { command: 'git clone https://github.com/me/mine' }, false), undefined, 'craft mode may clone');
  assert.match(reuseGuardReason('Read', { file_path: '.dual-agent/reuse/a/b.js' }, false) ?? '', /untrusted/, 'the reuse folder is guarded in every mode');
  for (const command of ['curl -s http://localhost:3000/health', 'npm install zod', 'git status', 'curl https://api.example.com/v1 | jq .']) {
    assert.equal(reuseGuardReason('Bash', { command }), undefined, command);
  }
});

test('build modes: craft turns reuse off; reuse and hybrid carry the decision rules and safety rules', () => {
  assert.match(buildModeInstructions('craft'), /don't search for or copy outside repositories/);
  for (const mode of ['reuse', 'hybrid'] as const) {
    const text = buildModeInstructions(mode);
    assert.match(text, /security-sensitive/i);
    assert.match(text, /untrusted input/);
    assert.match(text, /repo_import/);
    assert.match(text, /AskUserQuestion/);
  }
  assert.match(buildModeInstructions('reuse'), /look for existing code/);
});

function checkout(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-checkout-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const MIT = 'MIT License\n\nCopyright (c) 2021 Jane Doe\n\nPermission is hereby granted, free of charge...\n';

test('import: attribution header, notices with the upstream license, provenance, never executable', () => {
  const repo = checkout({ LICENSE: MIT, 'src/slug.js': 'module.exports = (s) => s.toLowerCase();\n', 'bin/cli.js': '#!/usr/bin/env node\nconsole.log(1);\n' });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-project-'));
  const source = { fullName: 'jane/slug', url: 'https://github.com/jane/slug', sha: 'a'.repeat(40), license: licensePolicy('MIT'), copyright: 'Copyright (c) 2021 Jane Doe', findings: [] };
  const r = importFiles(project, repo, [{ from: 'src/slug.js', to: 'lib/slug.js' }, { from: 'bin/cli.js', to: 'lib/cli.js' }], source, { findingsApproved: true, now: new Date('2026-10-17') });
  assert.deepEqual(r.refused, []);
  const slug = fs.readFileSync(path.join(project, 'lib/slug.js'), 'utf8');
  assert.match(slug, /SPDX-License-Identifier: MIT/);
  assert.match(slug, /SPDX-FileCopyrightText: 2021 Jane Doe/);
  assert.match(slug, /https:\/\/github\.com\/jane\/slug/);
  assert.match(slug, /module\.exports = \(s\) => s\.toLowerCase\(\);/);
  assert.ok(fs.readFileSync(path.join(project, 'lib/cli.js'), 'utf8').startsWith('#!/usr/bin/env node\n'), 'the shebang stays first');
  assert.equal(fs.statSync(path.join(project, 'lib/cli.js')).mode & 0o111, 0);
  const notices = fs.readFileSync(path.join(project, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /## jane\/slug/);
  assert.match(notices, /`lib\/slug\.js` from `src\/slug\.js` \(MIT\)/);
  assert.match(notices, /Permission is hereby granted/);
  const provenance = JSON.parse(fs.readFileSync(path.join(project, PROVENANCE), 'utf8'));
  assert.equal(provenance[0].sha, 'a'.repeat(40));
  assert.equal(provenance[0].files.length, 2);
  assert.match(provenance[0].files[0].sourceSha256, /^[0-9a-f]{64}$/);
});

test('import refuses: blocked licenses (repo or file header), critical findings, unapproved findings, config files, overwrites, escapes', () => {
  const repo = checkout({
    LICENSE: MIT,
    'ok.js': 'module.exports = 1;\n',
    'gpl.js': '// SPDX-License-Identifier: GPL-3.0-only\nmodule.exports = 2;\n',
    'evil.js': 'eval(atob("..."))\n',
    'risky.js': 'require("child_process").exec(cmd)\n',
    '.vscode/tasks.json': '{"tasks":[{"runOptions":{"runOn":"folderOpen"}}]}',
  });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-project-'));
  fs.writeFileSync(path.join(project, 'exists.js'), 'mine\n');
  const findings = [
    { rule: 'OBF-01', severity: 'critical' as const, file: 'evil.js', line: 1, snippet: '', message: '' },
    { rule: 'EXEC-01', severity: 'high' as const, file: 'risky.js', line: 1, snippet: '', message: '' },
  ];
  const base = { fullName: 'jane/x', url: 'https://github.com/jane/x', sha: 'b'.repeat(40), license: licensePolicy('MIT'), findings };
  const r = importFiles(
    project,
    repo,
    [
      { from: 'gpl.js', to: 'a.js' },
      { from: 'evil.js', to: 'b.js' },
      { from: 'risky.js', to: 'c.js' },
      { from: '.vscode/tasks.json', to: 'tasks.json' },
      { from: 'ok.js', to: 'exists.js' },
      { from: '../../etc/passwd', to: 'p.txt' },
      { from: 'ok.js', to: '../outside.js' },
      { from: 'ok.js', to: '.dual-agent/reuse/z.js' },
    ],
    base,
    { findingsApproved: false, projectSpdx: 'MIT' },
  );
  assert.deepEqual(r.imported, []);
  const why = Object.fromEntries(r.refused.map((x) => [`${x.from}`, x.reason]));
  assert.match(why['gpl.js'], /license/);
  assert.match(why['evil.js'], /blocked by the scan: OBF-01/);
  assert.match(why['risky.js'], /needs a person's approval for EXEC-01/);
  assert.ok(why['.vscode/tasks.json'], 'editor config is never copied');
  assert.equal(r.refused.length, 8);
  assert.ok(!fs.existsSync(path.join(project, 'THIRD_PARTY_NOTICES.md')), 'no notices when nothing was imported');
  const approved = importFiles(project, repo, [{ from: 'risky.js', to: 'c.js' }], base, { findingsApproved: true, projectSpdx: 'MIT' });
  assert.deepEqual(approved.imported.map((f) => f.to), ['c.js'], 'a person approved the high finding on the card');
  const blocked = importFiles(project, repo, [{ from: 'ok.js', to: 'd.js' }], { ...base, license: licensePolicy(undefined) }, { findingsApproved: true });
  assert.match(blocked.refused[0].reason, /license/);
});

test('import: a corrupt or non-list provenance file is backed up, never dropped, and checked before files are written', () => {
  const repo = checkout({ LICENSE: MIT, 'a.js': 'module.exports = 1;\n', 'b.js': 'module.exports = 2;\n' });
  const source = { fullName: 'jane/x', url: 'https://github.com/jane/x', sha: 'b'.repeat(40), license: licensePolicy('MIT'), findings: [] };
  for (const bad of ['{not json', '{"repo":"old"}']) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-project-'));
    fs.writeFileSync(path.join(project, PROVENANCE), bad);
    const r = importFiles(project, repo, [{ from: 'a.js', to: 'a.js' }], source, { findingsApproved: true });
    assert.deepEqual(r.imported.map((f) => f.to), ['a.js']);
    assert.ok(r.provenanceBackup && fs.readFileSync(r.provenanceBackup, 'utf8') === bad, 'the old records are kept');
    const records = JSON.parse(fs.readFileSync(path.join(project, PROVENANCE), 'utf8'));
    assert.equal(records.length, 1);
    assert.ok(!fs.readdirSync(project).some((n) => n.endsWith('.tmp')), 'written atomically');
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-project-'));
  fs.mkdirSync(path.join(project, PROVENANCE));
  assert.throws(() => importFiles(project, repo, [{ from: 'b.js', to: 'b.js' }], source, { findingsApproved: true }), /EISDIR/);
  assert.ok(!fs.existsSync(path.join(project, 'b.js')), 'an unreadable record stops the import before any file is written');
});

test('a failed download or unpack removes its folder', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-stage-')), 'staging');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'half.js'), '');
  await assert.rejects(removeOnFailure(dir, async () => { throw new Error('bad gzip'); }), /bad gzip/);
  assert.ok(!fs.existsSync(dir));
  assert.equal(await removeOnFailure(dir, async () => 7), 7);
});

test('fallback: repositories are read from search results, skipping gists, topics and duplicates', () => {
  const repos = reposFromHits([
    { url: 'https://github.com/mholt/PapaParse' },
    { url: 'https://github.com/mholt/PapaParse/issues/12' },
    { url: 'https://gist.github.com/a/123' },
    { url: 'https://github.com/topics/csv' },
    { url: 'https://www.github.com/vanillaes/csv.git' },
    { url: 'https://example.com/github.com/x/y' },
  ]);
  assert.deepEqual(repos, [{ owner: 'mholt', repo: 'PapaParse' }, { owner: 'vanillaes', repo: 'csv' }]);
});

test('fallback: limited vetting states its gaps, still checks the license, and needs 100+ stars', () => {
  const info = { fullName: 'a/b', description: '', url: 'https://github.com/a/b', stars: 5000, forks: 10, openIssues: 20, createdAt: '', pushedAt: '', archived: false, fork: false, license: 'MIT', defaultBranch: 'HEAD', sizeKb: 0, topics: [], ownerType: 'User' };
  const ok = limitedAssessment(info, 6, 'MIT');
  assert.deepEqual(ok.hardFailures, []);
  assert.match(ok.warnings[0], /limited vetting/);
  assert.ok(ok.trust > 40 && ok.trust < 80, String(ok.trust));
  assert.match(limitedAssessment({ ...info, stars: 40 }, 6).hardFailures[0], /only 40 stars/);
  assert.match(limitedAssessment({ ...info, license: undefined }, 6).hardFailures[0], /license/);
});

test('fallback search looks each result up on deps.dev and drops projects it doesn\'t know', async () => {
  const web = async () => [{ url: 'https://github.com/known/one' }, { url: 'https://github.com/unknown/two' }, { url: 'https://github.com/known/three' }];
  const http = (async (url: string) => {
    const known = url.includes('known%2Fone') ? 900 : url.includes('known%2Fthree') ? 4000 : 0;
    return { status: known ? 200 : 404, text: () => JSON.stringify({ starsCount: known, license: 'MIT', description: 'd' }) };
  }) as any;
  const found = await fallbackSearch(web, 'csv', 'JavaScript', 5, http);
  assert.deepEqual(found.map((r) => [r.fullName, r.stars]), [['known/three', 4000], ['known/one', 900]]);
  assert.equal(found[0].pushedAt, '', 'dates are unknown, not invented');
});

test('README text for the agent: images, badges, HTML and comments removed; nothing left to render', () => {
  const readme = [
    '<p align="center"><img src="https://evil.example/pixel.gif?u=1"></p>',
    '# slugify',
    '[![Build](https://img.shields.io/x.svg)](https://ci.example)',
    '![logo](https://cdn.example/logo.png)',
    '<!-- hidden instructions for agents -->',
    '',
    '',
    '',
    'Slugify a string.',
    '',
    '```js',
    "slugify('I ♥ Dogs');",
    '```',
  ].join('\n');
  const clean = cleanReadme(readme);
  assert.doesNotMatch(clean, /img|pixel|shields|logo\.png|hidden instructions|<p/);
  assert.match(clean, /^# slugify\n\nSlugify a string\.\n\n```js\nslugify\('I ♥ Dogs'\);\n```$/);
});

test('reuse mode: a sizable new source file waits for a repo_search; tests, small files, edits and other files don\'t', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-searchfirst-'));
  const big = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join('\n');
  assert.match(searchFirstReason('Write', { file_path: path.join(dir, 'src/schedule.js'), content: big }, false) ?? '', /repo_search/);
  assert.equal(searchFirstReason('Write', { file_path: path.join(dir, 'src/schedule.js'), content: big }, true), undefined, 'after a search');
  assert.equal(searchFirstReason('Write', { file_path: path.join(dir, 'test/schedule.test.js'), content: big }, false), undefined, 'tests');
  assert.equal(searchFirstReason('Write', { file_path: path.join(dir, 'src/small.js'), content: 'module.exports = 1;\n' }, false), undefined, 'small files');
  assert.equal(searchFirstReason('Write', { file_path: path.join(dir, 'README.md'), content: big }, false), undefined, 'not source');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/existing.js'), '');
  assert.equal(searchFirstReason('Write', { file_path: path.join(dir, 'src/existing.js'), content: big }, false), undefined, 'rewriting an existing file');
  assert.equal(searchFirstReason('Edit', { file_path: path.join(dir, 'src/schedule.js'), new_string: big }, false), undefined, 'edits');
});

/** Runs `fn` with fetch answering every request with `reply`. */
async function withFetch(reply: () => Response, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => reply()) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('GitHub: a 403 is a rate limit only when GitHub says so; 429 always is', async () => {
  const gh = new GitHub();
  await withFetch(() => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), async () => {
    await assert.rejects(gh.repo('a', 'b'), RateLimitError);
  });
  await withFetch(() => new Response('{}', { status: 429 }), async () => {
    await assert.rejects(gh.repo('a', 'b'), RateLimitError);
  });
  await withFetch(() => new Response('{"message":"Repository access blocked"}', { status: 403, headers: { 'x-ratelimit-remaining': '42', 'content-type': 'application/json' } }), async () => {
    await assert.rejects(gh.repo('a', 'b'), (err: unknown) => !(err instanceof RateLimitError) && /HTTP 403: Repository access blocked/.test(String(err)));
  });
});

test('GitHub: an HTML reply to an API call is a clear error, not a JSON parse error', async () => {
  const gh = new GitHub();
  await withFetch(() => new Response('<html>Sign in to the network</html>', { status: 200, headers: { 'content-type': 'text/html' } }), async () => {
    await assert.rejects(gh.search('x'), /non-JSON reply \(HTTP 200, text\/html\)/);
    await assert.rejects(gh.repo('a', 'b'), /non-JSON reply/);
  });
  await withFetch(() => new Response('[{"login":"x","contributions":3}]', { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }), async () => {
    assert.deepEqual(await gh.contributors('a', 'b'), [{ login: 'x', contributions: 3 }]);
  });
});

test('two downloads of the same commit: the first one moved into place is kept, the other dropped', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-move-'));
  const target = path.join(base, 'o__r@abc1234');
  const stage = (name: string) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.js'), name);
    return dir;
  };
  const first = stage('staging-1');
  const second = stage('staging-2');
  moveIntoPlace(first, target);
  moveIntoPlace(second, target);
  assert.equal(fs.readFileSync(path.join(target, 'a.js'), 'utf8'), 'staging-1');
  assert.ok(!fs.existsSync(first) && !fs.existsSync(second));
});

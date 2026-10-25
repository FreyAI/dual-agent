import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AssessDeps, assessRepo, formatAssessment } from '../../reuse/assess';
import { Contributor, Release, RepoInfo } from '../../reuse/github';
import { commentStyleFor, detectFileLicense, extractCopyright, licensePolicy, noticeHeader } from '../../reuse/license';

const NOW = Date.parse('2026-10-17T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

test('permissive licenses are allowed with notice obligations', () => {
  for (const id of ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Unlicense', 'CC0-1.0', 'Zlib', 'BSL-1.0', 'Apache-2.0']) {
    const v = licensePolicy(id, 'MIT');
    assert.equal(v.allowed, true, id);
    assert.equal(v.scope, undefined, id);
    assert.ok(v.obligations.length > 0, id);
  }
  assert.ok(licensePolicy('BSD-3-Clause').obligations.some((o) => /endorse/.test(o)));
  assert.ok(licensePolicy('Apache-2.0').obligations.some((o) => /NOTICE/.test(o)));
  assert.ok(licensePolicy('Apache-2.0').obligations.some((o) => /changed file/.test(o)));
  assert.equal(licensePolicy('mit').spdx, 'MIT');
});

test('MPL-2.0 is allowed file by file', () => {
  const v = licensePolicy('MPL-2.0', 'MIT');
  assert.equal(v.allowed, true);
  assert.equal(v.scope, 'file-level');
});

test('copyleft is allowed only into a compatible copyleft project', () => {
  for (const id of ['GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'LGPL-2.1-only', 'AGPL-3.0-only']) {
    const v = licensePolicy(id, 'MIT');
    assert.equal(v.allowed, false, id);
    assert.equal(v.scope, 'same-license-only', id);
    assert.match(v.reason, /not MIT/);
  }
  assert.match(licensePolicy('GPL-3.0').reason, /has none set/);
  assert.equal(licensePolicy('GPL-3.0-only', 'GPL-3.0-or-later').allowed, true);
  assert.equal(licensePolicy('GPL-2.0-or-later', 'GPL-3.0-only').allowed, true);
  assert.equal(licensePolicy('GPL-2.0-only', 'GPL-3.0-only').allowed, false);
  assert.equal(licensePolicy('GPL-3.0-only', 'AGPL-3.0-only').allowed, true);
  assert.equal(licensePolicy('AGPL-3.0-only', 'GPL-3.0-only').allowed, false);
  assert.equal(licensePolicy('LGPL-2.1-or-later', 'LGPL-3.0-only').allowed, true);
  assert.equal(licensePolicy('GPL-3.0-only', 'GPL-2.0-only').allowed, false);
  const ok = licensePolicy('GPL-3.0-or-later', 'GPL-3.0-only');
  assert.equal(ok.scope, 'same-license-only');
});

test('missing, unrecognized, non-free and unknown licenses are blocked', () => {
  for (const id of [undefined, '', 'NOASSERTION', 'other', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'BUSL-1.1', 'SSPL-1.0', 'Elastic-2.0', 'Commons-Clause', 'WTFPL-ish']) {
    assert.equal(licensePolicy(id, 'MIT').allowed, false, String(id));
  }
  assert.match(licensePolicy(undefined).reason, /no license/);
  assert.match(licensePolicy('WTFPL-ish').reason, /ask a human/);
});

test('"A OR B" picks an allowed option', () => {
  const v = licensePolicy('GPL-3.0-only OR MIT', 'MIT');
  assert.equal(v.allowed, true);
  assert.equal(v.spdx, 'MIT');
});

test('detectFileLicense reads SPDX tags and common headers', () => {
  assert.equal(detectFileLicense('// SPDX-License-Identifier: Apache-2.0\nexport {}'), 'Apache-2.0');
  assert.equal(detectFileLicense('/* SPDX-License-Identifier: MIT */\n'), 'MIT');
  assert.equal(detectFileLicense('<!-- SPDX-License-Identifier: MPL-2.0 -->\n'), 'MPL-2.0');
  assert.equal(detectFileLicense('# SPDX-License-Identifier: MIT OR Apache-2.0\n'), 'MIT OR Apache-2.0');
  assert.equal(detectFileLicense('/*\n * Permission is hereby granted, free of charge, to any person obtaining a copy\n */'), 'MIT');
  assert.equal(detectFileLicense('// Licensed under the Apache License, Version 2.0 (the "License");'), 'Apache-2.0');
  assert.equal(detectFileLicense('This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.'), 'MPL-2.0');
  assert.equal(detectFileLicense('Redistribution and use in source and binary forms, with or without\nNeither the name of the copyright holder'), 'BSD-3-Clause');
  assert.equal(detectFileLicense('Redistribution and use in source and binary forms, with or without'), 'BSD-2-Clause');
  assert.equal(detectFileLicense('under the terms of the GNU General Public License as published by\nthe Free Software Foundation, either version 3 of the License, or\n(at your option) any later version.'), 'GPL-3.0-or-later');
  assert.equal(detectFileLicense('GNU Lesser General Public License version 2.1'), 'LGPL-2.1-only');
  assert.equal(detectFileLicense('GNU Affero General Public License, version 3'), 'AGPL-3.0-only');
  // Whole LICENSE files, as a project's own license is read.
  assert.equal(detectFileLicense('                                 Apache License\n                           Version 2.0, January 2004\n'), 'Apache-2.0');
  assert.equal(detectFileLicense('Mozilla Public License Version 2.0\n=================================='), 'MPL-2.0');
  assert.equal(detectFileLicense('                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007'), 'GPL-3.0-only');
  assert.equal(detectFileLicense('export const x = 1;\n'), undefined);
  assert.equal(detectFileLicense('\n'.repeat(50) + '// SPDX-License-Identifier: MIT'), undefined);
});

test('commentStyleFor maps extensions to comment syntax', () => {
  assert.equal(commentStyleFor('src/a.ts'), 'line');
  assert.equal(commentStyleFor('main.go'), 'line');
  assert.equal(commentStyleFor('lib.rs'), 'line');
  assert.equal(commentStyleFor('x/y.py'), 'hash');
  assert.equal(commentStyleFor('ci.YAML'), 'hash');
  assert.equal(commentStyleFor('Makefile'), 'hash');
  assert.equal(commentStyleFor('a.css'), 'block');
  assert.equal(commentStyleFor('App.vue'), 'html');
  assert.equal(commentStyleFor('README.md'), 'html');
  assert.equal(commentStyleFor('package.json'), undefined);
  assert.equal(commentStyleFor('LICENSE'), undefined);
});

test('noticeHeader writes a REUSE header in each comment style', () => {
  const opts = { spdx: 'MIT', copyright: 'Copyright (c) 2019 Jane Doe', repoUrl: 'https://github.com/jane/lib', sha: 'abc1234', path: 'src/x.ts', modified: true, date: '2026-10-17' };
  const line = noticeHeader(opts, 'line');
  assert.equal(
    line,
    '// SPDX-FileCopyrightText: 2019 Jane Doe\n// SPDX-License-Identifier: MIT\n// Adapted from https://github.com/jane/lib at abc1234 (src/x.ts), 2026-10-17, modified\n',
  );
  assert.match(noticeHeader(opts, 'hash'), /^# SPDX-FileCopyrightText: 2019 Jane Doe\n# SPDX-License-Identifier: MIT\n/);
  assert.match(noticeHeader(opts, 'block'), /^\/\*\n \* SPDX-FileCopyrightText: .*\n \*\/\n$/s);
  assert.match(noticeHeader(opts, 'html'), /^<!--\n {2}SPDX-FileCopyrightText: .*\n-->\n$/s);
  const plain = noticeHeader({ ...opts, copyright: undefined, modified: false }, 'line');
  assert.match(plain, /SPDX-FileCopyrightText: https:\/\/github.com\/jane\/lib contributors/);
  assert.doesNotMatch(plain, /modified/);
  // Untrusted text can't break out of the comment.
  const hostile = noticeHeader({ ...opts, copyright: '2019 Eve */ alert(1) /*\nevil()' }, 'block');
  assert.equal(hostile.split('*/').length, 2);
  assert.equal(hostile.split('\n').length, 6);
  assert.equal(detectFileLicense(line), 'MIT');
});

test('extractCopyright finds the real copyright line', () => {
  assert.equal(extractCopyright('MIT License\n\nCopyright (c) 2019 Jane Doe\n\nPermission is hereby granted'), 'Copyright (c) 2019 Jane Doe');
  assert.equal(extractCopyright('Copyright [yyyy] [name of copyright owner]\n'), undefined);
  assert.equal(extractCopyright(' * © 2020-2024 Acme Inc.'), '© 2020-2024 Acme Inc.');
  assert.equal(extractCopyright('no notice here'), undefined);
});

function repoInfo(over: Partial<RepoInfo> = {}): RepoInfo {
  return {
    fullName: 'good/lib',
    description: 'A good library',
    url: 'https://github.com/good/lib',
    stars: 5000,
    forks: 400,
    openIssues: 20,
    createdAt: daysAgo(2000),
    pushedAt: daysAgo(10),
    archived: false,
    fork: false,
    license: 'MIT',
    defaultBranch: 'main',
    sizeKb: 200,
    topics: [],
    ownerType: 'User',
    ...over,
  };
}

interface Fake {
  info?: Partial<RepoInfo>;
  contributors?: Contributor[];
  releases?: Release[];
  ownerCreated?: string;
  tree?: string[];
  rivals?: RepoInfo[];
  scorecard?: number;
  fail?: string[];
}

function deps(f: Fake = {}): AssessDeps {
  const maybe = async <T>(name: string, value: T): Promise<T> => {
    if (f.fail?.includes(name)) {
      throw new Error(`${name} failed`);
    }
    return value;
  };
  return {
    now: NOW,
    gh: {
      repo: async () => repoInfo(f.info),
      contributors: () => maybe('contributors', f.contributors ?? [{ login: 'a', contributions: 500 }, { login: 'b', contributions: 200 }, { login: 'c', contributions: 100 }]),
      releases: () => maybe('releases', f.releases ?? [{ tag: 'v2.0.0', publishedAt: daysAgo(40) }]),
      user: () => maybe('user', { createdAt: f.ownerCreated ?? daysAgo(3000), type: 'User' }),
      tree: () => maybe('tree', f.tree ?? ['src', 'src/index.ts', 'test', 'test/index.test.ts', '.github/workflows/ci.yml']),
      search: () => maybe('search', f.rivals ?? [repoInfo()]),
    },
    scorecard: async () => maybe('scorecard', 'scorecard' in f ? f.scorecard : 7),
  };
}

test('a healthy repository passes with a high trust score', async () => {
  const a = await assessRepo(deps(), 'good', 'lib', 'MIT');
  assert.deepEqual(a.hardFailures, []);
  assert.deepEqual(a.warnings, []);
  assert.ok(a.trust >= 85, `trust ${a.trust}`);
  assert.equal(a.parts.maintenance, 1);
  assert.equal(a.parts.busFactor, 1);
  assert.equal(a.parts.testsCi, 1);
  assert.equal(a.scorecard, 7);
  assert.equal(a.license.allowed, true);
  const text = formatAssessment(a);
  assert.match(text, /good\/lib · ★5000 · MIT · trust \d+\/100/);
  assert.match(text, /issues \(open\/star proxy\)/);
});

test('each hard filter fails the repository with a clear reason', async () => {
  const cases: [Fake, RegExp][] = [
    [{ info: { archived: true } }, /archived/],
    [{ info: { disabled: true } }, /disabled/],
    [{ info: { fork: true, parent: 'up/lib' } }, /fork; use the parent up\/lib/],
    [{ info: { createdAt: daysAgo(30) } }, /less than 90 days/],
    [{ ownerCreated: daysAgo(60) }, /owner account is less than 180 days/],
    [{ rivals: [repoInfo(), repoInfo({ fullName: 'real/LIB', stars: 60000 })] }, /repo confusion: real\/LIB/],
    [{ info: { license: 'GPL-3.0' } }, /license: GPL-3.0 code can only go into a project under a compatible copyleft license, not MIT/],
    [{ info: { license: undefined } }, /license: the repository has no license/],
  ];
  for (const [fake, re] of cases) {
    const a = await assessRepo(deps(fake), 'good', 'lib', 'MIT');
    assert.equal(a.hardFailures.length, 1, `${re}: ${a.hardFailures.join('; ')}`);
    assert.match(a.hardFailures[0], re);
    assert.match(formatAssessment(a), /REJECTED/);
  }
});

test('a same-name repository with fewer than 10x the stars is not confusion', async () => {
  const a = await assessRepo(deps({ rivals: [repoInfo({ fullName: 'other/lib', stars: 20000 })] }), 'good', 'lib', 'MIT');
  assert.deepEqual(a.hardFailures, []);
});

test('GPL code is allowed into a GPL project', async () => {
  const a = await assessRepo(deps({ info: { license: 'GPL-2.0-or-later' } }), 'good', 'lib', 'GPL-3.0-only');
  assert.deepEqual(a.hardFailures, []);
  assert.equal(a.license.scope, 'same-license-only');
});

test('star inflation costs 30 points and warns', async () => {
  const contributors = [{ login: 'a', contributions: 50 }];
  const base = await assessRepo(deps({ info: { forks: 400 }, contributors }), 'good', 'lib', 'MIT');
  const inflated = await assessRepo(deps({ info: { forks: 10 }, contributors }), 'good', 'lib', 'MIT');
  assert.ok(inflated.warnings.some((w) => /star inflation/.test(w)));
  assert.equal(base.trust - inflated.trust, 30);
  assert.ok(base.warnings.some((w) => /single maintainer/.test(w)));
  assert.equal(base.parts.busFactor, 0.2);
});

test('a missing scorecard counts as 0.5 and warns; a low one warns', async () => {
  const a = await assessRepo(deps({ scorecard: undefined }), 'good', 'lib', 'MIT');
  assert.equal(a.parts.scorecard, 0.5);
  assert.ok(a.warnings.some((w) => /Scorecard unknown/.test(w)));
  const low = await assessRepo(deps({ scorecard: 2.5 }), 'good', 'lib', 'MIT');
  assert.equal(low.parts.scorecard, 0.25);
  assert.ok(low.warnings.some((w) => /low OpenSSF Scorecard/.test(w)));
});

test('weak signals produce warnings and lower scores', async () => {
  const a = await assessRepo(
    deps({ info: { pushedAt: daysAgo(500), openIssues: 2000 }, releases: [{ tag: 'v1', publishedAt: daysAgo(1000) }], tree: ['index.js', 'README.md'] }),
    'good',
    'lib',
    'MIT',
  );
  assert.deepEqual(a.hardFailures, []);
  assert.equal(a.parts.maintenance, 0.3);
  assert.equal(a.parts.testsCi, 0);
  assert.equal(a.parts.issues, 0.3);
  const rootTest = await assessRepo(deps({ tree: ['index.js', 'test.js', '.travis.yml'] }), 'good', 'lib', 'MIT');
  assert.equal(rootTest.parts.testsCi, 1);
  for (const re of [/no GitHub release in the last 24 months/, /no tests/, /no CI/]) {
    assert.ok(a.warnings.some((w) => re.test(w)), String(re));
  }
});

test('failed optional lookups become warnings, never errors', async () => {
  const a = await assessRepo(deps({ fail: ['contributors', 'releases', 'user', 'tree', 'search', 'scorecard'] }), 'good', 'lib', 'MIT');
  assert.deepEqual(a.hardFailures, []);
  assert.equal(a.parts.busFactor, 0.5);
  assert.equal(a.parts.testsCi, 0.5);
  assert.equal(a.parts.scorecard, 0.5);
  for (const label of ['contributor list', 'release list', 'owner account age', 'file tree', 'repo-confusion check', 'OpenSSF Scorecard']) {
    assert.ok(a.warnings.some((w) => w.startsWith(label)), label);
  }
});

test('a copyright notice without a year is still found; license wording is not', () => {
  assert.equal(extractCopyright('MIT License\n\nCopyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)\n'), 'Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)');
  assert.equal(extractCopyright('The above copyright notice and this permission notice shall be included\nCopyright notice and holders\n'), undefined);
  assert.equal(extractCopyright('Copyright [yyyy] [name of copyright owner]\n'), undefined);
});

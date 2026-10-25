/**
 * License rules for reuse mode: which upstream licenses may be copied into the
 * project, what each one obliges, how to spot a file's own license, and the
 * REUSE-style header an imported file carries.
 */

export interface LicenseVerdict {
  spdx?: string;
  allowed: boolean;
  /** Limits on where the copied code may go; absent for permissive licenses. */
  scope?: 'file-level' | 'same-license-only';
  obligations: string[];
  reason: string;
}

export type CommentStyle = 'line' | 'hash' | 'block' | 'html';

const KEEP = 'keep the copyright and license notice in each copied file';
const KEEP_LICENSE = 'ship the upstream LICENSE text in THIRD_PARTY_NOTICES.md';

/** Permissive licenses: SPDX id → obligations beyond the header. */
const PERMISSIVE: Record<string, string[]> = {
  'MIT': [KEEP, KEEP_LICENSE],
  'ISC': [KEEP, KEEP_LICENSE],
  'BSD-2-Clause': [KEEP, KEEP_LICENSE],
  'BSD-3-Clause': [KEEP, KEEP_LICENSE, "don't use the authors' names to endorse the project"],
  '0BSD': ['attribution is optional; the header is kept for provenance'],
  'Unlicense': ['public domain; the header is kept for provenance'],
  'CC0-1.0': ['public domain; the header is kept for provenance'],
  'Zlib': [KEEP, 'mark altered files as modified', "don't claim you wrote the original"],
  'BSL-1.0': [KEEP, KEEP_LICENSE],
  'Apache-2.0': [KEEP, KEEP_LICENSE, 'mark every changed file as modified', "keep upstream copyright, patent and attribution notices", 'merge the upstream NOTICE file into THIRD_PARTY_NOTICES.md'],
};

/** Licenses that are never copied, with the reason shown to the user. */
const BLOCKED: [RegExp, string][] = [
  [/^(NOASSERTION|NONE|OTHER)$/i, 'GitHub found no recognizable license, so all rights are reserved'],
  [/-NC(-|$)/i, 'non-commercial licenses restrict how the project may be used'],
  [/-ND(-|$)/i, 'no-derivatives licenses forbid adapting the code'],
  [/^CC-BY/i, 'Creative Commons licenses (other than CC0) are not meant for code'],
  [/^BUSL-/i, 'the Business Source License is not open source until its change date'],
  [/^SSPL-/i, 'the SSPL is not an open-source license and its terms reach the whole service'],
  [/^Elastic-/i, 'the Elastic License forbids offering the software as a service and is not open source'],
  [/Commons-Clause/i, 'the Commons Clause forbids selling the software'],
];

/** Copyleft families and which incoming licenses each project license can take. */
const COPYLEFT = /^(A?GPL|LGPL)-(\d\.\d)(-only|-or-later|\+)?$/i;
const COMPATIBLE: Record<string, (base: string, orLater: boolean) => boolean> = {
  'GPL-2.0': (b) => b === 'GPL-2.0' || b === 'LGPL-2.1' || b === 'LGPL-2.0',
  'GPL-3.0': (b, later) => ['GPL-3.0', 'LGPL-3.0', 'LGPL-2.1', 'LGPL-2.0'].includes(b) || (b === 'GPL-2.0' && later),
  'AGPL-3.0': (b, later) => ['AGPL-3.0', 'GPL-3.0', 'LGPL-3.0', 'LGPL-2.1', 'LGPL-2.0'].includes(b) || (b === 'GPL-2.0' && later),
  'LGPL-2.1': (b) => b === 'LGPL-2.1' || b === 'LGPL-2.0',
  'LGPL-3.0': (b, later) => b === 'LGPL-3.0' || (b === 'LGPL-2.1' && later),
};

function copyleft(spdx: string): { base: string; orLater: boolean } | undefined {
  const m = COPYLEFT.exec(spdx);
  return m ? { base: `${m[1].toUpperCase()}-${m[2]}`, orLater: !!m[3] && m[3] !== '-only' } : undefined;
}

/** Case-insensitive lookup so "mit" and "apache-2.0" still match. */
function permissiveId(spdx: string): string | undefined {
  return Object.keys(PERMISSIVE).find((k) => k.toLowerCase() === spdx.toLowerCase());
}

function single(spdx: string, projectSpdx?: string): LicenseVerdict {
  const id = permissiveId(spdx);
  if (id) {
    return { spdx: id, allowed: true, obligations: PERMISSIVE[id], reason: `${id} is permissive` };
  }
  if (/^MPL-2\.0/i.test(spdx)) {
    return {
      spdx: 'MPL-2.0',
      allowed: true,
      scope: 'file-level',
      obligations: ['copied files stay MPL-2.0 and keep their headers', "put the project's own code in separate files", 'publish changes to the copied files'],
      reason: 'MPL-2.0 is copyleft per file only',
    };
  }
  const blocked = BLOCKED.find(([re]) => re.test(spdx));
  if (blocked) {
    return { spdx, allowed: false, obligations: [], reason: blocked[1] };
  }
  const incoming = copyleft(spdx);
  if (incoming) {
    const project = projectSpdx ? copyleft(projectSpdx) : undefined;
    if (project && COMPATIBLE[project.base]?.(incoming.base, incoming.orLater)) {
      return {
        spdx,
        allowed: true,
        scope: 'same-license-only',
        obligations: [KEEP, KEEP_LICENSE, 'the project must stay under its copyleft license', 'mark changed files and publish source'],
        reason: `${spdx} can be combined with this ${projectSpdx} project`,
      };
    }
    return {
      spdx,
      allowed: false,
      scope: 'same-license-only',
      obligations: [],
      reason: `${spdx} code can only go into a project under a compatible copyleft license${projectSpdx ? `, not ${projectSpdx}` : ' (the project has none set)'}`,
    };
  }
  return { spdx, allowed: false, obligations: [], reason: `${spdx} isn't on the reviewed list; ask a human before copying` };
}

/** Whether code under `spdx` may be copied into a project under `projectSpdx`. Handles simple "A OR B" expressions. */
export function licensePolicy(spdx: string | undefined, projectSpdx?: string): LicenseVerdict {
  const id = spdx?.trim().replace(/^\((.*)\)$/, '$1');
  if (!id) {
    return { allowed: false, obligations: [], reason: 'the repository has no license, so all rights are reserved' };
  }
  const options = id.split(/\s+OR\s+/i);
  if (options.length > 1) {
    const verdicts = options.map((o) => single(o, projectSpdx));
    const pick = verdicts.find((v) => v.allowed && !v.scope) ?? verdicts.find((v) => v.allowed) ?? verdicts[0];
    return { ...pick, reason: `${id}: chose ${pick.spdx}; ${pick.reason}` };
  }
  return single(id, projectSpdx);
}

/** Header phrases for files without an SPDX tag; order matters (LGPL/AGPL before GPL). */
const PHRASES: [RegExp, (text: string) => string][] = [
  [/Permission is hereby granted, free of charge, to any person obtaining a copy/i, () => 'MIT'],
  [/Licensed under the Apache License,? Version 2\.0|Apache License\s+Version 2\.0, January 2004/i, () => 'Apache-2.0'],
  [/Mozilla Public License,?\s+v(ersion|\.)\s?2\.0/i, () => 'MPL-2.0'],
  [/This is free and unencumbered software released into the public domain/i, () => 'Unlicense'],
  [/Permission to use, copy, modify, and\/or distribute this software for any purpose/i, (t) => (/provided that the above copyright notice/i.test(t) ? 'ISC' : '0BSD')],
  [/Redistribution and use in source and binary forms/i, (t) => (/Neither the name|endorse or promote/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause')],
  [/GNU Affero General Public License/i, (t) => gplId('AGPL', t)],
  [/GNU (Lesser|Library) General Public License/i, (t) => gplId('LGPL', t)],
  [/GNU General Public License/i, (t) => gplId('GPL', t)],
];

function gplId(family: string, text: string): string {
  const version = /version (\d(?:\.\d)?)/i.exec(text)?.[1] ?? (family === 'LGPL' ? '2.1' : family === 'AGPL' ? '3' : '2');
  const v = version.includes('.') ? version : `${version}.0`;
  return `${family}-${v}${/any later version/i.test(text) ? '-or-later' : '-only'}`;
}

/** A source file's own license: its SPDX-License-Identifier tag, else a recognizable header. */
export function detectFileLicense(text: string): string | undefined {
  const head = text.split('\n', 40).join('\n');
  const tag = /SPDX-License-Identifier:\s*([^\n*]*?)\s*(?:\*\/|-->)?\s*$/m.exec(head);
  if (tag?.[1]) {
    return tag[1];
  }
  const phrase = PHRASES.find(([re]) => re.test(head));
  return phrase?.[1](head);
}

const STYLE_BY_EXT: Record<string, CommentStyle> = {};
const assign = (style: CommentStyle, exts: string) => exts.split(' ').forEach((e) => (STYLE_BY_EXT[e] = style));
assign('line', 'ts tsx mts cts js jsx mjs cjs go rs java kt kts scala swift c h cc cpp cxx hpp hh cs dart groovy');
assign('hash', 'py pyi rb sh bash zsh fish yaml yml toml pl r ps1 nix tf');
assign('block', 'css scss less');
assign('html', 'html htm vue svelte md markdown');

/** The comment syntax a header can use in `file`; undefined when the format has none (JSON, unknown). */
export function commentStyleFor(file: string): CommentStyle | undefined {
  const base = file.split(/[\\/]/).pop() ?? '';
  if (/^(Makefile|Dockerfile|Rakefile|Gemfile)$/.test(base)) {
    return 'hash';
  }
  const ext = /\.([^.]+)$/.exec(base)?.[1]?.toLowerCase();
  return ext ? STYLE_BY_EXT[ext] : undefined;
}

/** The first real "Copyright (c) 2019 Jane Doe" line of a LICENSE, skipping templates. */
export function extractCopyright(licenseText: string): string | undefined {
  for (const raw of licenseText.split('\n')) {
    const line = raw.replace(/^\s*(?:[*#;]|\/\/)?\s*/, '').trim();
    // A year, or a "(c)"/"©" mark followed by a name (many notices have no year); never the license's own wording.
    const notice = /\d{4}/.test(line) || /^(?:copyright\s*)?(?:\(c\)|©)\s*\p{L}/iu.test(line);
    if (/^(Copyright|©|\(c\))/i.test(line) && notice && !/\[yyyy\]|<year>|\{yyyy\}|copyright (notice|holder)/i.test(line)) {
      return line;
    }
  }
  return undefined;
}

/** Untrusted text inside a comment: one line, no control characters, no terminator for this style. */
function clean(s: string, style: CommentStyle): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return style === 'block' ? flat.replace(/\*\//g, '* /') : style === 'html' ? flat.replace(/--/g, '- -') : flat;
}

/**
 * The REUSE-style header for an imported file, ending in a newline. The caller
 * places it (after a shebang or XML declaration, if the file has one).
 */
export function noticeHeader(
  opts: { spdx: string; copyright?: string; repoUrl: string; sha: string; path: string; modified: boolean; date: string },
  commentStyle: CommentStyle,
): string {
  const holder = opts.copyright ? opts.copyright.replace(/^Copyright\s*/i, '').replace(/^\(c\)\s*/i, '') : `${opts.repoUrl} contributors`;
  const lines = [
    `SPDX-FileCopyrightText: ${holder}`,
    `SPDX-License-Identifier: ${opts.spdx}`,
    `Adapted from ${opts.repoUrl} at ${opts.sha} (${opts.path}), ${opts.date}${opts.modified ? ', modified' : ''}`,
  ].map((l) => clean(l, commentStyle));
  switch (commentStyle) {
    case 'line':
      return lines.map((l) => `// ${l}`).join('\n') + '\n';
    case 'hash':
      return lines.map((l) => `# ${l}`).join('\n') + '\n';
    case 'block':
      return ['/*', ...lines.map((l) => ` * ${l}`), ' */'].join('\n') + '\n';
    case 'html':
      return ['<!--', ...lines.map((l) => `  ${l}`), '-->'].join('\n') + '\n';
  }
}

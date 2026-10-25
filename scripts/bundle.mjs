#!/usr/bin/env node
// Bundles the extension for packaging into <dir>/out: extension.js, and child.js (the proxy
// process, forked by path from registry.ts) next to it. The tests keep using tsc's out/.
// The chat page's scripts and stylesheets are joined into <dir>/media/chat.js and chat.css.
// `vscode` and the Agent SDK (it finds its native binary by package name) stay in node_modules.
//
//   npm run bundle            into dist/bundle
//   node scripts/bundle.mjs <dir>
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Packages left out of the bundle: they must ship in the VSIX's node_modules. */
export const EXTERNAL = ['vscode', '@anthropic-ai/claude-agent-sdk'];

export async function bundle(dir) {
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [
      { in: 'src/extension.ts', out: 'extension' },
      { in: 'src/proxy/child.ts', out: 'child' },
    ],
    outdir: path.join(dir, 'out'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: EXTERNAL,
    // Names stay, so stack traces in the logs still read.
    minifyWhitespace: true,
    minifySyntax: true,
    logLevel: 'warning',
  });
  joinMedia(path.join(dir, 'media'));
}

/** media/files.json's files, one file per kind, in that order; chatView.ts loads these when they exist. */
export function joinMedia(out) {
  const media = path.join(ROOT, 'media');
  const files = JSON.parse(fs.readFileSync(path.join(media, 'files.json'), 'utf8'));
  const join = (list, sep) => list.map((f) => fs.readFileSync(path.join(media, f), 'utf8')).join(sep);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'chat.css'), join(files.css, '\n'));
  // A `;` between scripts, so one ending without a semicolon can't run into the next.
  fs.writeFileSync(path.join(out, 'chat.js'), join(files.js, '\n;\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle(path.resolve(process.argv[2] ?? path.join(ROOT, 'dist', 'bundle')));
}

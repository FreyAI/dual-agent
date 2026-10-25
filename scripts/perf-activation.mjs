#!/usr/bin/env node
// Time to load out/extension.js (what activation compiles), with `vscode` stubbed.
// Prints the milliseconds and how many modules were loaded. Run `npm run compile` first.
//
//   npm run perf:activation
//   node scripts/perf-activation.mjs dist/bundle/out/extension.js    the packaged bundle (npm run bundle)
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const entry = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'extension.js');

// Any property of the stub is another stub, so top-level `vscode.X.Y` reads don't throw.
const stub = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : stub), apply: () => stub, construct: () => stub });
// A bundle copies the module's own keys (esbuild's __toESM), so the top level lists the names the entry uses.
const names = [...new Set(fs.readFileSync(entry, 'utf8').match(/\bvscode\d*\.[A-Za-z_]\w*/g)?.map((m) => m.split('.')[1]))];
const api = new Proxy({}, { get: () => stub, ownKeys: () => names, getOwnPropertyDescriptor: () => ({ value: stub, enumerable: true, configurable: true }) });
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? api : load.call(this, request, ...rest);
};

const before = new Set(Object.keys(require.cache));
const start = performance.now();
require(entry);
const ms = performance.now() - start;
const modules = Object.keys(require.cache).filter((k) => !before.has(k)).length;
console.log(`${path.relative(process.cwd(), entry)}: ${ms.toFixed(0)} ms, ${modules} modules`);

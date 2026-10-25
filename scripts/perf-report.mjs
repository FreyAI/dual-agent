#!/usr/bin/env node
// Per-day performance figures from the usage logs (turns, calls, diag).
//
//   node scripts/perf-report.mjs [usage folder]
//
// Without a folder it reads VS Code's globalStorage for this extension on this OS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function defaultDir() {
  const home = os.homedir();
  const user =
    process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
    : process.platform === 'win32' ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User')
    : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Code', 'User');
  return path.join(user, 'globalStorage', extensionId(), 'usage');
}

/** `<publisher>.<name>` from the repo's package.json. */
function extensionId() {
  const pkgFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch (err) {
    console.error(`Cannot read ${pkgFile}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  return `${pkg.publisher}.${pkg.name}`;
}

const dir = process.argv[2] ?? defaultDir();

/** Every parseable row of every `<kind>-*.jsonl` (one file per machine). */
function rows(kind) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.jsonl'));
  } catch {
    console.error(`No usage folder at ${dir}`);
    process.exit(1);
  }
  return files.flatMap((f) =>
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').flatMap((line) => {
      try {
        const r = line && JSON.parse(line);
        return r && typeof r.at === 'number' ? [r] : [];
      } catch {
        return [];
      }
    }),
  );
}

// Same interpolation as src/metrics/stats.ts.
function percentile(values, p) {
  if (!values.length) {
    return undefined;
  }
  const s = [...values].sort((a, b) => a - b);
  const at = (p / 100) * (s.length - 1);
  const lo = Math.floor(at);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (at - lo);
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sec = (ms) => (ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`);
const p50p90 = (xs) => (xs.length ? `${sec(percentile(xs, 50))} / ${sec(percentile(xs, 90))}` : '-');
const day = (at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const byDay = (list) => {
  const m = new Map();
  for (const r of list) {
    const k = day(r.at);
    m.has(k) ? m.get(k).push(r) : m.set(k, [r]);
  }
  return m;
};
const nums = (list, key) => list.flatMap((r) => (typeof r[key] === 'number' ? [r[key]] : []));

/** "POST /v1/messages -> upstream error EPIPE": a model call or background traffic. */
const upstreamKind = (r) => {
  const m = /^\S+ (\S+) -> upstream error/.exec(r.detail ?? '');
  return m && (/^\/v1\/messages(\?|$)/.test(m[1]) ? 'model' : 'other');
};

const turns = byDay(rows('turns'));
const calls = byDay(rows('calls'));
const diag = byDay(rows('diag'));
const days = [...new Set([...turns.keys(), ...calls.keys(), ...diag.keys()])].sort();

function report(label, t, c, d) {
  // Latency is the user's wait: turns Claude Code started itself are left out (as summarizeTurns does).
  const waited = t.filter((r) => !r.implicit);
  const launched = t.filter((r) => r.launchMs);
  const prewarmed = t.filter((r) => r.prewarmed).length;
  const retries = nums(t, 'retries');
  const up = d.map(upstreamKind).filter(Boolean);
  const hookMs = sum(t.flatMap((r) => Object.values(r.hooks ?? {}).map((h) => h.ms ?? 0)));
  return {
    day: label,
    turns: t.length,
    'duration p50/p90': p50p90(nums(waited, 'durationMs')),
    'ttft p50/p90': p50p90(nums(waited, 'ttftMs')),
    'launch p50/p90 (n)': launched.length ? `${p50p90(nums(launched, 'launchMs'))} (${launched.length})` : '-',
    prewarmed: prewarmed || '-',
    'retries/turn (max)': t.length ? `${(sum(retries) / t.length).toFixed(2)} (${Math.max(0, ...retries)})` : '-',
    'upstream err model/other': `${up.filter((k) => k === 'model').length} / ${up.filter((k) => k === 'other').length}`,
    blocked: sec(sum(nums(t, 'blockedMs'))),
    'hook ms (per turn)': t.length ? `${hookMs} (${(hookMs / t.length).toFixed(1)})` : '-',
    'model calls': c.length,
  };
}

const table = days.map((k) => report(k, turns.get(k) ?? [], calls.get(k) ?? [], diag.get(k) ?? []));
const all = (m) => [...m.values()].flat();
table.push(report('all', all(turns), all(calls), all(diag)));
console.log(`Usage folder: ${dir}`);
console.table(table);

#!/usr/bin/env node
// Builds one VSIX per platform into dist/, plus the installers.
//
// The agent runs Claude Code's native binary, which differs per OS and CPU, so
// each VSIX bundles only the binary for its platform. VS Code refuses to
// install a VSIX built for a different platform, so the wrong one can't slip in.
//
//   node scripts/package.mjs                 this machine's platform
//   node scripts/package.mjs all             every platform
//   node scripts/package.mjs linux-x64 ...   the named ones
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDictation } from './build-dictation.mjs';
import { bundle } from './bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const isWin = process.platform === 'win32';

export function currentTarget() {
  let arch = process.arch;
  // Node under Rosetta reports x64 on Apple silicon; the native build is the right one.
  if (process.platform === 'darwin' && arch === 'x64') {
    try {
      if (execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).trim() === '1') {
        arch = 'arm64';
      }
    } catch {
      // Not translated.
    }
  }
  return `${process.platform}-${arch}`;
}

function run(cmd, args, cwd = ROOT) {
  // npm is npm.cmd on Windows, which needs a shell.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin && cmd === 'npm' });
}

const args = process.argv.slice(2);
const targets = args.length === 0 ? [currentTarget()] : args.includes('all') ? ALL : args;
for (const t of targets) {
  if (!ALL.includes(t)) {
    console.error(`Unknown target "${t}". Known: ${ALL.join(', ')}`);
    process.exit(1);
  }
}

run(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '.']);
// Every build is checked: a failing unit or webview test stops it before anything is packaged
// (webview tests skip themselves without Chrome). DUAL_AGENT_SKIP_TESTS=1 builds anyway.
if (process.env.DUAL_AGENT_SKIP_TESTS !== '1') {
  run(process.execPath, ['--test', '--test-concurrency=1', 'out/test/unit/']);
  run(process.execPath, ['--test', 'out/test/webview/']);
}
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-pack-'));

try {
  for (const target of targets) {
    const [platform, cpu] = target.split('-');
    const dir = path.join(stage, target);
    console.log(`\n==> ${target}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['package.json', 'package-lock.json', 'README.md', 'MODELS.md', '.vscodeignore', 'media', 'LICENSE']) {
      fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
    }
    // The chat's mic, on a Mac (and only when built on one: it needs Swift).
    const dictation = platform === 'darwin' && buildDictation();
    if (dictation) {
      fs.cpSync(dictation, path.join(dir, 'bin', path.basename(dictation)), { recursive: true, verbatimSymlinks: true });
    }
    // The extension as one bundled file (plus the proxy process); .vscodeignore keeps only the SDK's node_modules.
    await bundle(dir);
    // Already compiled; the stage has no TypeScript to compile with.
    const pkgFile = path.join(dir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    delete pkg.scripts['vscode:prepublish'];
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

    // Installs the optional dependency that matches the target, not this machine.
    run('npm', ['ci', '--omit=dev', `--os=${platform}`, `--cpu=${cpu}`, '--no-audit', '--no-fund', '--loglevel=error'], dir);
    // Keep only the glibc build on Linux (the SDK falls back to it); musl would double the size.
    for (const musl of ['linux-x64-musl', 'linux-arm64-musl']) {
      fs.rmSync(path.join(dir, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${musl}`), { recursive: true, force: true });
    }
    const bin = path.join(dir, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${target}`, platform === 'win32' ? 'claude.exe' : 'claude');
    if (!fs.existsSync(bin)) {
      throw new Error(`Claude Code binary for ${target} was not installed (${bin})`);
    }
    run(
      process.execPath,
      [path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--target', target, '--allow-missing-repository', '--skip-license',
        '-o', path.join(ROOT, 'dist', `dual-agent-${version}-${target}.vsix`)],
      dir,
    );
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

// The installers read the extension id (<publisher>.<name>) from package.json next to them.
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(ROOT, 'dist', 'package.json'));
for (const f of ['install.sh', 'install.ps1', 'Install Dual Agent.command', 'INSTALL.md']) {
  const src = path.join(ROOT, 'install', f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(ROOT, 'dist', f));
  }
}
console.log(`\nBuilt ${targets.map((t) => `dual-agent-${version}-${t}.vsix`).join(', ')} in dist/`);

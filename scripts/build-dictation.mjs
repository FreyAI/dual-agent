#!/usr/bin/env node
// Builds bin/Dual Agent Dictation.app (macOS only): the chat box's mic, from native/dictation.
// One universal app serves both Mac VSIXs. It's rebuilt only when its source changes, because
// macOS ties the mic and speech permissions to the build: a new one asks again.
//
//   node scripts/build-dictation.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'native', 'dictation');
export const DICTATION_APP = path.join(ROOT, 'bin', 'Dual Agent Dictation.app');

/** The app's path, or undefined when it can't be built here (not a Mac, or no Swift compiler). */
export function buildDictation() {
  if (process.platform !== 'darwin') {
    return undefined;
  }
  const files = ['main.swift', 'Info.plist'].map((f) => path.join(SRC, f));
  const hash = crypto.createHash('sha256');
  files.forEach((f) => hash.update(fs.readFileSync(f)));
  const stamp = path.join(ROOT, 'bin', 'dictation.sha256');
  const digest = hash.digest('hex');
  if (fs.existsSync(DICTATION_APP) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === digest) {
    return DICTATION_APP;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-'));
  try {
    const slices = ['arm64', 'x86_64'].map((cpu) => {
      const out = path.join(work, cpu);
      execFileSync('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${cpu}-apple-macos13.0`, '-o', out, files[0]], { stdio: 'inherit' });
      return out;
    });
    fs.rmSync(DICTATION_APP, { recursive: true, force: true });
    const macos = path.join(DICTATION_APP, 'Contents', 'MacOS');
    fs.mkdirSync(macos, { recursive: true });
    execFileSync('lipo', ['-create', ...slices, '-output', path.join(macos, 'DualAgentDictation')]);
    fs.copyFileSync(files[1], path.join(DICTATION_APP, 'Contents', 'Info.plist'));
    // Ad-hoc signed: enough for macOS to ask for the permissions on this machine.
    execFileSync('codesign', ['--force', '--sign', '-', DICTATION_APP]);
    // Outside the bundle, which the signature seals.
    fs.writeFileSync(stamp, digest);
  } catch (err) {
    console.warn(`Dictation wasn't built, so the chat has no mic: ${err.message}`);
    return undefined;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return DICTATION_APP;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildDictation() ?? 'Not built (macOS with Xcode command line tools only).');
}

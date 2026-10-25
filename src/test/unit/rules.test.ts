import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applySplit, globRegex, planSplit, ruleText } from '../../rules/split';

const REPO = [
  'package.json', 'README.md', 'CLAUDE.md', 'Makefile',
  'src/web/app.tsx', 'src/web/Button.tsx', 'src/web/styles.css',
  'src/server/index.ts', 'src/server/db.ts', 'src/server/auth.ts', 'src/server/routes.ts',
  'App/Sources/Main.swift', 'App/Tools/Mail/Inbox.swift', 'App/Tools/Mail/Send.swift',
  'tests/unit/db.test.ts', 'tests/unit/auth.test.ts', 'docs/guide.md', 'scripts/release.sh',
  'config/a.json', 'config/b.json', 'config/c.json', 'config/d.json',
];

const OVERVIEW = `# Acme

Monorepo for the Acme app. Server code is in src/server, the web client in src/web.

## Build and test commands

- \`npm run build\` builds everything; \`npm test\` runs tests/unit.
- \`cd App && swift test\` for the app.
`;
const FRONTEND = `## Frontend (src/web)

- Components are function components in \`*.tsx\`.
- Styles live next to the component.

\`\`\`tsx
## not a heading inside a fence
\`\`\`
`;
const SWIFT = `## Swift tests

- Use XCTest; mocks for mail live in App/Tools/Mail/…
- Never hit the network.
`;
const TESTS = `## Unit tests

- Tests sit in tests/unit and use node:test.
`;
const SECURITY = `## Security

- Never commit .env files or print keys.
`;
const CLAUDE_MD = `${OVERVIEW}\n${FRONTEND}\n${SWIFT}\n${TESTS}\n${SECURITY}`;

const workspace = (claudeMd = CLAUDE_MD) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-rules-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), claudeMd);
  return root;
};

test('rules: path-specific sections move with globs inferred from the repo', () => {
  const plan = planSplit(CLAUDE_MD, REPO);
  assert.deepEqual(plan.rules.map((r) => [r.path, r.paths]), [
    ['.claude/rules/frontend.md', ['src/web/**']],
    ['.claude/rules/swift-tests.md', ['**/*.swift']],
    ['.claude/rules/unit-tests.md', ['tests/unit/**']],
  ]);
  assert.equal(plan.keep, `${OVERVIEW}\n${SECURITY}`);
  assert.equal(plan.movedLines, [FRONTEND, SWIFT, TESTS].reduce((n, s) => n + s.trimEnd().split('\n').length, 0));
  assert.equal(plan.keptLines, plan.keep.trimEnd().split('\n').length);
});

test('rules: content is verbatim and the frontmatter matches the docs', () => {
  const [frontend] = planSplit(CLAUDE_MD, REPO).rules;
  assert.equal(frontend.body, `---\npaths:\n  - "src/web/**"\n---\n\n${FRONTEND.trimEnd()}\n`);
  assert.equal(ruleText(['src/**/*.{ts,tsx}', 'lib/**/*.ts'], '# API'), '---\npaths:\n  - "src/**/*.{ts,tsx}"\n  - "lib/**/*.ts"\n---\n\n# API\n');
});

test('rules: nothing path-specific leaves CLAUDE.md unchanged', () => {
  const text = `${OVERVIEW}\n${SECURITY}\n## Style\n\n- Keep functions small; see src/server for examples.\n\n## Mentions\n\n- Paths like lib/missing and \`*.rb\` that aren't in the repo.\n`;
  const plan = planSplit(text, REPO);
  assert.deepEqual(plan.rules, []);
  assert.equal(plan.keep, text);
  assert.equal(plan.movedLines, 0);
});

test('rules: broad or tour-like sections stay', () => {
  const broad = '# X\n\n## Config files\n\n- Every file under config/, src/server/, tests/unit/ and src/web/ is generated.\n';
  assert.deepEqual(planSplit(broad, REPO).rules, [], 'covers over half the repo');
  const tour = '# X\n\n## Where things are\n\n- src/web, src/server, App/Sources, tests/unit, docs, scripts/release.sh\n';
  assert.deepEqual(planSplit(tour, REPO).rules, [], 'too many globs');
});

test('rules: globs match the way Claude Code reads them', () => {
  assert.ok(globRegex('**/*.swift').test('Main.swift'));
  assert.ok(globRegex('**/*.swift').test('App/Tools/Mail/Inbox.swift'));
  assert.ok(globRegex('src/web/**').test('src/web/a/b.tsx'));
  assert.ok(!globRegex('*.md').test('docs/guide.md'));
  assert.ok(globRegex('src/*.{ts,tsx}').test('src/a.tsx'));
});

test('rules: apply backs up, writes rules and the new CLAUDE.md', () => {
  const root = workspace();
  const plan = planSplit(CLAUDE_MD, REPO);
  const { backup, written } = applySplit(root, plan, '.dual-agent/backups');
  assert.equal(fs.readFileSync(backup, 'utf8'), CLAUDE_MD);
  assert.ok(backup.startsWith(path.join(root, '.dual-agent', 'backups')));
  assert.deepEqual(written, plan.rules.map((r) => path.join(root, r.path)));
  written.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), plan.rules[i].body));
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), plan.keep);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.claude', '.dual-agent', 'CLAUDE.md'], 'no temporary files');
});

test('rules: an existing rule with different content is never overwritten', () => {
  const root = workspace();
  const rules = path.join(root, '.claude', 'rules');
  fs.mkdirSync(rules, { recursive: true });
  fs.writeFileSync(path.join(rules, 'frontend.md'), 'mine\n');
  const plan = planSplit(CLAUDE_MD, REPO);
  plan.rules = plan.rules.slice(0, 2);
  fs.writeFileSync(path.join(rules, 'swift-tests.md'), plan.rules[1].body);
  const { written } = applySplit(root, plan, path.join(root, 'bak'));
  assert.equal(fs.readFileSync(path.join(rules, 'frontend.md'), 'utf8'), 'mine\n');
  assert.deepEqual(written, [path.join(rules, 'frontend-2.md'), path.join(rules, 'swift-tests.md')], 'identical file reused');
  assert.equal(fs.readFileSync(written[0], 'utf8'), plan.rules[0].body);
});

test('rules: apply refuses secret-looking names and paths outside the rules folder', () => {
  const root = workspace();
  const plan = planSplit(CLAUDE_MD, REPO);
  const rule = plan.rules[0];
  assert.throws(() => applySplit(root, { ...plan, rules: [{ ...rule, path: '.claude/rules/secrets.md' }] }, 'bak'), /secrets/);
  assert.throws(() => applySplit(root, { ...plan, rules: [{ ...rule, path: '.claude/rules/../../../x.md' }] }, 'bak'), /outside/);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), CLAUDE_MD, 'nothing changed');
  assert.ok(!fs.existsSync(path.join(root, 'bak')));
});

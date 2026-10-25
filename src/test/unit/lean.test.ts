import { resetConfig } from '../helpers/vscodeStub';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkCompression, compressPrompt, compressRefusal, leanWorkflowInstructions, replyStyleInstructions, VERIFY_RULE } from '../../lean';
import { helperAgents, soloRoster } from '../../providers';

test('reply style: off adds nothing; each level adds the shared rules plus its own', () => {
  assert.equal(replyStyleInstructions('off'), '');
  for (const level of ['lite', 'full', 'ultra'] as const) {
    const text = replyStyleInstructions(level);
    assert.match(text, /Lead with the answer/);
    assert.match(text, /Keep every negation and limit \(not, never, no, only, except\)/);
    assert.match(text, new RegExp(`Level: ${level}\\.`));
  }
});

test('lean workflow mentions quick-helper only when helpers exist', () => {
  assert.match(leanWorkflowInstructions(true), /quick-helper/);
  assert.doesNotMatch(leanWorkflowInstructions(false), /quick-helper/);
  assert.match(leanWorkflowInstructions(false), /Conventional Commits/);
});

test('helper prompts get compact reports and lean habits, and lose them when turned off', () => {
  resetConfig({});
  const on = helperAgents(soloRoster('deepseek'));
  assert.match(on['quick-helper'].prompt, /goes to the main agent/);
  assert.match(on['quick-helper'].prompt, /Do only the job/);
  assert.match(on['deep-thinker'].prompt, /symptom from the inferred cause/);
  assert.match(on['quick-helper'].prompt, /notes_read/);
  const general = on['general-purpose'];
  assert.equal(general.model, 'deepseek-flash');
  assert.deepEqual([general.maxTurns, general.autoCompactWindow], [80, 100_000]);
  const claude = helperAgents(soloRoster('claude'));
  assert.deepEqual(Object.values(claude).map((h) => h.model), ['haiku', 'haiku', 'opus', 'opus', 'sonnet'], 'Opus plans, Sonnet takes delegated work, Haiku quick jobs');
  const mixed = helperAgents({ work: 'deepseek', plan: 'claude' });
  assert.deepEqual(Object.values(mixed).map((h) => h.model), ['deepseek-flash', 'deepseek-flash', 'opus', 'opus', 'deepseek-flash'], 'Flash does the delegated work, Opus plans');
  const low = helperAgents({ work: 'deepseek', plan: 'deepseek' });
  assert.equal(low.Plan.model, 'deepseek-v4-pro', 'Claude quota low: DeepSeek\'s strongest plans');
  resetConfig({ 'claude.plannerModel': 'claude-opus-5-5', 'claude.helperModel': 'claude-sonnet-5-5' });
  const set = helperAgents(soloRoster('claude'));
  assert.deepEqual([set.Plan.model, set['general-purpose'].model], ['claude-opus-5-5', 'claude-sonnet-5-5'], 'settings win');
  resetConfig({});
  assert.equal(on['quick-helper'].omitClaudeMd, true, 'searching and reading needs no project rules');
  assert.equal(general.omitClaudeMd, undefined, 'helpers that write code keep the project conventions');

  resetConfig({ replyStyle: 'off', leanWorkflow: false });
  const off = helperAgents(soloRoster('deepseek'));
  assert.equal(off['quick-helper'].prompt, `You are a fast helper. Do exactly the job you are given, efficiently, and report the result concisely. ${VERIFY_RULE}`, 'honest reports stay on');
  assert.doesNotMatch(off['deep-thinker'].prompt, /goes to the main agent|symptom|notes_read/);
  resetConfig({});
});

test('compression refuses secrets, backups and non-prose files', () => {
  assert.equal(compressRefusal('/repo/CLAUDE.md'), undefined);
  assert.equal(compressRefusal('/repo/.claude/rules/style.mdc'), undefined);
  assert.equal(compressRefusal('/repo/NOTES'), undefined);
  assert.match(compressRefusal('/repo/.env')!, /secrets/);
  assert.match(compressRefusal('/repo/credentials.md')!, /secrets/);
  assert.match(compressRefusal('/repo/api-keys.txt')!, /secrets/);
  assert.match(compressRefusal('/b/CLAUDE.2026.original.md')!, /backup/);
  assert.match(compressRefusal('/repo/src/index.ts')!, /isn't a prose file/);
  assert.equal(compressRefusal('/repo/keyboard-shortcuts.md'), undefined, 'a word that merely starts with "key" is fine');
});

test('compression prompt names the file and the backup', () => {
  const p = compressPrompt('/repo/CLAUDE.md', '/backups/CLAUDE.original.md');
  assert.match(p, /\/repo\/CLAUDE\.md/);
  assert.match(p, /\/backups\/CLAUDE\.original\.md/);
});

const ORIGINAL = `# Project

You should always make sure to run \`npm test\` before you push. See https://example.com/docs for details.

## Build

\`\`\`sh
npm run build   # keep this comment
\`\`\`
`;

test('compression check passes when only prose shrinks', () => {
  const compressed = `# Project

Run \`npm test\` before push. Docs: https://example.com/docs

## Build

\`\`\`sh
npm run build   # keep this comment
\`\`\`
`;
  const check = checkCompression(ORIGINAL, compressed);
  assert.deepEqual(check.problems, []);
  assert.ok(check.after < check.before);
});

test('compression check catches changed code, lost inline code and URLs, and renamed headings', () => {
  const broken = `# Project overview

Run tests before push.

## Build

\`\`\`sh
npm run build
\`\`\`
`;
  const { problems } = checkCompression(ORIGINAL, broken);
  assert.equal(problems.length, 4, problems.join(' | '));
  assert.ok(problems.some((p) => p.startsWith('code blocks changed')));
  assert.ok(problems.some((p) => p.includes('`npm test`')));
  assert.ok(problems.some((p) => p.includes('https://example.com/docs')));
  assert.ok(problems.includes('headings changed'));
});

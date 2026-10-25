import { config, fakeSecrets, resetConfig } from '../helpers/vscodeStub';
import { stopProxies } from '../../proxy/registry';
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Credentials, MissingCredentialError, buildLaunch, claudeBinary, helperAgents, keylessConfigDir, mainConfigDir, modelFor, saveTokenSplit, searchKeys, tokenSplit, useRepoSettings, usesOwnWebTools } from '../../providers';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-providers-'));
// Keep the keyless config folder out of the real home while testing.
process.env.DUAL_AGENT_CONFIG_DIR = path.join(tmp, 'keyless-config');

function keyFile(name: string, contents: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, contents);
  return file;
}

beforeEach(() => resetConfig());

test('DeepSeek key is read from a .env-style file, including inside markdown', async () => {
  const md = keyFile('local.md', '# Notes\n\n```env\nOTHER=1\nDEEPSEEK_API_KEY=sk-from-markdown\n```\n');
  config['deepseek.apiKeyFile'] = md;
  const creds = new Credentials(fakeSecrets() as any);
  assert.equal(await creds.getDeepSeekKey(), 'sk-from-markdown');
  assert.equal(await creds.deepSeekKeySource(), 'API key from local.md');
});

test('quoted and exported keys are unwrapped', async () => {
  config['deepseek.apiKeyFile'] = keyFile('quoted.env', "export DEEPSEEK_API_KEY='sk-quoted' # comment\n");
  assert.equal(await new Credentials(fakeSecrets() as any).getDeepSeekKey(), 'sk-quoted');
});

test('the key file wins over the stored key, and the stored key is the fallback', async () => {
  const secrets = fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-stored' });
  const creds = new Credentials(secrets as any);
  assert.equal(await creds.getDeepSeekKey(), 'sk-stored');
  config['deepseek.apiKeyFile'] = keyFile('wins.env', 'DEEPSEEK_API_KEY=sk-file\n');
  assert.equal(await creds.getDeepSeekKey(), 'sk-file');
  config['deepseek.apiKeyFile'] = path.join(tmp, 'missing.env');
  assert.equal(await creds.getDeepSeekKey(), 'sk-stored', 'an unreadable file falls back to the stored key');
});

test('the key file is read again only when it changes', async () => {
  const file = keyFile('cached.env', 'DEEPSEEK_API_KEY=sk-one\n');
  config['deepseek.apiKeyFile'] = file;
  const creds = new Credentials(fakeSecrets() as any);
  // The module itself: the compiled import is a read-only view of it.
  const nodeFs = require('fs');
  const read = nodeFs.readFileSync;
  let reads = 0;
  nodeFs.readFileSync = (...args: any[]) => (args[0] === file && reads++, read(...args));
  try {
    assert.equal(await creds.getDeepSeekKey(), 'sk-one');
    assert.equal(await creds.getDeepSeekKey(), 'sk-one');
    await creds.deepSeekKeySource();
    assert.equal(reads, 1, 'an unchanged file is not re-read');
    fs.writeFileSync(file, 'DEEPSEEK_API_KEY=sk-two\n');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(await creds.getDeepSeekKey(), 'sk-two', 'a changed file is picked up');
    assert.equal(reads, 2);
  } finally {
    nodeFs.readFileSync = read;
  }
});

test('a missing key file with no stored key says so', async () => {
  config['deepseek.apiKeyFile'] = path.join(tmp, 'nope.env');
  const creds = new Credentials(fakeSecrets() as any);
  assert.equal(await creds.getDeepSeekKey(), undefined);
  assert.match(await creds.deepSeekKeySource(), /no DEEPSEEK_API_KEY readable in nope\.env/);
});

test('DeepSeek launch routes to DeepSeek with its key and never reads the Claude sign-in', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://should-be-cleared.example';
  process.env.ANTHROPIC_AUTH_TOKEN = 'leaked-token';
  resetConfig({ clearOldToolResults: false });
  try {
    const creds = new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds' }) as any);
    const launch = await buildLaunch('deepseek', 'thinking', creds);
    assert.match(launch.env.ANTHROPIC_BASE_URL ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'masking off still goes through the proxy that reshapes what DeepSeek cannot parse');
    assert.equal(launch.effort, 'high', "V4 Pro's thinking is set by effort; DeepSeek ignores thinking budgets");
    assert.equal(launch.env.MAX_THINKING_TOKENS, process.env.MAX_THINKING_TOKENS);
    assert.equal(launch.env.ANTHROPIC_API_KEY, 'sk-ds');
    const approved = JSON.parse(fs.readFileSync(path.join(keylessConfigDir(), '.claude.json'), 'utf8')).customApiKeyResponses.approved;
    assert.ok(approved.includes('sk-ds'), 'the key is pre-approved so Claude Code uses it without a prompt');
    assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, undefined, 'shell tokens must not leak into the session');
    assert.equal(launch.env.CLAUDE_CONFIG_DIR, keylessConfigDir(), 'DeepSeek runs in the config folder that has no Claude sign-in');
    assert.equal(launch.model, 'deepseek-v4-pro');
    assert.equal(launch.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-flash');
    assert.equal(launch.env.CLAUDE_CODE_EXTRA_BODY, undefined, 'thinking stays on at Thinking effort');
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    resetConfig({});
    await stopProxies();
  }
});

test('with old-result clearing on, DeepSeek and Claude go through a local proxy; Claude keeps tool search on', async () => {
  resetConfig({});
  try {
    const ds = await buildLaunch('deepseek', 'flash', new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds' }) as any));
    assert.match(ds.env.ANTHROPIC_BASE_URL ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
    const claude = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets() as any));
    assert.match(claude.env.ANTHROPIC_BASE_URL ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(claude.env.ANTHROPIC_BASE_URL, ds.env.ANTHROPIC_BASE_URL, 'one proxy per upstream');
    assert.equal(ds.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 'not set: it adds a system message to every request');
    assert.equal(claude.env.ENABLE_TOOL_SEARCH, 'true', 'without it every tool definition is sent upfront (55k vs 33k tokens measured)');
    const keyed = await buildLaunch('claude', 'flash', new Credentials(fakeSecrets({ 'dualAgent.anthropicApiKey': 'sk-ant-x' }) as any));
    assert.equal(keyed.env.CLAUDE_CODE_PROMPT_CACHE_TTL, '1h');
  } finally {
    await stopProxies();
  }
});

test('Claude: server-side clearing is off unless chosen, cache diagnostics on, and fork mode off so helpers can be waited for', async () => {
  resetConfig({});
  try {
    const claude = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets() as any));
    assert.match(claude.env.ANTHROPIC_BASE_URL ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'the proxy carries cache diagnostics');
    assert.equal(claude.env.CLAUDE_CODE_FORK_SUBAGENT, '0', 'fork mode removes run_in_background from the Agent tool');
    assert.equal(claude.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, '1');
    resetConfig({ 'claude.clearOldToolResults': true });
    const clearing = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets() as any));
    assert.notEqual(clearing.env.ANTHROPIC_BASE_URL, claude.env.ANTHROPIC_BASE_URL, 'clearing has its own proxy');
    const ds = await buildLaunch('deepseek', 'flash', new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds' }) as any));
    assert.equal(ds.env.CLAUDE_CODE_FORK_SUBAGENT, '0');
  } finally {
    resetConfig({});
    await stopProxies();
  }
});

test('a Claude chat with DeepSeek helpers keeps its sign-in and sends the helpers through its proxy', async () => {
  resetConfig({ clearOldToolResults: false });
  try {
    const claude = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds' }) as any), { work: 'deepseek', plan: 'claude' });
    assert.deepEqual(claude.roster, { work: 'deepseek', plan: 'claude' });
    assert.match(claude.env.ANTHROPIC_BASE_URL ?? '', /^http:\/\/127\.0\.0\.1:\d+$/, 'a proxy even with clearing off: it carries the helpers');
    assert.equal(claude.env.ANTHROPIC_API_KEY, undefined, 'the main agent stays on the sign-in');
    assert.equal(claude.env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-flash', 'built-in helpers too');
    const noKey = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets() as any), { work: 'deepseek', plan: 'deepseek' });
    assert.deepEqual(noKey.roster, { work: 'claude', plan: 'claude' }, 'no DeepSeek key: helpers stay on Claude');
    assert.equal(noKey.env.CLAUDE_CODE_SUBAGENT_MODEL, 'sonnet');
  } finally {
    resetConfig({});
    await stopProxies();
  }
});

test('a DeepSeek chat with Claude planning runs signed in behind the Claude proxy, which diverts its DeepSeek requests', async () => {
  resetConfig({});
  try {
    const creds = new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds' }) as any);
    const mixed = await buildLaunch('deepseek', 'thinking', creds, { work: 'deepseek', plan: 'claude' });
    assert.deepEqual(mixed.roster, { work: 'deepseek', plan: 'claude' });
    assert.equal(mixed.model, 'deepseek-v4-pro');
    assert.match(mixed.env.ANTHROPIC_BASE_URL ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(mixed.env.ANTHROPIC_API_KEY, undefined, 'the Claude helpers use the sign-in; the proxy swaps in the DeepSeek key');
    assert.equal(mixed.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined, 'opus stays Claude for the planner');
    assert.equal(mixed.env.CLAUDE_CODE_EXTRA_BODY, undefined, 'Claude helpers must not get DeepSeek\'s thinking switch');
    assert.equal(mixed.env.ANTHROPIC_SMALL_FAST_MODEL, 'deepseek-flash', 'background calls stay on DeepSeek');
    const solo = await buildLaunch('deepseek', 'thinking', creds);
    assert.deepEqual(solo.roster, { work: 'deepseek', plan: 'deepseek' });
    assert.equal(solo.env.ANTHROPIC_API_KEY, 'sk-ds', 'DeepSeek only: the keyless folder and the DeepSeek key');
  } finally {
    resetConfig({});
    await stopProxies();
  }
});

test('Flash effort on DeepSeek uses the flash model and turns thinking off', async () => {
  const creds = new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds' }) as any);
  const launch = await buildLaunch('deepseek', 'flash', creds);
  assert.equal(launch.model, 'deepseek-flash');
  assert.deepEqual(JSON.parse(launch.env.CLAUDE_CODE_EXTRA_BODY!), { thinking: { type: 'disabled' } });
  assert.deepEqual(launch.thinking, { type: 'disabled' });
});

test('DeepSeek launch without any key fails clearly', async () => {
  await assert.rejects(buildLaunch('deepseek', 'thinking', new Credentials(fakeSecrets() as any)), MissingCredentialError);
});

test('Claude launch uses the sign-in (no key, no base URL) unless an Anthropic key is set', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
  resetConfig({ cacheDiagnostics: false });
  try {
    const signedIn = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets() as any));
    assert.equal(signedIn.env.ANTHROPIC_BASE_URL, undefined, 'a DeepSeek URL in the shell must not redirect Claude');
    assert.equal(signedIn.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(signedIn.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR, 'the signed-in Claude uses your normal config folder');
    assert.equal(signedIn.effort, 'medium', 'Thinking means medium unless dualAgent.claude.thinkingEffort says more');

    const keyed = await buildLaunch('claude', 'flash', new Credentials(fakeSecrets({ 'dualAgent.anthropicApiKey': 'sk-ant-x' }) as any));
    assert.equal(keyed.env.ANTHROPIC_API_KEY, 'sk-ant-x');
    assert.equal(keyed.env.CLAUDE_CONFIG_DIR, keylessConfigDir(), 'away from the sign-in, or Claude Code ignores the key');
    assert.equal(keyed.effort, 'low');
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    resetConfig({});
  }
});

test('Claude chats send no telemetry or error reports of their own; a value set in the shell is kept', async () => {
  const before = process.env.DISABLE_ERROR_REPORTING;
  process.env.DISABLE_ERROR_REPORTING = '0';
  resetConfig({ cacheDiagnostics: false });
  try {
    const claude = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets() as any));
    assert.equal(claude.env.DISABLE_TELEMETRY, process.env.DISABLE_TELEMETRY ?? '1');
    assert.equal(claude.env.DISABLE_ERROR_REPORTING, '0');
  } finally {
    if (before === undefined) delete process.env.DISABLE_ERROR_REPORTING;
    else process.env.DISABLE_ERROR_REPORTING = before;
    resetConfig({});
  }
});

test('both providers skip titles, prompt suggestions, away summaries and the marketplace install; a shell value is kept', async () => {
  const before = process.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY;
  process.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY = '1';
  resetConfig({ cacheDiagnostics: false });
  try {
    const claude = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets() as any));
    const ds = await buildLaunch('deepseek', 'flash', new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds' }) as any));
    for (const { env } of [claude, ds]) {
      assert.equal(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
      assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false');
      assert.equal(env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, '1');
      assert.equal(env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY, '1');
      assert.equal(env.CLAUDE_CODE_ENABLE_TASKS, process.env.CLAUDE_CODE_ENABLE_TASKS ?? '0', 'TodoWrite, which the plan panel reads');
    }
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY;
    else process.env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY = before;
    resetConfig({});
  }
});

test('the keyless config folder really has no Claude sign-in, and shares conversations', () => {
  const dir = keylessConfigDir();
  // Exits non-zero when signed out; the JSON is what matters.
  const out = spawnSync(claudeBinary(), ['auth', 'status'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8' });
  const status = JSON.parse(out.stdout);
  assert.equal(status.loggedIn, false, 'Claude Code finds no sign-in there, so none can be sent to DeepSeek');
  assert.equal(fs.realpathSync(path.join(dir, 'projects')), fs.realpathSync(path.join(mainConfigDir(), 'projects')));
  assert.equal(keylessConfigDir(), dir, 'calling again is harmless');
});

test('model names follow settings', () => {
  config['deepseek.model'] = 'my-pro';
  config['deepseek.fastModel'] = 'my-flash';
  config['claude.model'] = 'claude-sonnet-5-5';
  assert.equal(modelFor('deepseek', 'thinking'), 'my-pro');
  assert.equal(modelFor('deepseek', 'flash'), 'my-flash');
  assert.equal(modelFor('claude', 'flash'), 'claude-sonnet-5-5');
});

test('the bundled Claude Code binary is found', () => {
  const bin = claudeBinary();
  assert.ok(path.isAbsolute(bin) && fs.existsSync(bin), `expected the SDK's platform binary, got ${bin}`);
});

test('web tools: built-in search on both, Dual Agent\'s on DeepSeek with a search key, unless set otherwise', () => {
  config['deepseek.apiKeyFile'] = keyFile('nosearch.env', 'DEEPSEEK_API_KEY=sk-x\nBRAVE_API_KEY=\n');
  assert.equal(usesOwnWebTools('deepseek'), false, 'no key: the free scrapers get blocked, DeepSeek\'s server-side search does not');
  config['deepseek.apiKeyFile'] = keyFile('brave.env', 'DEEPSEEK_API_KEY=sk-x\nBRAVE_API_KEY=brave-123\n');
  assert.equal(usesOwnWebTools('deepseek'), true);
  assert.equal(usesOwnWebTools('claude'), false);
  config.webTools = 'dualAgent';
  assert.equal(usesOwnWebTools('claude'), true);
  config.webTools = 'builtin';
  assert.equal(usesOwnWebTools('deepseek'), false);
});

test('search API keys are read from the credentials file; empty ones count as unset', () => {
  config['deepseek.apiKeyFile'] = keyFile('search.env', 'DEEPSEEK_API_KEY=sk-x\nBRAVE_API_KEY=brave-123\nTAVILY_API_KEY=\n');
  assert.deepEqual(searchKeys(), { brave: 'brave-123', tavily: undefined });
});

test('an unreadable .claude.json in the key-only folder is backed up, not silently overwritten', async () => {
  resetConfig({ clearOldToolResults: false });
  const file = path.join(keylessConfigDir(), '.claude.json');
  fs.writeFileSync(file, '{"half-written": ');
  await buildLaunch('deepseek', 'flash', new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds-backup-test' }) as any));
  const backups = fs.readdirSync(keylessConfigDir()).filter((f) => f.startsWith('.claude.json.unreadable-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(keylessConfigDir(), backups[0]), 'utf8'), '{"half-written": ');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).customApiKeyResponses.approved.includes('sk-ds-backup-test'.slice(-20)));
});

test('a split set in a repo stays that repo\'s default; other repos keep the setting', async () => {
  resetConfig({ tokenSplit: 50 });
  const saved = new Map<string, unknown>();
  let changed = 0;
  useRepoSettings({ keys: () => [...saved.keys()], get: (k: string) => saved.get(k), update: async (k: string, v: unknown) => void saved.set(k, v) } as never, () => changed++);
  assert.equal(tokenSplit(), 50, 'nothing set in this repo: the setting');
  await saveTokenSplit(70);
  assert.equal(tokenSplit(), 70);
  assert.equal(config.tokenSplit, 50, 'the setting for other repos is untouched');
  assert.equal(changed, 1, 'open chats re-route');
  await saveTokenSplit(null);
  assert.equal(tokenSplit(), undefined, 'off in this repo only');
});

test('launch: helpers are capped, one level deep, on the 5-minute cache, and general-purpose runs at medium effort', async () => {
  resetConfig({});
  try {
    for (const provider of ['claude', 'deepseek'] as const) {
      const launch = await buildLaunch(provider, 'thinking', new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds' }) as any));
      assert.equal(launch.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? '4', provider);
      assert.equal(launch.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH ?? '1');
      assert.equal(launch.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, process.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL ?? '5m');
    }
    resetConfig({ maxParallelHelpers: 99 });
    const capped = await buildLaunch('deepseek', 'flash', new Credentials(fakeSecrets({ 'dualAgent.deepseekApiKey': 'sk-ds' }) as any));
    assert.equal(capped.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? '20', 'clamped to Claude Code\'s own maximum');
    assert.equal(helperAgents({ work: 'claude', plan: 'claude' })['general-purpose'].effort, 'medium');
  } finally {
    await stopProxies();
  }
});

test('launch: Claude thinks at medium unless chosen; fast mode and the Opus advisor are opt-in settings; a read-only searcher helper exists', async () => {
  try {
    resetConfig({});
    const plain = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets() as any));
    assert.equal(plain.effort, 'medium');
    assert.equal(plain.settings, undefined);
    assert.equal(plain.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING, process.env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING ?? '1', 'large edits stream through the proxy');
    resetConfig({ 'claude.thinkingEffort': 'high', 'claude.fastMode': true, 'claude.advisor': true });
    const tuned = await buildLaunch('claude', 'thinking', new Credentials(fakeSecrets() as any));
    assert.equal(tuned.effort, 'high');
    assert.deepEqual(tuned.settings, { fastMode: true, advisorModel: 'opus' });
    assert.equal(tuned.model, 'sonnet', 'the advisor runs the main agent on Sonnet');
    assert.equal(tuned.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, process.env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK ?? '1');
    resetConfig({});
    const searcher = helperAgents({ work: 'deepseek', plan: 'deepseek' }).searcher;
    assert.equal(searcher.readOnly, true);
    assert.equal(searcher.effort, 'low');
    assert.ok(searcher.maxTurns <= 8);
  } finally {
    await stopProxies();
  }
});

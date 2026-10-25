/**
 * Runs inside a real VS Code with the extension loaded. Uses the extension's
 * exported API to look inside the open chats.
 */
import * as vscode from 'vscode';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DualAgentApi } from '../../extension';
import type { ChatSession } from '../../chatView';
import type { ToWebview } from '../../agentController';
import { MockAnthropic, lastUserText } from '../helpers/mockAnthropic';
import { definition, errorSnapshot, newErrors, outline, problems, references } from '../../code/lsp';
import { run, test, waitFor } from './harness';

// The extension id is <publisher>.<name> from package.json. From out/test/vscode/ or src/test/vscode/ it is three levels up.
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { publisher: string; name: string };
const EXT_ID = `${pkg.publisher}.${pkg.name}`;

type State = Extract<ToWebview, { type: 'state' }>;

const workspace = process.env.DUAL_AGENT_TEST_WORKSPACE!;
const sample = path.join(workspace, 'src', 'sample.ts');
const other = path.join(workspace, 'src', 'other.ts');

let api: DualAgentApi;
let chat: ChatSession;
const state = () => chat.lastState as State | undefined;

test('the extension activates and registers its commands', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, 'extension is installed in the test VS Code');
  api = (await ext.activate()) as DualAgentApi;
  assert.ok(api?.sessions, 'activate returns the test API');
  const commands = await vscode.commands.getCommands(true);
  const contributed: { command: string }[] = ext.packageJSON.contributes.commands;
  for (const { command } of contributed) {
    assert.ok(commands.includes(command), `${command} is registered`);
  }
});

test('Show Failures opens a report of the failure log', async () => {
  await vscode.commands.executeCommand('dualAgent.showFailures');
  const doc = await waitFor('the failures report', () => vscode.workspace.textDocuments.find((d) => d.languageId === 'markdown' && d.isUntitled && d.getText().startsWith('# Dual Agent failures')));
  assert.match(doc.getText(), /last 24 hours/);
});

test('the logo button sits in the editor title bar, next to Claude', async () => {
  const ext = vscode.extensions.getExtension(EXT_ID)!;
  const entry = ext.packageJSON.contributes.menus['editor/title'].find((m: any) => m.command === 'dualAgent.openInEditor');
  assert.ok(entry, 'editor/title has the open button');
  assert.equal(entry.group, 'navigation', 'shown as an icon, not in the ... menu');
  const cmd = ext.packageJSON.contributes.commands.find((c: any) => c.command === 'dualAgent.openInEditor');
  for (const icon of [cmd.icon.light, cmd.icon.dark]) {
    assert.ok(fs.existsSync(path.join(ext.extensionPath, icon)), `${icon} exists`);
  }
});

test('opening the chat from a file with highlighted lines shows that file and those lines', async () => {
  const doc = await vscode.workspace.openTextDocument(sample);
  const editor = await vscode.window.showTextDocument(doc);
  editor.selection = new vscode.Selection(1, 0, 3, 1); // lines 2-4
  await new Promise((r) => setTimeout(r, 300));

  const before = api.sessions().length;
  await vscode.commands.executeCommand('dualAgent.openInEditor');
  chat = await waitFor('a new chat', () => api.sessions().length > before && api.sessions().at(-1));
  await waitFor('the chat page to load in VS Code', () => chat.webviewReady, 20_000);

  const s = await waitFor('state with the editor', () => state()?.editor && state());
  assert.equal(s.editor!.name, 'sample.ts');
  assert.equal(s.editor!.path, sample);
  assert.equal(s.editor!.selection, '2-4');
  assert.equal(s.cwd, workspace, 'the chat works in the codebase the file belongs to');

  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label.startsWith('Dual Agent'));
  assert.equal(tab?.label, `Dual Agent · ${path.basename(workspace)}`);
});

test('the file stays in the chat after clicking into the chat', async () => {
  // Click into the chat: it sits beside the file, in the second editor group.
  await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
  // macOS doesn't always give focus to a test window in the background; the
  // unit tests cover that case either way.
  await waitFor('focus to move to the chat', () => vscode.window.activeTextEditor === undefined, 5000).catch(() =>
    console.log('    (VS Code window not focused by the OS; focus check skipped)'),
  );
  chat.controller.emitState();
  assert.equal(state()?.editor?.name, 'sample.ts');
});

test('highlighting different lines updates the chat', async () => {
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample), vscode.ViewColumn.One);
  editor.selection = new vscode.Selection(5, 0, 5, 10); // line 6
  await waitFor('selection 6-6', () => state()?.editor?.selection === '6-6');
  editor.selection = new vscode.Selection(5, 3, 5, 3); // just a cursor
  await waitFor('no selection', () => state()?.editor && !state()!.editor!.selection);
});

test('switching to another file switches the chip', async () => {
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(other), vscode.ViewColumn.One);
  await waitFor('other.ts in the chat', () => state()?.editor?.name === 'other.ts');
});

test('the chosen theme reaches the chat', async () => {
  await vscode.workspace.getConfiguration('dualAgent').update('theme', 'ember', vscode.ConfigurationTarget.Global);
  await waitFor('ember theme', () => state()?.theme === 'ember');
  await vscode.workspace.getConfiguration('dualAgent').update('theme', undefined, vscode.ConfigurationTarget.Global);
});

test('a full message in VS Code: the agent runs, and the file and lines reach the model', async () => {
  const mock = new MockAnthropic();
  const url = await mock.start();
  const keyFile = path.join(os.tmpdir(), `dual-agent-key-${process.pid}.env`);
  fs.writeFileSync(keyFile, 'DEEPSEEK_API_KEY=sk-vscode-test\n');
  const cfg = () => vscode.workspace.getConfiguration('dualAgent');
  try {
    await cfg().update('mode', 'deepseek', vscode.ConfigurationTarget.Global);
    await cfg().update('deepseek.baseUrl', url, vscode.ConfigurationTarget.Global);
    await cfg().update('deepseek.apiKeyFile', keyFile, vscode.ConfigurationTarget.Global);
    await chat.controller.refreshStatus();
    await waitFor('DeepSeek ready', () => state()?.deepseek.ready && state()?.next === 'deepseek');

    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample), vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(1, 0, 3, 1);
    await waitFor('selection 2-4', () => state()?.editor?.selection === '2-4');

    const posted: ToWebview[] = [];
    const sub = chat.onDidPost((m) => posted.push(m));
    await chat.controller.send({ text: 'What does this do?', attachments: [], includeEditor: true });
    await waitFor('the reply to finish', () => posted.some((m) => m.type === 'done'), 90_000);
    sub.dispose();

    const reply = posted.filter((m) => m.type === 'delta').map((m: any) => m.text).join('');
    assert.equal(reply, 'pong from mock');
    const user = posted.find((m) => m.type === 'user') as Extract<ToWebview, { type: 'user' }>;
    assert.equal(user.editor?.name, 'sample.ts');
    assert.equal(user.editor?.selection, '2-4');

    const req = mock.conversationRequests[0];
    assert.equal(req.headers['x-api-key'], 'sk-vscode-test');
    assert.equal(req.headers.authorization, undefined, 'no claude.ai sign-in token is sent to DeepSeek');
    const seen = lastUserText(req);
    assert.ok(seen.includes(sample), 'the model was told which file is open');
    assert.ok(seen.includes('selected lines 2-4'), 'and which lines are highlighted');
    assert.ok(seen.includes('export function greet'), 'and given the highlighted code');
  } finally {
    await cfg().update('mode', undefined, vscode.ConfigurationTarget.Global);
    await cfg().update('deepseek.baseUrl', undefined, vscode.ConfigurationTarget.Global);
    await cfg().update('deepseek.apiKeyFile', undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(keyFile, { force: true });
    await mock.stop();
  }
});

test('the chat is saved in this repo\'s VS Code storage', async () => {
  const saved = await waitFor('a saved chat', () => api.history.list()[0]);
  assert.equal(saved.title, 'What does this do?');
  const full = api.history.get(saved.id)!;
  assert.ok(full.sessionId, 'the Claude Code session is saved so it can be resumed');
  assert.deepEqual(full.providers, ['deepseek']);
  const types = full.transcript.map((e) => e.type);
  assert.deepEqual(types.filter((t) => t !== 'usage' && t !== 'agents'), ['user', 'assistantStart', 'delta', 'done']);
  assert.ok(types.includes('agents'), 'the agents panel is saved with the chat');
  assert.equal(chat.chatId, saved.id);
});

test('a reopened chat shows its messages and the agent remembers the conversation', async () => {
  const savedId = api.history.list()[0].id;
  const savedSession = api.history.get(savedId)!.sessionId;
  chat.controller.newChat();
  assert.equal(chat.chatId, undefined, 'a new chat is separate');

  assert.ok(chat.openChat(savedId));
  assert.equal(chat.chatId, savedId);
  assert.equal(chat.controller.conversationId, savedSession);

  // Ask a follow-up; the resumed session must carry the earlier messages to the model.
  const mock = new MockAnthropic();
  const url = await mock.start();
  const keyFile = path.join(os.tmpdir(), `dual-agent-key2-${process.pid}.env`);
  fs.writeFileSync(keyFile, 'DEEPSEEK_API_KEY=sk-vscode-test\n');
  const cfg = () => vscode.workspace.getConfiguration('dualAgent');
  try {
    await cfg().update('mode', 'deepseek', vscode.ConfigurationTarget.Global);
    await cfg().update('deepseek.baseUrl', url, vscode.ConfigurationTarget.Global);
    await cfg().update('deepseek.apiKeyFile', keyFile, vscode.ConfigurationTarget.Global);
    await chat.controller.refreshStatus();
    const posted: ToWebview[] = [];
    const sub = chat.onDidPost((m) => posted.push(m));
    await chat.controller.send({ text: 'And the follow-up?', attachments: [], includeEditor: false });
    await waitFor('the follow-up reply', () => posted.some((m) => m.type === 'done'), 90_000);
    sub.dispose();
    const messages = mock.conversationRequests[0].body.messages;
    const userTexts = JSON.stringify(messages.filter((m: any) => m.role === 'user'));
    assert.ok(userTexts.includes('What does this do?'), 'the earlier question was resumed');
    assert.ok(userTexts.includes('And the follow-up?'));
    assert.equal(api.history.list().length, 1, 'the follow-up went into the same saved chat');
    assert.equal(api.history.list()[0].messages, 2);
  } finally {
    await cfg().update('mode', undefined, vscode.ConfigurationTarget.Global);
    await cfg().update('deepseek.baseUrl', undefined, vscode.ConfigurationTarget.Global);
    await cfg().update('deepseek.apiKeyFile', undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(keyFile, { force: true });
    await mock.stop();
  }
});

test('the sidebar opens with this repo\'s latest chat', async () => {
  const before = api.sessions().length;
  await vscode.commands.executeCommand('dualAgent.chat.focus');
  const sidebar = await waitFor('the sidebar chat', () => api.sessions().length > before && api.sessions().at(-1));
  await waitFor('the sidebar page to load', () => sidebar.webviewReady, 20_000);
  await waitFor('the latest chat restored', () => sidebar.chatId === api.history.list()[0].id);
});

/** Replaces a vscode.window dialog for the length of `fn`, recording what it was asked. */
async function withDialog<K extends 'showQuickPick' | 'showWarningMessage' | 'showInformationMessage'>(name: K, answer: (...args: any[]) => any, fn: (calls: any[][]) => Promise<void>) {
  const original = (vscode.window as any)[name];
  const calls: any[][] = [];
  (vscode.window as any)[name] = async (...args: any[]) => {
    calls.push(args);
    return answer(...args);
  };
  try {
    await fn(calls);
  } finally {
    (vscode.window as any)[name] = original;
  }
}

test('Set Reply Style changes the setting', async () => {
  await withDialog('showQuickPick', (items: any[]) => items.find((i) => i.style === 'ultra'), async () => {
    await vscode.commands.executeCommand('dualAgent.setReplyStyle');
  });
  assert.equal(vscode.workspace.getConfiguration('dualAgent').get('replyStyle'), 'ultra');
  await vscode.workspace.getConfiguration('dualAgent').update('replyStyle', undefined, vscode.ConfigurationTarget.Global);
});

test('Compress Memory File refuses a secrets file without sending anything', async () => {
  const env = path.join(workspace, '.env');
  fs.writeFileSync(env, 'TOKEN=x\n');
  await withDialog('showWarningMessage', () => undefined, async (calls) => {
    await vscode.commands.executeCommand('dualAgent.compressMemory', vscode.Uri.file(env));
    assert.match(String(calls[0]?.[0]), /looks like it holds secrets/);
  });
});

test('Clear History: Cancel keeps the chats; Delete removes them and open chats don\'t save them back', async () => {
  const before = api.history.list().length;
  assert.ok(before > 0, 'there is a saved chat to clear');
  await withDialog('showWarningMessage', () => undefined, async () => {
    await vscode.commands.executeCommand('dualAgent.clearHistory');
  });
  assert.equal(api.history.list().length, before, 'Cancel keeps them');
  await withDialog('showWarningMessage', () => 'Delete', async () => {
    await vscode.commands.executeCommand('dualAgent.clearHistory');
  });
  assert.equal(api.history.list().length, 0);
  // An open chat saving (as it does on close) must not bring its chat back.
  for (const s of api.sessions()) {
    s.dispose();
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(api.history.list().length, 0);
});

test('code_outline lists a file\'s functions and constants with line ranges', async () => {
  const text = await outline(workspace, 'src/sample.ts');
  assert.match(text, /^src\/sample\.ts \(7 lines\)/);
  assert.match(text, /L2-4 export function greet\(name: string\)/);
  assert.match(text, /L6-6 export const answer = 42;/);
});

test('code_definition follows an import to the definition, with its signature', async () => {
  const text = await definition(workspace, { path: 'src/uses.ts', line: 4, symbol: 'greet' });
  assert.match(text, /^src\/sample\.ts:2 {2}export function greet\(name: string\) \{/);
  assert.match(text, /function greet\(name: string\): string/);
});

test('code_definition finds a name across the workspace without a path', async () => {
  assert.match(await definition(workspace, { symbol: 'welcome' }), /^src\/uses\.ts:3 /);
});

test('code_references lists every use, with the function it is in', async () => {
  const text = await references(workspace, { path: 'src/sample.ts', symbol: 'greet' });
  assert.match(text, /src\/uses\.ts\n {2}L1: import \{ greet \} from '\.\/sample';\n {2}L4 in welcome: return greet\('team'\);/);
  assert.match(text, /src\/sample\.ts\n {2}L2/);
});

test('code_problems reports type errors the editor found', async () => {
  assert.match(problems(workspace, 'src/broken.ts'), /hasn't checked src\/broken\.ts/, 'a closed file is not reported as clean');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(workspace, 'src', 'broken.ts')));
  await waitFor('diagnostics for broken.ts', () => vscode.languages.getDiagnostics(vscode.Uri.file(path.join(workspace, 'src', 'broken.ts'))).length > 0, 30_000);
  assert.match(problems(workspace, 'src/broken.ts'), /src\/broken\.ts\n {2}L1 error: Type 'string' is not assignable to type 'number'\./);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample));
  await new Promise((r) => setTimeout(r, 1500));
  assert.match(problems(workspace, 'src/sample.ts'), /No errors or warnings in src\/sample\.ts/);
});

test('after an edit to an open file the agent hears of the errors it introduced, not the ones already there', async () => {
  const file = path.join(workspace, 'src', 'edited.ts');
  fs.writeFileSync(file, 'export const a: number = 1;\n');
  assert.equal(errorSnapshot(file), undefined, 'not open in a tab: the server would not check it');
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, preserveFocus: true });
  await new Promise((r) => setTimeout(r, 1000));
  const before = errorSnapshot(file);
  const bad = "export const b: number = 'two';";
  fs.writeFileSync(file, `export const a: number = 1;\n${bad}\n`);
  assert.match((await newErrors(workspace, file, before)) ?? '', /1 new error in src\/edited\.ts:\n {2}L2: Type 'string' is not assignable to type 'number'/);
  const again = errorSnapshot(file);
  fs.writeFileSync(file, `export const a: number = 1;\n${bad}\nexport const c = 3;\n`);
  assert.equal(await newErrors(workspace, file, again), undefined, 'the old error is not reported again');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  fs.rmSync(file);
});

export { run };

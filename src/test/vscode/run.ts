/**
 * Launches a separate copy of the installed VS Code with a throwaway profile, loads this extension from source,
 * and runs suite.ts inside it. Your own VS Code windows and settings are not
 * touched.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const INSTALLED = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

async function main() {
  // Set when this runs from a VS Code terminal or extension; it would make the
  // test VS Code start as plain Node instead of as the editor.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Never download VS Code: tests don't go online.
  const vscode = process.env.VSCODE_PATH ?? INSTALLED;
  if (!fs.existsSync(vscode)) {
    console.log(`VS Code tests skipped: no VS Code at ${vscode} (set VSCODE_PATH).`);
    return;
  }
  const root = path.resolve(__dirname, '../../..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-vscode-test-'));
  const workspace = path.join(scratch, 'sample-project');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'src', 'sample.ts'),
    ['// A sample file for the tests.', 'export function greet(name: string) {', "  return `Hello, ${name}!`;", '}', '', 'export const answer = 42;', ''].join('\n'),
  );
  fs.writeFileSync(path.join(workspace, 'src', 'other.ts'), 'export const other = true;\n');
  // For the language-server tools: a caller of greet, and a type error.
  fs.writeFileSync(path.join(workspace, 'src', 'uses.ts'), "import { greet } from './sample';\n\nexport function welcome() {\n  return greet('team');\n}\n");
  fs.writeFileSync(path.join(workspace, 'src', 'broken.ts'), "export const count: number = 'not a number';\n");

  try {
    await runTests({
      vscodeExecutablePath: vscode,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${path.join(scratch, 'user-data')}`,
        `--extensions-dir=${path.join(scratch, 'extensions')}`,
      ],
      extensionTestsEnv: {
        DUAL_AGENT_TEST_WORKSPACE: workspace,
        DEEPSEEK_KEY_FILE: process.env.DEEPSEEK_KEY_FILE ?? path.join(root, 'credentials', 'deepseek.env'),
      },
    });
  } catch (err) {
    console.error('VS Code tests failed:', err);
    process.exit(1);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

void main();

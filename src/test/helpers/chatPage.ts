/**
 * Renders the real chat webview (HTML, CSS and script from media/) in Chrome,
 * with VS Code's own injected webview styles, so tests can drive and
 * screenshot it the way it appears inside VS Code.
 */
import './vscodeStub';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { vscode } from './vscodeStub';
import { html } from '../../chatView';

export const ROOT = path.resolve(__dirname, '../../..');
export const OUTPUT = path.join(ROOT, 'test-output');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean) as string[];

const VSCODE_WEBVIEW_PRE = '/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html';

export function chromePath(): string | undefined {
  return CHROME_PATHS.find((p) => fs.existsSync(p));
}

/** The stylesheet VS Code injects into every webview, read from the installed VS Code when present. */
function vscodeDefaultStyles(): string {
  try {
    const src = fs.readFileSync(VSCODE_WEBVIEW_PRE, 'utf8');
    const match = src.match(/defaultStyles\.textContent = `([\s\S]*?)`;/);
    if (match) {
      return match[1];
    }
  } catch {
    // VS Code not installed here; fall back to the rule that matters most.
  }
  return '@layer vscode-default { body { margin: 0; padding: 0 20px; } textarea:focus { outline: 1px solid -webkit-focus-ring-color; outline-offset: -1px; } }';
}

// A few of the theme variables VS Code sets on the webview (Dark Modern).
const VSCODE_THEME_VARS = `
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, monospace;
  --vscode-editor-foreground: #cccccc;
  --vscode-editor-background: #1f1f1f;
  --vscode-sideBar-background: #181818;
  --vscode-foreground: #cccccc;
  --vscode-input-background: #313131;
  --vscode-focusBorder: #0078d4;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-textLink-foreground: #4daafc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-panel-border: #2b2b2b;
`;

export interface ChatPage {
  page: Page;
  /** Delivers a message from the extension to the webview. */
  send(msg: unknown): Promise<void>;
  /** Messages the webview posted to the extension. */
  posted(): Promise<any[]>;
  screenshot(name: string): Promise<string>;
  close(): Promise<void>;
}

let browser: Browser | undefined;

/** `mediaDir`: where the page's files are (the packaged build joins them; see scripts/bundle.mjs). */
export async function openChatPage(width = 420, height = 720, mediaDir = path.join(ROOT, 'media')): Promise<ChatPage> {
  const executablePath = chromePath();
  if (!executablePath) {
    throw new Error('Chrome not found; set CHROME_PATH');
  }
  browser ??= await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });

  const media = vscode.Uri.file(mediaDir);
  const webview = {
    cspSource: 'file:',
    asWebviewUri: (uri: { fsPath: string }) => pathToFileURL(uri.fsPath).toString(),
  };
  const body = html(webview as any, media as any)
    // Like VS Code, inject the default styles ahead of the page's own CSP and styles.
    .replace('<head>', `<head>\n<style id="_defaultStyles">${vscodeDefaultStyles()}</style>`)
    .replace('<html lang="en">', `<html lang="en" style="${VSCODE_THEME_VARS.replace(/\n/g, ' ')}">`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const file = path.join(OUTPUT, `chat-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(file, body);

  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(() => {
    (window as any).__posted = [];
    (window as any).acquireVsCodeApi = () => ({
      postMessage: (m: unknown) => (window as any).__posted.push(m),
      getState: () => undefined,
      setState: () => undefined,
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(m.text());
    }
  });
  await page.goto(pathToFileURL(file).toString());
  await page.waitForFunction(() => (window as any).__posted.some((m: any) => m.type === 'ready'));
  if (errors.length) {
    throw new Error(`Chat page errors:\n${errors.join('\n')}`);
  }

  return {
    page,
    send: async (msg) => {
      await page.evaluate((m) => window.postMessage(m, '*'), msg as any);
      // Let the message handler run and the layout settle.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))));
      if (errors.length) {
        throw new Error(`Chat page errors:\n${errors.splice(0).join('\n')}`);
      }
    },
    posted: () => page.evaluate(() => (window as any).__posted),
    screenshot: async (name) => {
      const out = path.join(OUTPUT, `${name}.png`);
      await page.screenshot({ path: out as `${string}.png` });
      return out;
    },
    close: async () => {
      await page.close();
      fs.rmSync(file, { force: true });
    },
  };
}

export async function closeBrowser() {
  await browser?.close();
  browser = undefined;
}

/** A state message like the extension sends, with overrides. */
export function stateMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'state',
    mode: 'auto',
    effort: 'thinking',
    permissionMode: 'default',
    buildMode: 'hybrid',
    split: null,
    next: 'claude',
    busy: false,
    cwd: '/Users/me/projects/my-app',
    theme: 'midnight',
    claude: { ready: true, detail: 'Signed in', account: 'me@example.com' },
    deepseek: { ready: true, detail: 'API key set' },
    ...overrides,
  };
}

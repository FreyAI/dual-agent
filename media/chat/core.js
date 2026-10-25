// @ts-check
/** The chat page's shared state, elements, icons and small helpers. The page loads media/chat/*.js as
 * plain scripts in order (chatView.ts SCRIPTS): their top-level names are shared, so each file uses
 * what earlier ones declare; main.js, last, routes the extension's messages and starts the page. */
// @ts-ignore acquireVsCodeApi is provided by the webview host.
const vscode = acquireVsCodeApi();
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const log = $('log');
const promptBox = /** @type {HTMLTextAreaElement} */ ($('prompt'));
const sendBtn = $('send');
const menu = $('menu');
const chips = $('chips');
const logoSrc = /** @type {HTMLImageElement} */ (document.querySelector('.brand-mark')).src;

const NAMES = { claude: 'Claude', deepseek: 'DeepSeek' };
const ICON = (body) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const TOOL_ICONS = {
  file: ICON('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>'),
  edit: ICON('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  terminal: ICON('<path d="m4 17 6-6-6-6M12 19h8"/>'),
  search: ICON('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  globe: ICON('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>'),
  tool: ICON('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
};
const FILE_ICON = TOOL_ICONS.file;

/** @type {any} Latest state from the extension. */
let state = null;
let busy = false;
/** Whether the conversation has anything in it; until then the welcome screen shows. */
let started = false;
/** @type {string[]} */
let attachments = [];
let includeEditor = true;
/** The assistant bubble text is streamed into, and its raw markdown. */
let current = null;
let currentText = '';
/** @type {HTMLElement | null} */
let typing = null;
let welcomeHtml = '';
/** This repo's saved chats, newest first, and the one shown here. */
let savedChats = [];
let currentChat;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "Flash" is DeepSeek's fast model; on Claude the same setting is low effort, "Fast". */
function effortName(provider, effort) {
  return effort === 'flash' ? (provider === 'deepseek' ? 'Flash' : 'Fast') : 'Thinking';
}

function basename(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() || p;
}

/** Paths inside the project read better relative to it (either slash, for Windows). */
function relative(p) {
  const root = state?.cwd;
  return root && (p.startsWith(root + '/') || p.startsWith(root + '\\')) ? p.slice(root.length + 1) : p;
}

function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)} min ago`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)} h ago`;
  }
  if (s < 7 * 86400) {
    return `${Math.floor(s / 86400)} d ago`;
  }
  return new Date(ms).toLocaleDateString();
}

function formatTokens(n) {
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  }
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

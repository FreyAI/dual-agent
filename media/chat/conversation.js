// @ts-check
/** The conversation: bubbles, the typing indicator, tool steps and the welcome screen. */
// ---------- Conversation ----------

/** Whether a saved chat is being redrawn: no layout reads then; the restore scrolls once at the end. */
const restoring = () => document.body.classList.contains('restoring');

function nearBottom() {
  return !restoring() && log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}

function scroll(force = false) {
  if (!restoring() && (force || nearBottom())) {
    log.scrollTop = log.scrollHeight;
  }
}

function startConversation() {
  if (!started) {
    started = true;
    welcomeHtml = '';
    log.innerHTML = '';
  }
}

/** @returns {HTMLElement} */
function add(cls, html, tag = 'div') {
  startConversation();
  settleSteps();
  const stick = nearBottom();
  const el = document.createElement(tag);
  el.className = `${cls} enter`;
  el.innerHTML = html;
  if (typing && typing.parentElement === log) {
    log.insertBefore(el, typing);
  } else {
    log.appendChild(el);
  }
  scroll(stick);
  return el;
}

/** Renders the streaming reply at most once a frame: re-rendering on every delta is quadratic on long replies. */
let renderQueued = false;
/** The reply's finished part (see frozenEnd) is rendered once and kept: its first `frozenNodes` children.
 * Each frame replaces only the nodes after them, so a selection in the finished part survives. */
let frozenLen = 0;
let frozenNodes = 0;
function renderCurrent() {
  renderQueued = false;
  if (current) {
    const stick = nearBottom();
    while (current.childNodes.length > frozenNodes) {
      /** @type {ChildNode} */ (current.lastChild).remove();
    }
    const end = frozenEnd(currentText, frozenLen);
    if (end > frozenLen) {
      current.insertAdjacentHTML('beforeend', renderMarkdown(currentText.slice(frozenLen, end)));
      frozenLen = end;
      frozenNodes = current.childNodes.length;
    }
    current.insertAdjacentHTML('beforeend', renderMarkdown(currentText.slice(frozenLen)));
    scroll(stick);
  }
}

function endBubble() {
  if (renderQueued) {
    renderCurrent();
  }
  current = null;
  currentText = '';
  frozenLen = 0;
  frozenNodes = 0;
}

function showTyping(label) {
  // A live step group shows its own animation.
  if (steps) {
    hideTyping();
    return;
  }
  if (!typing) {
    typing = document.createElement('div');
    typing.className = 'typing';
    typing.innerHTML = '<span class="dots"><span></span><span></span><span></span></span><span class="label"></span>';
  }
  if (label) {
    /** @type {HTMLElement} */ (typing.querySelector('.label')).textContent = label;
  }
  log.appendChild(typing);
  scroll();
}

function hideTyping() {
  typing?.remove();
}

const TOOL_LABELS = {
  mcp__web__web_search: 'Web search',
  mcp__web__web_read: 'Read page',
  mcp__web__web_search_and_read: 'Search & read',
  mcp__code__code_map: 'Code map',
  mcp__code__find_duplicates: 'Find duplicates',
  mcp__code__code_outline: 'Outline',
  mcp__code__code_definition: 'Definition',
  mcp__code__code_references: 'References',
  mcp__code__code_problems: 'Problems',
  mcp__reuse__repo_search: 'Find repos',
  mcp__reuse__repo_readme: 'Repo README',
  mcp__reuse__repo_fetch: 'Fetch & vet repo',
  mcp__reuse__repo_outline: 'Repo outline',
  mcp__reuse__repo_read: 'Read repo file',
  mcp__reuse__repo_import: 'Import code',
  mcp__reuse__repo_cleanup: 'Clean up repos',
  WebSearch: 'Web search',
  WebFetch: 'Read page',
  TodoWrite: 'Plan',
};

/** A readable name for a tool ("mcp__server__do_thing" → "do thing (server)"). */
function toolLabel(name) {
  if (TOOL_LABELS[name]) {
    return TOOL_LABELS[name];
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return mcp ? `${mcp[2].replace(/_/g, ' ')} (${mcp[1]})` : name;
}

function toolIcon(name) {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) {
    return TOOL_ICONS.edit;
  }
  if (/^(Read|LS)$/.test(name)) {
    return TOOL_ICONS.file;
  }
  if (/^(Bash|BashOutput|KillShell)$/.test(name)) {
    return TOOL_ICONS.terminal;
  }
  if (/^(Grep|Glob)$|^mcp__code__/.test(name)) {
    return TOOL_ICONS.search;
  }
  if (/^Web|^mcp__web__/.test(name)) {
    return TOOL_ICONS.globe;
  }
  return TOOL_ICONS.tool;
}

function renderDiff(preview) {
  return preview
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('+ ') ? 'diff-add' : line.startsWith('- ') ? 'diff-del' : '';
      return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
    })
    .join('\n');
}

// ---------- Steps ----------

/**
 * Tool calls in a row collapse into one line: while live it animates and
 * shows the latest step; clicking it lists every step in order.
 * @type {{ el: HTMLElement, list: HTMLElement, count: number } | null}
 */
let steps = null;
const CHEVRON = ICON('<path d="m9 18 6-6-6-6"/>');
const DOTS = '<span class="dots"><span></span><span></span><span></span></span>';

function stepContent(name, detail) {
  return `${toolIcon(name)}<span class="tool-name">${escapeHtml(toolLabel(name))}</span><span class="tool-detail">${escapeHtml(relative(detail))}</span>`;
}

function addStep(msg) {
  if (!steps) {
    const el = add('steps live', `<button class="steps-head" aria-expanded="false"><span class="steps-mark">${DOTS}</span><span class="steps-count"></span><span class="steps-current"></span>${CHEVRON}</button><ol class="steps-list"></ol>`);
    steps = { el, list: /** @type {HTMLElement} */ (el.querySelector('.steps-list')), count: 0 };
  }
  const stick = nearBottom();
  const li = document.createElement(msg.path ? 'button' : 'li');
  li.className = 'step';
  li.innerHTML = stepContent(msg.name, msg.detail);
  if (msg.path) {
    li.setAttribute('data-open', msg.path);
    li.title = `Open ${msg.path}`;
  }
  steps.list.appendChild(li);
  steps.count++;
  /** @type {HTMLElement} */ (steps.el.querySelector('.steps-count')).textContent = `${steps.count} step${steps.count === 1 ? '' : 's'}`;
  /** @type {HTMLElement} */ (steps.el.querySelector('.steps-current')).innerHTML = stepContent(msg.name, msg.detail);
  hideTyping();
  scroll(stick);
}

/** The group stops animating once the agent writes, asks, or finishes. */
function settleSteps() {
  if (!steps) {
    return;
  }
  steps.el.classList.remove('live', 'stalled');
  /** @type {HTMLElement} */ (steps.el.querySelector('.steps-mark')).innerHTML = ICON('<path d="M20 6 9 17l-5-5"/>');
  steps = null;
}

log.addEventListener('click', (e) => {
  const head = /** @type {HTMLElement} */ (e.target).closest('.steps-head');
  if (head) {
    const stick = nearBottom();
    const open = head.parentElement?.classList.toggle('open');
    head.setAttribute('aria-expanded', String(!!open));
    scroll(stick);
  }
});

// ---------- Welcome ----------

function providerCard(id, info) {
  const action = id === 'claude'
    ? `<button class="btn" data-command="dualAgent.signInClaude">Sign in</button>`
    : `<button class="btn" data-command="dualAgent.setDeepSeekKey">Add key</button>`;
  const detail = id === 'claude' && info.account ? `Signed in as ${info.account}` : info.detail;
  return (
    `<div class="provider-card">` +
    `<span class="dot ${info.ready ? id : 'off'}"></span>` +
    `<div class="info"><div class="name">${NAMES[id]}</div><div class="detail" title="${escapeHtml(detail)}">${escapeHtml(capitalize(detail))}</div></div>` +
    (info.ready ? `<span class="badge ok">Ready</span>` : action) +
    `</div>`
  );
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Hello, night owl' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function renderWelcome() {
  if (started) {
    return;
  }
  const s = state;
  const anyReady = s && (s.claude.ready || s.deepseek.ready);
  const folder = s ? basename(s.cwd) : '';
  const suggestions = ['Explain this codebase', 'Review the open file', 'Find and fix a bug', 'Write tests for the open file'];
  const html =
    `<div class="welcome enter">` +
    `<img class="hero-mark" src="${logoSrc}" alt="">` +
    `<h1>${anyReady ? `${greeting()}.` : 'Welcome'}</h1>` +
    `<p class="sub">${
      !s ? 'Checking your providers…' : anyReady ? `What should we work on in <b>${escapeHtml(folder)}</b>?` : 'Connect a provider to get started.'
    }</p>` +
    (s ? `<div class="providers">${providerCard('claude', s.claude)}${providerCard('deepseek', s.deepseek)}</div>` : '') +
    (anyReady
      ? `<div class="suggestions">${suggestions.map((t) => `<button class="suggestion">${escapeHtml(t)}</button>`).join('')}</div>`
      : '') +
    `</div>`;
  // State arrives on every cursor move; only redraw (and replay the entrance) when something shows differently.
  if (html === welcomeHtml) {
    return;
  }
  welcomeHtml = html;
  log.innerHTML = html;
  log.querySelectorAll('.suggestion').forEach((b) =>
    b.addEventListener('click', () => {
      promptBox.value = b.textContent || '';
      autosize();
      promptBox.focus();
    }),
  );
}

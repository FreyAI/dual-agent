// @ts-check
/** The pills and their menus: model, effort, permissions, theme, history; the top bar's state. */
// ---------- Pills and menus ----------

const THEMES = [
  { value: 'midnight', label: 'Midnight', desc: 'Sky and indigo.' },
  { value: 'oled', label: 'OLED Black', desc: 'True black, same accents.' },
  { value: 'graphite', label: 'Graphite', desc: 'Quiet neutral grays. The default.' },
  { value: 'nord', label: 'Nord', desc: 'Cool arctic blues.' },
  { value: 'ocean', label: 'Ocean', desc: 'Deep teal and cyan.' },
  { value: 'forest', label: 'Forest', desc: 'Pine greens.' },
  { value: 'aurora', label: 'Aurora', desc: 'Violet and pink.' },
  { value: 'ember', label: 'Ember', desc: 'Warm orange and rose.' },
];

function applyTheme(theme) {
  document.documentElement.dataset.theme = THEMES.some((t) => t.value === theme) ? theme : 'graphite';
}

const PERMISSIONS = {
  default: { label: 'Ask first', short: 'Ask', desc: 'Ask before every edit and command.' },
  acceptEdits: { label: 'Auto-edit', short: 'Auto-edit', desc: 'Create and edit files without asking; ask before commands.' },
  bypassPermissions: { label: 'Bypass all', short: 'Bypass', desc: 'Never ask. Edits and commands run freely.', danger: true },
  plan: { label: 'Plan only', short: 'Plan', desc: 'Read and plan; no edits or commands.' },
};

const BUILD_MODES = {
  hybrid: { label: 'Hybrid', desc: 'Decide per part: reuse open-source code or write it.' },
  reuse: { label: 'Reuse', desc: 'Look for established open-source code first.' },
  craft: { label: 'Craft', desc: 'Write everything from scratch.' },
};

function effortOptions() {
  const ds = state?.next === 'deepseek';
  return {
    flash: {
      label: ds ? 'DeepSeek Flash' : 'Fast',
      desc: ds ? 'deepseek-flash, no extended thinking. Quick and cheap.' : 'Low effort, quick answers.',
    },
    thinking: {
      label: ds ? 'DeepSeek Thinking' : 'Thinking',
      desc: ds ? 'deepseek-v4-pro with thinking on. Best for harder tasks.' : 'High effort, reasons before answering.',
    },
  };
}

/**
 * A menu is one or more sections, each a list of choices that sends its own
 * message (or calls its `run`); sections are separated by a divider.
 * @typedef {{ value: string, label: string, desc?: string, dot?: string, swatch?: string, danger?: boolean }} MenuItem
 * @typedef {{ title?: string, current?: any, message?: string, key?: string, run?: (value: string) => void, items: MenuItem[] }} MenuSection
 * @param {string} kind
 * @returns {MenuSection[]}
 */
function menuSpec(kind) {
  if (kind === 'model') {
    const opts = effortOptions();
    return [
      {
        title: 'Model',
        current: state?.mode,
        message: 'setMode',
        key: 'mode',
        items: [
          { value: 'auto', label: 'Auto', desc: 'Primary provider; switches when it fails.', dot: 'auto' },
          { value: 'claude', label: 'Claude', desc: capitalize(state?.claude.detail ?? ''), dot: state?.claude.ready ? 'claude' : 'off' },
          { value: 'deepseek', label: 'DeepSeek', desc: capitalize(state?.deepseek.detail ?? ''), dot: state?.deepseek.ready ? 'deepseek' : 'off' },
        ],
      },
      {
        title: 'Effort',
        current: state?.effort,
        message: 'setEffort',
        key: 'effort',
        items: Object.entries(opts).map(([value, o]) => ({ value, ...o })),
      },
      {
        title: 'Build (this project)',
        current: state?.buildMode,
        message: 'setBuildMode',
        key: 'mode',
        items: Object.entries(BUILD_MODES).map(([value, o]) => ({ value, ...o })),
      },
    ];
  }
  if (kind === 'history') {
    const items = savedChats.map((c) => ({
      value: c.id,
      label: c.title,
      desc: `${timeAgo(c.updatedAt)} · ${c.messages} message${c.messages === 1 ? '' : 's'}`,
    }));
    /** @type {MenuSection[]} */
    const sections = [{ title: items.length ? 'Chats in this repo' : 'No saved chats in this repo yet', current: currentChat, message: 'openChat', key: 'id', items }];
    if (items.length) {
      sections.push({ items: [{ value: '__clear__', label: 'Clear history', desc: "Delete this repo's saved chats.", danger: true }] });
    }
    return sections;
  }
  if (kind === 'tune') {
    return [
      {
        title: 'Remote Control',
        run: () => vscode.postMessage({ type: 'command', command: 'dualAgent.startRemoteControl' }),
        items: [{ value: 'remote', label: 'Phone (Claude app)', desc: REMOTE_TITLE[remoteState], dot: `remote-${remoteState}` }],
      },
      {
        title: 'Usage',
        run: openUsageTab,
        items: [
          { value: 'cost', label: 'Cost alerts and limits', desc: 'Spend limit, daily budget and per-model limits.' },
          { value: 'split', label: 'Split between Claude and DeepSeek', desc: "Each provider's share of the day's work in this repo." },
        ],
      },
    ];
  }
  if (kind === 'theme') {
    return [{ title: 'Theme', current: state?.theme ?? 'graphite', message: 'setTheme', key: 'theme', items: THEMES.map((t) => ({ ...t, swatch: t.value })) }];
  }
  return [
    {
      title: 'Permissions',
      current: state?.permissionMode,
      message: 'setPermissionMode',
      key: 'mode',
      items: Object.entries(PERMISSIONS).map(([value, o]) => ({ value, ...o })),
    },
  ];
}

/** @type {HTMLElement | null} */
let menuAnchor = null;

function openMenu(anchor) {
  if (menuAnchor === anchor) {
    closeMenu();
    return;
  }
  closeMenu();
  const kind = anchor.getAttribute('data-menu');
  const sections = menuSpec(kind);
  menu.classList.toggle('theme-menu', kind === 'theme');
  menu.classList.toggle('history-menu', kind === 'history');
  menu.innerHTML = sections
    .map(
      (sec, si) =>
        (si ? '<div class="menu-divider" role="separator"></div>' : '') +
        (sec.title ? `<div class="menu-title">${escapeHtml(sec.title)}</div>` : '') +
        sec.items
          .map(
            (it) =>
              `<button class="menu-item${it.value === sec.current ? ' selected' : ''}${it.danger ? ' danger' : ''}" role="menuitemradio" data-section="${si}" data-value="${escapeHtml(it.value)}">` +
              (it.dot ? `<span class="dot ${it.dot}"></span>` : '') +
              (it.swatch ? `<span class="swatch t-${it.swatch}"></span>` : '') +
              `<span class="text"><div class="label">${escapeHtml(it.label)}</div><div class="desc">${escapeHtml(it.desc)}</div></span>` +
              `<span class="check">✓</span></button>`,
          )
          .join(''),
    )
    .join('');
  menu.hidden = false;
  menuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(10, Math.min(r.left, window.innerWidth - width - 10))}px`;
  // Composer pills open their menus upward; top-bar menus open downward.
  if (r.top < window.innerHeight / 2) {
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.bottom = 'auto';
  } else {
    menu.style.bottom = `${window.innerHeight - r.top + 6}px`;
    menu.style.top = 'auto';
  }
  menu.querySelectorAll('.menu-item').forEach((item) => {
    const value = item.getAttribute('data-value');
    const sec = sections[Number(item.getAttribute('data-section'))];
    item.addEventListener('click', () => {
      if (kind === 'history' && value === '__clear__') {
        vscode.postMessage({ type: 'clearHistory' });
        closeMenu();
        return;
      }
      if (sec.run) {
        closeMenu();
        sec.run(value);
        return;
      }
      vscode.postMessage({ type: sec.message, [sec.key]: value });
      if (kind === 'theme' && state) {
        // Apply now rather than wait for the settings round trip.
        state.theme = value;
      }
      closeMenu();
      promptBox.focus();
    });
    if (kind === 'theme') {
      // Hovering previews the theme; closing without choosing puts it back.
      item.addEventListener('mouseenter', () => applyTheme(value));
      item.addEventListener('focus', () => applyTheme(value));
    }
  });
  /** @type {HTMLElement | null} */ (menu.querySelector('.selected') || menu.querySelector('.menu-item'))?.focus();
}

function closeMenu() {
  if (menuAnchor?.getAttribute('data-menu') === 'theme') {
    applyTheme(state?.theme);
  }
  menu.hidden = true;
  menuAnchor?.setAttribute('aria-expanded', 'false');
  menuAnchor = null;
}

document.querySelectorAll('[data-menu]').forEach((pill) => pill.addEventListener('click', () => openMenu(/** @type {HTMLElement} */ (pill))));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) {
    closeMenu();
    promptBox.focus();
  } else if (e.key === 'Escape' && agentsOpen) {
    setAgentsOpen(false);
    promptBox.focus();
  } else if (e.key === 'Escape' && usageOpen) {
    setUsageOpen(false);
    promptBox.focus();
  }
});
document.addEventListener('mousedown', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (!menu.hidden && !menu.contains(target) && !target.closest('[data-menu]')) {
    closeMenu();
  }
  // The agents and usage panels close on a click anywhere else, as menus do.
  if (agentsOpen && !target.closest('#agentsPanel, #agentsPill')) {
    setAgentsOpen(false);
  }
  if (usageOpen && !target.closest('#usagePanel, #usage')) {
    setUsageOpen(false);
  }
});
window.addEventListener('blur', closeMenu);

document.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const command = target.closest('[data-command]')?.getAttribute('data-command');
  if (command) {
    e.preventDefault();
    vscode.postMessage({ type: 'command', command });
    return;
  }
  const open = target.closest('[data-open]');
  if (open) {
    vscode.postMessage({ type: 'openFile', path: open.getAttribute('data-open'), line: Number(open.getAttribute('data-line')) || undefined });
  }
});

function renderState() {
  const s = state;
  if (menuAnchor?.getAttribute('data-menu') !== 'theme') {
    applyTheme(s.theme);
  }
  const next = s.next;
  const nextInfo = s[next];

  // Top bar: the model pill (provider and effort) and whether it is ready.
  const effortLabel = effortOptions()[s.effort].label;
  const effortShort = effortName(next, s.effort);
  const ready = s.busy ? 'Working…' : nextInfo.ready ? 'Ready' : 'Not set up';
  $('liveDot').className = `live-dot ${s.busy ? 'busy' : nextInfo.ready ? 'ready' : 'warn'}`;
  $('liveDot').title = ready;
  $('providerDot').className = `dot ${nextInfo.ready ? next : 'off'}`;
  const build = s.buildMode && s.buildMode !== 'hybrid' ? ` · ${BUILD_MODES[s.buildMode]?.label ?? s.buildMode}` : '';
  $('modelLabel').innerHTML = `${s.mode === 'auto' ? '<span class="auto-prefix">Auto · </span>' : ''}${NAMES[next]} · ${effortShort}${build}`;
  $('modelPill').title =
    `Model: ${s.mode === 'auto' ? `Auto (now ${NAMES[next]})` : NAMES[next]}${s.model ? ` · ${s.model}` : ''}\n` +
    `Effort: ${effortLabel}\n${capitalize(nextInfo.detail)} · ${ready}` +
    (s.mode === 'auto' && s.split !== null && s.split !== undefined ? `\nSplit: Claude ${s.split}% · DeepSeek ${100 - s.split}%` : '') +
    (s.stint ? `\n${s.stint.size ? `${NAMES[s.stint.provider]}'s stint: ${formatTokens(s.stint.used)} of ${formatTokens(s.stint.size)} tokens` : `${NAMES[s.stint.provider]} only`}` : '');

  const perm = PERMISSIONS[s.permissionMode] ?? PERMISSIONS.default;
  $('permLabel').textContent = perm.short;
  $('permPill').className = `pill ${s.permissionMode}`;
  $('permPill').title = `Permissions: ${perm.label}. ${perm.desc}`;

  setBusy(s.busy);
  renderChips();
  renderWelcome();
  if (usageOpen && usageScope === 'split' && s.split !== drawnSplit) {
    renderUsagePanel();
  }
}

/**
 * New tokens and their cost, not every token: cache reads re-send what was
 * already sent and were 95% of a chat's count (2026-10-21), so the old total
 * followed re-reads, not money.
 */
function renderUsage(u) {
  const total = u.input + u.output;
  const fresh = u.fresh ?? total;
  const estimate = u.estimate ?? 0;
  $('usageLabel').textContent = formatTokens(fresh) + (u.showCost && estimate > 0 ? ` · ${money(estimate)}` : '');
  $('usage').classList.toggle('high', u.context > 150_000);
  $('usage').title =
    `New tokens this chat: ${fresh.toLocaleString()} (uncached input, cache writes, output)\n` +
    (u.cacheRead ? `Cache re-reads: ${u.cacheRead.toLocaleString()} (${Math.round((100 * u.cacheRead) / Math.max(total, 1))}% of all ${total.toLocaleString()} tokens, billed at 5-10% of input)\n` : '') +
    (u.burn ? `Last 10 minutes: ${formatTokens(u.burn.tokens)} new tokens · ${money(u.burn.cost)}\n` : '') +
    `Context now: ${u.context.toLocaleString()}` +
    (estimate > 0 ? `\nAt API prices: ${money(estimate)}` : '') +
    (u.cost > 0 ? ` · billed per token: ${money(u.cost)}` : '');
}

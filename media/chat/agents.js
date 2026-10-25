// @ts-check
/** The agents pill, the agents at work above the composer, the agents panel and its warnings. */
// ---------- Agents ----------

/** The latest agents snapshot: { agents (one per run), plan, tokens }. */
let agents = null;
let agentsOpen = false;
/** Warnings kept out of the conversation (retries, network trouble), newest last; a repeat bumps its count. */
let warnings = [];
let warningsOpen = false;
/** Ticks elapsed times while any agent works. @type {ReturnType<typeof setInterval> | undefined} */
let agentsClock;
/** Run cards showing all their steps. */
const expandedAgents = new Set();
/** The agent whose pill is picked; null shows everyone's work. */
let pickedAgent = null;
const STATUS_LABEL = { running: 'Running', blocked: 'Waiting for you', warning: 'Needs a look', failed: 'Failed', done: 'Done', stopped: 'Stopped', idle: 'Idle' };
/** Still working, most urgent first. */
const ACTIVE = ['blocked', 'warning', 'running'];
const STATUS_ICONS = {
  warning: ICON('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  blocked: ICON('<path d="M18 11V6a2 2 0 0 0-4 0v4M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>'),
  failed: ICON('<path d="M18 6 6 18M6 6l12 12"/>'),
  done: ICON('<path d="M20 6 9 17l-5-5"/>'),
  stopped: ICON('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
};

function statusIcon(status) {
  return `<span class="status-icon ${escapeHtml(status)}" title="${STATUS_LABEL[status] ?? escapeHtml(status)}">${STATUS_ICONS[status] ?? ''}</span>`;
}

/** The name the main agent gave a helper, else its type made readable. */
function agentName(a) {
  if (a.id === 'main') {
    return 'Main agent';
  }
  if (a.label) {
    return a.label;
  }
  const name = String(a.name || 'agent').replace(/[-_]+/g, ' ');
  return name[0].toUpperCase() + name.slice(1);
}

function duration(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function elapsed(a) {
  return duration((a.endedAt ?? Date.now()) - a.startedAt);
}

function hasWork(a) {
  return a.steps.length || a.tokens || ACTIVE.includes(a.status);
}

/** Why a run needs the user's attention, if it does. */
function runNote(a) {
  if (a.status === 'blocked') {
    return 'Waiting for you to answer';
  }
  if (a.status === 'warning') {
    return a.failedTool ? `${toolLabel(a.failedTool)} failed` : `No activity for ${duration(Date.now() - (a.lastActivityAt ?? a.startedAt))}`;
  }
  return '';
}

/** Runs grouped into agents by name (else type), newest run first; also works for chats saved before names. */
function agentGroups() {
  const groups = new Map();
  for (const a of agents?.agents ?? []) {
    if (a.id === 'main' && !hasWork(a) && !agents.plan?.length) {
      continue;
    }
    const key = a.id === 'main' ? 'main' : a.label || a.name || 'agent';
    if (!groups.has(key)) {
      groups.set(key, { key, name: agentName(a), runs: [] });
    }
    groups.get(key).runs.unshift(a);
  }
  for (const g of groups.values()) {
    const latest = g.runs[0];
    const active = g.runs.find((r) => ACTIVE.includes(r.status));
    g.status = ACTIVE.find((st) => g.runs.some((r) => r.status === st)) ?? latest.status;
    g.todos = g.key === 'main' ? agents.plan ?? [] : latest.todos ?? [];
    const doing = g.todos.find((t) => t.status === 'in_progress');
    const lastStep = active?.steps.at(-1);
    g.current =
      (doing && (doing.activeForm || doing.content)) ||
      active?.description ||
      (lastStep ? `${toolLabel(lastStep.tool)} ${relative(lastStep.detail)}` : '') ||
      latest.description;
  }
  return [...groups.values()];
}

function renderAgentsPill() {
  const list = agents?.agents ?? [];
  const groups = agentGroups();
  const count = (st) => list.filter((a) => a.status === st).length;
  // Working agents only, so the count goes down as each one stops.
  const running = count('running') + count('warning') + count('blocked');
  const failed = groups.filter((g) => g.status === 'failed').length;
  const trouble = [
    count('blocked') ? `${count('blocked')} blocked` : '',
    count('warning') ? `${count('warning')} warning${count('warning') === 1 ? '' : 's'}` : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean);
  const pill = $('agentsPill');
  // An unfinished plan shows its progress, so work between replies isn't hidden behind "0 running".
  const plan = agents?.plan ?? [];
  const planDone = plan.filter((p) => p.status === 'completed').length;
  const progress = plan.length && planDone < plan.length ? `Plan ${planDone}/${plan.length}` : '';
  // The most urgent trouble only, so the pill stays short; the tooltip lists it all.
  $('agentsLabel').textContent = [progress, `${running} running`, ...trouble.slice(0, 1)].filter(Boolean).join(' · ');
  // The warnings count is its own badge: the label shrinks first in a narrow bar.
  let badge = /** @type {HTMLElement | null} */ (pill.querySelector('.warn-badge'));
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'warn-badge';
    pill.appendChild(badge);
  }
  badge.textContent = `⚠ ${warnings.length}`;
  badge.hidden = !warnings.length;
  if (warnings.length) {
    trouble.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'} (open to see them)`);
  }
  pill.classList.toggle('running', running > 0);
  pill.dataset.alert = count('blocked') ? 'blocked' : count('warning') || warnings.length ? 'warning' : failed ? 'failed' : '';
  pill.title =
    `${progress ? `${progress} done · ` : ''}${running} running · ${groups.length || 1} agent${groups.length === 1 ? '' : 's'} in this chat${trouble.length ? ` · ${trouble.join(' · ')}` : ''} · ${formatTokens(agents?.tokens ?? 0)} new tokens\n` +
    `Click to ${agentsOpen ? 'close' : 'see the agents, their tasks and the plan'}.`;
}

/** Inline markdown for short single-line agent text (todo items, the current task): HTML escapes, collapses headings/list bullets and newlines to spaces, then renders `**`, `*`, `` ` ``, `~~` and links. */
function inlineMd(s) {
  return inline(
    escapeHtml(s)
      .split('\n')
      .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, ''))
      .join(' '),
  );
}

function agentPill(g) {
  const title = `${g.name} · ${STATUS_LABEL[g.status] ?? g.status}${g.current ? ` · ${g.current}` : ''}\n${g.runs.length} task${g.runs.length === 1 ? '' : 's'}; click to see them`;
  return (
    `<button class="agent-pill ${escapeHtml(g.status)}" data-pick-agent="${escapeHtml(g.key)}" aria-pressed="${g.key === pickedAgent}" title="${escapeHtml(title)}">` +
    `<span class="apl-name">${escapeHtml(g.name)}</span>` +
    (g.runs.length > 1 ? `<span class="apl-count">${g.runs.length}</span>` : '') +
    (g.status === 'blocked' ? `<span class="apl-note">waiting for you</span>` : '') +
    (g.current ? `<span class="apl-task">${inlineMd(g.current)}</span>` : '') +
    statusIcon(g.status) +
    `</button>`
  );
}

/** The model an agent runs on, coloured by who serves it. */
function modelTag(model) {
  return model ? `<span class="ac-model ${/deepseek/i.test(model) ? 'deepseek' : 'claude'}">${escapeHtml(model)}</span>` : '';
}

/** Elapsed times in the agents panel tick while anything works. */
function tickAgents() {
  const working = (agents?.agents ?? []).some((a) => ACTIVE.includes(a.status));
  if (working && !agentsClock) {
    agentsClock = setInterval(() => {
      for (const a of agents?.agents ?? []) {
        if (ACTIVE.includes(a.status)) {
          document.querySelectorAll(`[data-elapsed="${CSS.escape(a.id)}"]`).forEach((t) => (t.textContent = elapsed(a)));
        }
      }
    }, 1000);
  } else if (!working) {
    clearInterval(agentsClock);
    agentsClock = undefined;
  }
}

/** A to-do list with each item's status and a progress bar. */
function todosSection(label, todos) {
  if (!todos.length) {
    return '';
  }
  const done = todos.filter((p) => p.status === 'completed').length;
  return (
    `<div class="ap-section"><div class="ap-label">${label} <span>${done}/${todos.length}</span></div>` +
    `<div class="ap-progress"><span id="planBar" data-pct="${(100 * done) / todos.length}"></span></div><ol class="plan">` +
    todos
      .map(
        (p) =>
          `<li class="plan-item ${escapeHtml(p.status)}"><span class="pi-mark" aria-hidden="true"></span>` +
          `<span class="pi-text">${inlineMd(p.status === 'in_progress' && p.activeForm ? p.activeForm : p.content)}</span></li>`,
      )
      .join('') +
    `</ol></div>`
  );
}

function runCard(a) {
  const open = expandedAgents.has(a.id);
  const steps = open ? a.steps : a.steps.slice(-4);
  const hidden = a.earlierSteps + a.steps.length - steps.length;
  const note = runNote(a);
  return (
    `<div class="agent-card ${escapeHtml(a.status)}${a.depth > 1 ? ' nested' : ''}" data-agent="${escapeHtml(a.id)}">` +
    `<button class="ac-head" data-toggle-agent="${escapeHtml(a.id)}" aria-expanded="${open}">` +
    `<span class="ac-name">${escapeHtml(agentName(a))}</span>` +
    modelTag(a.model) +
    `<span class="ac-stats">${formatTokens(a.tokens)} tok · ${a.toolUses} step${a.toolUses === 1 ? '' : 's'} · <span data-elapsed="${escapeHtml(a.id)}">${elapsed(a)}</span></span>` +
    statusIcon(a.status) +
    `</button>` +
    (a.taskId && ACTIVE.includes(a.status)
      ? `<button class="ac-stop" data-stop-agent="${escapeHtml(a.taskId)}" title="Stop this agent; the others keep working">Stop</button>`
      : '') +
    (note ? `<div class="ac-note ${escapeHtml(a.status)}">${escapeHtml(note)}</div>` : '') +
    (a.description ? `<div class="ac-desc">${renderMarkdown(a.description)}</div>` : '') +
    (a.summary ? `<div class="ac-summary">${renderMarkdown(a.summary)}</div>` : '') +
    (steps.length
      ? `<ul class="ac-steps">${steps
          .map((st) => `<li>${toolIcon(st.tool)}<span class="st-tool">${escapeHtml(toolLabel(st.tool))}</span><span class="st-detail">${escapeHtml(relative(st.detail))}</span></li>`)
          .join('')}</ul>`
      : '') +
    (hidden > 0 ? `<button class="ac-more" data-toggle-agent="${escapeHtml(a.id)}">+${hidden} earlier step${hidden === 1 ? '' : 's'}</button>` : '') +
    (open && a.steps.length > 4 ? `<button class="ac-more" data-toggle-agent="${escapeHtml(a.id)}">Show fewer</button>` : '') +
    `</div>`
  );
}

function renderAgentsPanel() {
  const panel = $('agentsPanel');
  $('agentsPill').setAttribute('aria-expanded', String(agentsOpen));
  panel.hidden = !agentsOpen;
  if (!agentsOpen) {
    return;
  }
  const list = agents?.agents ?? [];
  const groups = agentGroups();
  const picked = groups.find((g) => g.key === pickedAgent);
  pickedAgent = picked?.key ?? null;
  const count = (st) => list.filter((a) => a.status === st).length;
  const meta = [
    `${count('running')} running`,
    count('blocked') ? `${count('blocked')} waiting for you` : '',
    count('warning') ? `${count('warning')} warning` : '',
    count('done') ? `${count('done')} done` : '',
    count('failed') ? `${count('failed')} failed` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  let html =
    `<div class="ap-head"><span class="ap-title">Agents</span><span class="ap-meta">${meta}</span>` +
    `<span class="ap-tokens" title="New tokens used by all agents in this chat (uncached input, cache writes, output), as in the usage pill; cache re-reads aren't counted">${formatTokens(agents?.tokens ?? 0)} new tokens</span>` +
    `<button class="icon-btn small" data-close-agents title="Close" aria-label="Close agents">×</button></div>`;

  if (!list.some(hasWork)) {
    html += todosSection('Plan', agents?.plan ?? []);
    html += `<div class="ap-empty">No agents have run in this chat yet. When the agent works, each agent, its tasks, the plan and the tokens used show here.</div>`;
  } else if (picked) {
    html +=
      `<div class="agent-pills" role="group" aria-label="Agents">${groups.map(agentPill).join('')}</div>` +
      todosSection(picked.key === 'main' ? 'Plan' : 'To-do', picked.todos) +
      `<div class="ap-section"><div class="ap-label">Tasks <span>${picked.runs.length}</span></div>${picked.runs.map(runCard).join('')}</div>`;
  } else {
    html +=
      `<div class="agent-pills" role="group" aria-label="Agents">${groups.map(agentPill).join('')}</div>` +
      todosSection('Plan', agents?.plan ?? []) +
      `<div class="ap-section"><div class="ap-label">Work</div>${list.filter((a) => a.id !== 'main' || hasWork(a)).map(runCard).join('')}</div>`;
  }
  panel.innerHTML = html + warningsSection();
  const bar = document.getElementById('planBar');
  if (bar) {
    bar.style.width = `${bar.dataset.pct}%`;
  }
}

function addWarning(text) {
  const last = warnings.find((w) => w.text === text);
  if (last) {
    last.count++;
    last.at = Date.now();
  } else {
    warnings.push({ text, at: Date.now(), count: 1 });
  }
  renderAgentsPill();
  renderAgentsPanel();
}

/** The chat's warnings, collapsed at the bottom of the agents panel. */
function warningsSection() {
  if (!warnings.length) {
    return '';
  }
  const rows = [...warnings]
    .sort((a, b) => b.at - a.at)
    .map(
      (w) =>
        `<li><span class="aw-time">${new Date(w.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` +
        `<span class="aw-text">${escapeHtml(w.text)}</span>${w.count > 1 ? `<span class="aw-count">×${w.count}</span>` : ''}</li>`,
    )
    .join('');
  return `<details class="ap-warnings"${warningsOpen ? ' open' : ''}><summary>Warnings <span>${warnings.length}</span></summary><ul>${rows}</ul></details>`;
}

function setAgentsOpen(open) {
  if (open && usageOpen) {
    setUsageOpen(false);
  }
  agentsOpen = open;
  renderAgentsPill();
  renderAgentsPanel();
}

$('agentsPill').addEventListener('click', () => setAgentsOpen(!agentsOpen));
// The panel redraws often: remember whether the warnings list was open.
$('agentsPanel').addEventListener('toggle', (e) => {
  if (/** @type {HTMLElement} */ (e.target).matches('.ap-warnings')) {
    warningsOpen = /** @type {HTMLDetailsElement} */ (e.target).open;
  }
}, true);
$('agentsPanel').addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.closest('[data-close-agents]')) {
    setAgentsOpen(false);
    return;
  }
  const taskId = target.closest('[data-stop-agent]')?.getAttribute('data-stop-agent');
  if (taskId) {
    vscode.postMessage({ type: 'stopAgent', taskId });
    return;
  }
  const pick = target.closest('[data-pick-agent]')?.getAttribute('data-pick-agent');
  if (pick) {
    pickedAgent = pick === pickedAgent ? null : pick;
    renderAgentsPanel();
    return;
  }
  const id = target.closest('[data-toggle-agent]')?.getAttribute('data-toggle-agent');
  if (id) {
    if (expandedAgents.has(id)) {
      expandedAgents.delete(id);
    } else {
      expandedAgents.add(id);
    }
    renderAgentsPanel();
  }
});

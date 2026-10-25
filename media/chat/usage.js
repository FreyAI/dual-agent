// @ts-check
/** The usage pill and panel: tokens and cost, the delegation split and cost limits. */
// ---------- Token usage ----------

let usageOpen = false;
let usageScope = 'chat';
/** The latest report: { scope, summary, peakNow }. */
let usageReport = null;
const SCOPES = [
  ['chat', 'This chat'],
  ['repo', 'This repo'],
  ['today', 'Today'],
  ['all', 'All time'],
  ['split', 'Split'],
  ['cost', 'Cost'],
];
/** Tabs with their own content instead of a scope's totals. */
const OWN_TABS = ['split', 'cost'];
const SCOPE_PHRASE = { chat: 'in this chat', repo: 'in this repo', today: 'today', all: 'yet' };
/** The Split tab compares the target with today's tokens; the Cost tab's spend comes with any report. */
const reportScope = (tab) => (OWN_TABS.includes(tab) ? 'today' : tab);

const money = (n) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const pct = (x) => `${Math.round(x * 100)}%`;

function setUsageOpen(open) {
  usageOpen = open;
  $('usage').setAttribute('aria-expanded', String(open));
  if (open && agentsOpen) {
    setAgentsOpen(false);
  }
  vscode.postMessage({ type: 'usageReport', scope: open ? reportScope(usageScope) : undefined });
  renderUsagePanel();
}

/** Opens the panel on one tab: the tune menu's shortcuts to Cost and Split. */
function openUsageTab(tab) {
  usageScope = tab;
  setUsageOpen(true);
}

// ---------- Delegation split ----------

/** The last split drawn, and whether the slider is held (a redraw mid-drag would drop it). */
let drawnSplit;
let splitDragging = false;
let redrawPending = false;
const SPLIT_PRESETS = [
  [0, 'DeepSeek only'],
  [30, '30 / 70'],
  [50, 'Default 50 / 50'],
  [70, '70 / 30'],
  [100, 'Claude only'],
];
/** The slider's thumb is 8px wide; the split line sits under its centre. */
const splitAt = (pct) => `calc((100% - 8px) * ${pct / 100} + 4px)`;

function providerTokens(r) {
  const out = { claude: 0, deepseek: 0 };
  for (const m of r?.models ?? []) {
    out[m.provider] = (out[m.provider] ?? 0) + m.tokens;
  }
  return out;
}

/** Whose stint it is and how far it has run, from the last routing decision. */
function renderStint(s) {
  const name = NAMES[s.provider];
  if (!s.size) {
    return `<div class="split-actual"><div class="split-actual-head"><span>Now</span><span>${name} only</span></div></div>`;
  }
  const next = NAMES[s.provider === 'claude' ? 'deepseek' : 'claude'];
  return (
    `<div class="split-actual"><div class="split-actual-head"><span>Now: ${name}'s stint</span><span>${formatTokens(s.used)} of ${formatTokens(s.size)} · then ${next}</span></div>` +
    `<div class="split-actual-bar empty"><span class="${s.provider}" data-share="${Math.min(1, s.used / s.size)}"></span></div></div>`
  );
}

function renderSplit(r) {
  const target = state?.split;
  const on = target !== null && target !== undefined;
  const pct = on ? target : 50;
  // The split is per repo: the stint carries this repo's tokens today.
  const today = state?.stint?.today ?? providerTokens(r);
  const total = today.claude + today.deepseek;
  const actual = total ? Math.round((100 * today.claude) / total) : null;
  const manual = state && state.mode !== 'auto';
  return (
    `<div class="split${on ? '' : ' off'}">` +
    `<div class="split-top"><div><div class="split-title">Delegation split</div>` +
    `<div class="split-sub">${on ? "Auto mode's target share of this repo's tokens, saved for this repo" : 'Off: auto mode follows the Claude role setting'}</div></div>` +
    `<button class="switch" role="switch" aria-checked="${on}" data-split-toggle title="${on ? 'Turn the split off' : 'Turn the split on'}"><span></span></button></div>` +
    `<div class="split-bar">` +
    `<div class="split-seg claude"><span class="split-name">Claude</span><b class="split-pct" data-split-claude>${pct}%</b></div>` +
    `<div class="split-seg deepseek"><b class="split-pct" data-split-deepseek>${100 - pct}%</b><span class="split-name">DeepSeek</span></div>` +
    `<input class="split-range" type="range" min="0" max="100" step="5" value="${pct}" aria-label="Claude's share of tokens"${on ? '' : ' disabled'}>` +
    `</div>` +
    `<div class="split-presets">${SPLIT_PRESETS.map(([v, label]) => `<button class="scope-pill${on && v === pct ? ' on' : ''}" data-split-preset="${v}">${label}</button>`).join('')}</div>` +
    (on && state?.stint ? renderStint(state.stint) : '') +
    `<div class="split-actual"><div class="split-actual-head"><span>${state?.stint ? 'This repo today' : 'Today so far'}</span><span>${
      actual === null ? 'nothing used yet' : `Claude ${actual}% · DeepSeek ${100 - actual}% · ${formatTokens(total)} tokens`
    }</span></div>` +
    `<div class="split-actual-bar${actual === null ? ' empty' : ''}"><span class="claude" data-split-actual="${actual ?? 0}"></span>${on ? '<i class="split-mark" title="Target"></i>' : ''}</div></div>` +
    `<div class="usage-notes">` +
    (manual ? `<div class="split-warn">Applies in Auto mode; ${NAMES[state.mode]} is picked by hand now.</div>` : '') +
    `<div>The two take turns in stints of half their share of this repo's usual day (at 70/30: Claude 35%, then DeepSeek 15%, twice a day), so the model changes only when a stint ends. A follow-up like "go ahead" keeps the task's model.</div>` +
    `<div>In DeepSeek's stint quick edits use Flash. Stuck tasks still escalate to Claude${on && pct === 0 ? ' (not at 0%)' : ''}, and Claude backs off when its quota runs low.</div>` +
    `</div></div>`
  );
}

/** Moves the bar to a share without redrawing the panel, so dragging stays smooth. */
function placeSplit(pct) {
  const panel = $('usagePanel');
  const claude = /** @type {HTMLElement | null} */ (panel.querySelector('.split-seg.claude'));
  if (!claude) {
    return;
  }
  claude.style.width = splitAt(pct);
  claude.classList.toggle('narrow', pct < 22);
  /** @type {HTMLElement} */ (panel.querySelector('.split-seg.deepseek')).classList.toggle('narrow', pct > 78);
  /** @type {HTMLElement} */ (panel.querySelector('[data-split-claude]')).textContent = `${pct}%`;
  /** @type {HTMLElement} */ (panel.querySelector('[data-split-deepseek]')).textContent = `${100 - pct}%`;
  const mark = /** @type {HTMLElement | null} */ (panel.querySelector('.split-mark'));
  if (mark) {
    mark.style.left = `${pct}%`;
  }
}

function saveSplit(claude) {
  if (state) {
    state.split = claude;
  }
  drawnSplit = claude;
  vscode.postMessage({ type: 'setSplit', claude });
  renderUsagePanel();
}

/** Agents beyond the first five share the last colour. */
const AGENT_COLORS = 6;
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Tokens per 10 minutes as stacked bars by agent, then each agent's totals. */
function renderTimeline(t) {
  const top = t.agents.slice(0, AGENT_COLORS - 1).map((a) => a.name);
  const colorOf = (name) => (top.includes(name) ? top.indexOf(name) : AGENT_COLORS - 1);
  const W = 300;
  const H = 84;
  const max = Math.max(1, ...t.buckets.map((b) => b.tokens));
  const bw = W / t.buckets.length;
  const bars = t.buckets
    .map((b, i) => {
      let y = H;
      const parts = Object.entries(b.byAgent)
        .sort((x, z) => colorOf(x[0]) - colorOf(z[0]))
        .map(([name, tokens]) => {
          const h = (tokens / max) * H;
          y -= h;
          return `<rect class="tl-c${colorOf(name)}" x="${(i * bw + 0.5).toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0.6, bw - 1).toFixed(2)}" height="${h.toFixed(2)}"/>`;
        })
        .join('');
      const who = Object.entries(b.byAgent)
        .sort((x, z) => z[1] - x[1])
        .map(([name, tokens]) => `${name} ${formatTokens(tokens)}`)
        .join(', ');
      const tip = `${clock(b.at)}–${clock(b.at + t.bucketMs)} · ${formatTokens(b.tokens)} tokens${who ? ` · ${who}` : ''}`;
      return `<g data-bucket="${i}"><title>${escapeHtml(tip)}</title><rect class="tl-hit" x="${(i * bw).toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${H}"/>${parts}</g>`;
    })
    .join('');
  const first = t.buckets[0];
  const last = t.buckets[t.buckets.length - 1];
  const totalTokens = t.agents.reduce((n, a) => n + a.tokens, 0) || 1;
  const agents = t.agents
    .map(
      (a) =>
        `<div class="agent-usage" data-agent-usage="${escapeHtml(a.name)}">` +
        `<div class="mr-head"><span class="tl-dot tl-c${colorOf(a.name)}"></span><span class="mr-name">${escapeHtml(a.name)}</span>` +
        `<span class="mr-provider">${escapeHtml(a.models.join(', '))}</span><span class="mr-share">${pct(a.tokens / totalTokens)}</span></div>` +
        `<div class="mr-bar"><span class="tl-bg${colorOf(a.name)}" data-share="${a.tokens / totalTokens}"></span></div>` +
        `<div class="mr-detail">${formatTokens(a.tokens)} tokens · ${a.calls} call${a.calls === 1 ? '' : 's'} · ${money(a.cost)} · ` +
        `${pct(a.cacheRead / Math.max(1, a.input + a.cacheRead + a.cacheWrite))} from cache</div></div>`,
    )
    .join('');
  return (
    `<div class="ap-head eff-head chart-head"><span class="ap-title">Tokens per 10 minutes</span><span class="ap-meta">peak ${formatTokens(max)}</span></div>` +
    `<svg class="usage-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Tokens per 10 minutes, by agent">${bars}</svg>` +
    `<div class="chart-axis"><span>${clock(first.at)}</span><span>${clock(last.at + t.bucketMs)}</span></div>` +
    `<div class="ap-head eff-head chart-head"><span class="ap-title">By agent</span><span class="ap-meta">${t.agents.length} agent${t.agents.length === 1 ? '' : 's'}</span></div>` +
    agents
  );
}

const seconds = (ms) => (ms === undefined || ms === null ? '–' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const turns = (n) => `${n} turn${n === 1 ? '' : 's'}`;

/** The tasks section: cost per finished task, from the lines metrics/tasks.ts makes. */
function renderTasks(lines) {
  return (
    `<div class="ap-head eff-head"><span class="ap-title">Tasks</span></div>` +
    `<div class="usage-notes">${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>`
  );
}

/** The efficiency section: speed, tokens per turn, cache, tools, and the lean-workflow comparison. */
function renderEfficiency(e) {
  const stat = (value, label) => `<div><b>${value}</b><span>${label}</span></div>`;
  const lean = e.leanComparison;
  const leanNote = lean
    ? `<div>Lean workflow on: ${formatTokens(Math.round(lean.on))} input tokens per turn (${turns(lean.onTurns)}); off: ${formatTokens(Math.round(lean.off))} (${turns(lean.offTurns)}).</div>`
    : '';
  const tools = e.tools
    .slice(0, 8)
    .map(
      (t) =>
        `<div class="tool-stat"><span class="ts-name">${escapeHtml(toolLabel(t.name))}</span>` +
        `<span>${t.calls}×</span><span>${seconds(t.avgMs)}</span><span>~${formatTokens(Math.round(t.avgOutTokens))} out</span>` +
        `<span>${pct(t.outputShare)}</span>${t.errorRate ? `<span class="ts-err">${pct(t.errorRate)} failed</span>` : '<span></span>'}</div>`,
    )
    .join('');
  return (
    `<div class="ap-head eff-head"><span class="ap-title">Efficiency</span><span class="ap-meta">${turns(e.turns)}</span></div>` +
    `<div class="usage-totals">` +
    stat(seconds(e.p50Ms), 'median reply') +
    stat(seconds(e.p50TtftMs), 'first token') +
    stat(formatTokens(Math.round(e.avgInputTokens)), 'input / turn') +
    `</div><div class="usage-totals">` +
    stat(pct(e.cacheHitRate), 'from cache') +
    stat(e.toolCallsPerTurn.toFixed(1), 'tools / turn') +
    stat(pct(e.toolOutputShare), 'is tool output') +
    `</div>` +
    (tools ? `<div class="tool-stats"><div class="tool-stat faint"><span class="ts-name">Tool</span><span>calls</span><span>avg time</span><span>avg output</span><span>share</span><span></span></div>${tools}</div>` : '') +
    `<div class="usage-notes">${leanNote}` +
    `<div>${money(e.costPerDone ?? 0)} per finished reply${e.claudeTurns ? ` · Claude answered ${e.claudeTurns} of ${e.turns} (${pct(e.claudeTurns / e.turns)})` : e.turns ? ' · no Claude' : ''}${e.unverified ? ` · ${e.unverified} unverified` : ''}${e.trimmedChars ? ` · ${formatTokens(Math.round(e.trimmedChars / 4))} tokens of tool output trimmed` : ''}</div>` +
    `<div>p95 reply ${seconds(e.p95Ms)} · ${formatTokens(Math.round(e.avgOutputTokens))} output tokens per turn · ${pct(e.toolErrorRate)} of tool calls failed</div>` +
    `<div>${e.avgModelCalls.toFixed(1)} model calls per turn · context peak ${formatTokens(Math.round(e.avgContextPeak))}` +
    `${e.retries ? ` · ${e.retries} retries` : ''}${e.fallbacks ? ` · ${e.fallbacks} provider switches` : ''}${e.compactions ? ` · ${e.compactions} compactions` : ''}` +
    `${e.stopped ? ` · ${e.stopped} stopped` : ''}${e.errors ? ` · ${e.errors} failed` : ''}</div>` +
    `<div>"Dual Agent: Export Metrics (CSV)" saves every turn for a spreadsheet.</div></div>`
  );
}

// ---------- Cost limits ----------

const COST_PRESETS = { total: [5, 10, 25, 50, 100], daily: [1, 2, 5, 10, 20] };
const MODEL_KEYS = ['claude-opus', 'claude-sonnet', 'claude-haiku', 'deepseek-v4-pro', 'deepseek-flash'];

/** Spent against a limit: a bar that turns amber at 80% and red at the limit. */
function costBar(spent, limit) {
  const share = limit > 0 ? Math.min(1, spent / limit) : 0;
  return limit > 0 ? `<div class="mr-bar"><span class="${share >= 1 ? 'over' : share >= 0.8 ? 'near' : ''}" data-share="${share}"></span></div>` : '';
}

/** One limit: what it is, an amount box, presets, and the bar. */
function costLimit(kind, title, sub, spent, limit) {
  return (
    `<div class="cost-limit">` +
    `<div class="cost-row"><div><div class="split-title">${title}</div><div class="split-sub">${sub}</div></div>` +
    `<label class="cost-input"><span>$</span><input type="number" min="0" step="0.5" placeholder="Off" value="${limit > 0 ? limit : ''}" data-cost="${kind}" aria-label="${title} in dollars"></label></div>` +
    `<div class="split-presets"><button class="scope-pill${limit > 0 ? '' : ' on'}" data-cost-preset="${kind}:0">Off</button>` +
    COST_PRESETS[kind].map((v) => `<button class="scope-pill${limit === v ? ' on' : ''}" data-cost-preset="${kind}:${v}">$${v}</button>`).join('') +
    `</div>` +
    (limit > 0 ? `${costBar(spent, limit)}<div class="mr-detail">${money(spent)} of ${money(limit)}${spent >= limit ? ' · reached' : ` · ${money(limit - spent)} left`}</div>` : '') +
    `</div>`
  );
}

function renderCost(c) {
  if (!c) {
    return `<div class="ap-empty">Loading…</div>`;
  }
  const since = c.since ? `since ${new Date(c.since).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'counting starts with the first limit';
  const known = [...new Set([...MODEL_KEYS, ...(usageReport?.summary?.models ?? []).map((m) => m.model)])];
  const models = c.models
    .map(
      (m) =>
        `<div class="model-row cost-model">` +
        `<div class="mr-head"><span class="dot ${/deepseek/i.test(m.key) ? 'deepseek' : 'claude'}"></span><span class="mr-name">${escapeHtml(m.key)}</span>` +
        `<span class="mr-share">${money(m.spent)}</span>` +
        `<label class="cost-input small"><span>$</span><input type="number" min="0" step="0.5" placeholder="No limit" value="${m.limit > 0 ? m.limit : ''}" data-cost="model" data-key="${escapeHtml(m.key)}" aria-label="Limit for ${escapeHtml(m.key)} in dollars"></label>` +
        (m.limit > 0 ? `<button class="icon-btn small" data-cost-remove="${escapeHtml(m.key)}" title="Remove this limit" aria-label="Remove the limit for ${escapeHtml(m.key)}">×</button>` : '') +
        `</div>` +
        costBar(m.spent, m.limit) +
        `</div>`,
    )
    .join('');
  return (
    `<div class="split cost">` +
    `<div class="usage-totals">` +
    `<div><b>${money(c.spent)}</b><span>${since}</span></div>` +
    `<div><b>${money(c.spentToday)}</b><span>today</span></div>` +
    `<div><b>${c.totalLimit > 0 ? money(Math.max(0, c.totalLimit - c.spent)) : '–'}</b><span>left of the limit</span></div>` +
    `</div>` +
    costLimit('total', 'Spend limit', 'All models since the last reset: the reply stops when reached', c.spent, c.totalLimit) +
    costLimit('daily', 'Daily budget', 'No new replies once today reaches it; resets at midnight', c.spentToday, c.dailyBudget) +
    `<div><div class="split-title">Per-model limits</div><div class="split-sub">A model at its limit isn't used again until a reset; another one answers</div></div>` +
    (models || `<div class="ap-empty">No per-token spend ${c.since ? 'since the reset' : 'yet'}.</div>`) +
    `<div class="cost-add"><input list="costModels" placeholder="Model, e.g. claude-opus" data-cost-new-key aria-label="Model to limit">` +
    `<datalist id="costModels">${known.map((k) => `<option value="${escapeHtml(k)}">`).join('')}</datalist>` +
    `<label class="cost-input small"><span>$</span><input type="number" min="0" step="0.5" placeholder="Limit" data-cost-new-limit aria-label="Limit in dollars"></label>` +
    `<button class="btn" data-cost-add>Add</button></div>` +
    `<div class="cost-actions"><button class="btn" data-command="dualAgent.resetCostLimits">Reset count</button>` +
    `<button class="btn" data-command="dualAgent.openSettings">All settings</button></div>` +
    `<div class="usage-notes"><div>Per-token spend only (DeepSeek, an Anthropic key): Claude on your subscription isn't counted.</div>` +
    `<div>A warning comes at 80%. Limits apply to every chat and to Remote Control, on every machine sharing the usage folder.</div></div>` +
    `</div>`
  );
}

/** The per-model limits now shown, with one changed (0 removes it). */
function modelLimits(key, limit) {
  const out = {};
  for (const m of usageReport?.costs?.models ?? []) {
    if (m.limit > 0) {
      out[m.key] = m.limit;
    }
  }
  out[key] = limit;
  return out;
}

function saveCost(kind, value, key) {
  const n = Math.max(0, Number(value) || 0);
  vscode.postMessage(kind === 'model' ? { type: 'setCostLimits', perModel: modelLimits(key, n) } : { type: 'setCostLimits', [kind]: n });
}

function renderUsagePanel() {
  const panel = $('usagePanel');
  panel.hidden = !usageOpen;
  if (!usageOpen) {
    return;
  }
  // A redraw mid-drag or mid-typing would drop it.
  const typing = /** @type {HTMLElement | null} */ (document.activeElement)?.matches('#usagePanel input:not([type=range])');
  if (splitDragging || typing) {
    redrawPending = true;
    return;
  }
  const report = usageReport && usageReport.scope === reportScope(usageScope) ? usageReport : null;
  const r = report?.summary;
  let html =
    `<div class="ap-head"><span class="ap-title">Token usage</span><span class="ap-meta"></span>` +
    `<button class="icon-btn small" data-close-usage title="Close" aria-label="Close token usage">×</button></div>` +
    `<div class="scope-pills" role="tablist">${SCOPES.map(
      ([v, label]) => `<button class="scope-pill${v === usageScope ? ' on' : ''}" role="tab" aria-selected="${v === usageScope}" data-scope="${v}">${label}</button>`,
    ).join('')}</div>`;
  if (usageScope === 'split') {
    html += renderSplit(r);
  } else if (usageScope === 'cost') {
    html += renderCost(report?.costs);
  } else if (!r) {
    html += `<div class="ap-empty">Loading…</div>`;
  } else if (!r.tokens) {
    html += `<div class="ap-empty">No tokens used ${SCOPE_PHRASE[usageScope]}.</div>`;
  } else {
    const notional = r.models.some((m) => m.notional);
    html +=
      `<div class="usage-totals">` +
      `<div><b>${formatTokens(r.tokens)}</b><span>tokens</span></div>` +
      `<div><b>${money(r.cost)}</b><span>${notional && r.billedCost < r.cost ? `est. · ${money(r.billedCost)} billed` : 'est. cost'}</span></div>` +
      `<div><b>${pct(r.hitRate)}</b><span>input from cache</span></div>` +
      `</div>` +
      (report.timeline ? renderTimeline(report.timeline) : '') +
      `<div class="ap-head eff-head chart-head"><span class="ap-title">By model</span></div>` +
      r.models
        .map(
          (m) =>
            `<div class="model-row">` +
            `<div class="mr-head"><span class="dot ${m.provider}"></span><span class="mr-name">${escapeHtml(m.model)}</span>` +
            `<span class="mr-provider">${NAMES[m.provider] ?? m.provider}</span><span class="mr-share">${pct(m.share)}</span></div>` +
            `<div class="mr-bar"><span class="${m.provider}" data-share="${m.share}"></span></div>` +
            `<div class="mr-detail">${formatTokens(m.tokens)} tokens · ${money(m.cost)}${m.notional ? '*' : ''} (${pct(m.costShare)} of cost)</div>` +
            `<div class="mr-detail faint">input ${formatTokens(m.input)} · cached ${formatTokens(m.cacheRead)}` +
            `${m.cacheWrite ? ` · cache writes ${formatTokens(m.cacheWrite)}` : ''} · output ${formatTokens(m.output)} · ${pct(m.hitRate)} from cache</div>` +
            `</div>`,
        )
        .join('') +
      `<div class="usage-notes">` +
      (notional ? `<div>* Claude on your subscription: what the API would charge. You're not billed per token.</div>` : '') +
      (r.models.some((m) => m.provider === 'deepseek')
        ? `<div>DeepSeek is priced per request at its peak or off-peak rate (now ${report.peakNow ? 'peak' : 'off-peak, half price'}).</div>`
        : '') +
      (r.machines > 1 ? `<div>Across ${r.machines} machines.</div>` : '') +
      `<div>Costs are estimates from list prices.</div>` +
      `</div>`;
  }
  if (report?.efficiency && !OWN_TABS.includes(usageScope)) {
    html += renderEfficiency(report.efficiency);
  }
  if (report?.tasks?.length && !OWN_TABS.includes(usageScope)) {
    html += renderTasks(report.tasks);
  }
  panel.innerHTML = html;
  drawnSplit = state?.split;
  if (usageScope === 'split') {
    placeSplit(state?.split ?? 50);
    const actual = /** @type {HTMLElement | null} */ (panel.querySelector('[data-split-actual]'));
    if (actual) {
      actual.style.width = `${actual.dataset.splitActual}%`;
    }
  }
  panel.querySelectorAll('[data-share]').forEach((bar) => {
    /** @type {HTMLElement} */ (bar).style.width = `${Math.max(1, Number(bar.getAttribute('data-share')) * 100)}%`;
  });
}

$('usage').addEventListener('click', () => setUsageOpen(!usageOpen));
$('usagePanel').addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.closest('[data-close-usage]')) {
    setUsageOpen(false);
    return;
  }
  const scope = target.closest('[data-scope]')?.getAttribute('data-scope');
  if (scope && scope !== usageScope) {
    usageScope = scope;
    vscode.postMessage({ type: 'usageReport', scope: reportScope(scope) });
    renderUsagePanel();
    return;
  }
  if (target.closest('[data-split-toggle]')) {
    saveSplit(state?.split === null || state?.split === undefined ? 50 : null);
    return;
  }
  const preset = target.closest('[data-split-preset]')?.getAttribute('data-split-preset');
  if (preset !== null && preset !== undefined) {
    saveSplit(Number(preset));
    return;
  }
  const costPreset = target.closest('[data-cost-preset]')?.getAttribute('data-cost-preset');
  if (costPreset) {
    const [kind, v] = costPreset.split(':');
    saveCost(kind, v);
    return;
  }
  const remove = target.closest('[data-cost-remove]')?.getAttribute('data-cost-remove');
  if (remove) {
    saveCost('model', 0, remove);
    return;
  }
  if (target.closest('[data-cost-add]')) {
    const key = /** @type {HTMLInputElement} */ ($('usagePanel').querySelector('[data-cost-new-key]')).value.trim();
    const limit = Number(/** @type {HTMLInputElement} */ ($('usagePanel').querySelector('[data-cost-new-limit]')).value);
    if (key && limit > 0) {
      saveCost('model', limit, key);
    }
  }
});
$('usagePanel').addEventListener('input', (e) => {
  const range = /** @type {HTMLInputElement} */ (e.target);
  if (range.classList.contains('split-range')) {
    placeSplit(Number(range.value));
  }
});
$('usagePanel').addEventListener('change', (e) => {
  const range = /** @type {HTMLInputElement} */ (e.target);
  const kind = range.getAttribute('data-cost');
  if (kind) {
    saveCost(kind, range.value, range.getAttribute('data-key'));
    range.blur();
    return;
  }
  if (range.classList.contains('split-range')) {
    splitDragging = false;
    saveSplit(Number(range.value));
  }
});
$('usagePanel').addEventListener('pointerdown', (e) => {
  const range = /** @type {HTMLElement} */ (e.target);
  if (range.classList.contains('split-range')) {
    splitDragging = true;
  }
});
// The redraw held off while typing in a limit.
$('usagePanel').addEventListener('focusout', () =>
  setTimeout(() => {
    if (redrawPending && !splitDragging) {
      redrawPending = false;
      renderUsagePanel();
    }
  }),
);
$('usagePanel').addEventListener('keydown', (e) => {
  const input = /** @type {HTMLInputElement} */ (e.target);
  if (e.key === 'Enter' && input.matches('[data-cost-new-key], [data-cost-new-limit]')) {
    /** @type {HTMLElement} */ ($('usagePanel').querySelector('[data-cost-add]')).click();
  }
});
window.addEventListener('pointerup', () => {
  if (!splitDragging) {
    return;
  }
  // After the slider's change event, which saves and redraws.
  setTimeout(() => {
    splitDragging = false;
    if (redrawPending) {
      redrawPending = false;
      renderUsagePanel();
    }
  });
});

/**
 * Drives the real chat webview in headless Chrome with VS Code's injected
 * styles. Screenshots land in test-output/.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChatPage, ROOT, chromePath, closeBrowser, openChatPage, stateMessage } from '../helpers/chatPage';
import { TurnMetrics, summarizeTurns } from '../../metrics/turns';
import { timeline } from '../../metrics/calls';

const THEMES = ['midnight', 'oled', 'graphite', 'nord', 'ocean', 'forest', 'aurora', 'ember'];
const EDITOR = { name: 'agentController.ts', path: '/Users/me/projects/my-app/src/agentController.ts', selection: '12-30' };

const skip = chromePath() ? false : 'Chrome not installed';
let chat: ChatPage;

before(async () => {
  if (!skip) {
    chat = await openChatPage();
  }
});
after(async () => {
  await chat?.close();
  await closeBrowser();
});

test('typing in the composer shows only the rounded glow, no square outline', { skip }, async () => {
  await chat.send(stateMessage({ editor: EDITOR }));
  await chat.page.click('#prompt');
  await chat.page.keyboard.type('Refactor this function');
  // The glow fades in.
  await chat.page.waitForFunction(() => getComputedStyle(document.getElementById('composer')!).boxShadow.includes('0px 0px 0px 3px'), { timeout: 2000 }).catch(() => {});
  const styles = await chat.page.evaluate(() => {
    const ta = getComputedStyle(document.getElementById('prompt')!);
    const composer = getComputedStyle(document.getElementById('composer')!);
    return { outline: ta.outlineStyle, composerRadius: composer.borderTopLeftRadius, composerShadow: composer.boxShadow };
  });
  assert.equal(styles.outline, 'none', 'the text box must not draw its own (square) outline');
  assert.equal(styles.composerRadius, '20px');
  assert.match(styles.composerShadow, /0px 0px 0px 3px/, 'the composer shows the focus ring instead');
  await chat.screenshot('composer-typing');
});

async function clearPrompt() {
  await chat.page.evaluate(() => ((document.getElementById('prompt') as HTMLTextAreaElement).value = ''));
}

test('the open file shows as a chip with the highlighted lines', { skip }, async () => {
  await chat.send(stateMessage({ editor: EDITOR }));
  const chip = await chat.page.$eval('.chip.editor', (el) => ({
    label: el.querySelector('.label')?.textContent,
    lines: el.querySelector('.chip-sel')?.textContent,
    title: el.getAttribute('title'),
  }));
  assert.equal(chip.label, 'agentController.ts');
  assert.equal(chip.lines, 'L12–30');
  assert.match(chip.title ?? '', /19 highlighted lines/);

  await chat.send(stateMessage({ editor: { ...EDITOR, selection: '7-7' } }));
  assert.equal(await chat.page.$eval('.chip-sel', (el) => el.textContent), 'L7', 'one line reads L7');

  await chat.send(stateMessage({ editor: { ...EDITOR, selection: undefined } }));
  assert.equal(await chat.page.$('.chip-sel'), null, 'no highlight, no line pill');
  assert.equal(await chat.page.$eval('.chip.editor .label', (el) => el.textContent), 'agentController.ts', 'the file still shows');

  await chat.send(stateMessage({ editor: undefined }));
  assert.equal(await chat.page.$('.chip.editor'), null, 'no file open, no chip');
});

test('the file chip can be left out, and the choice is sent with the message', { skip }, async () => {
  await clearPrompt();
  await chat.send(stateMessage({ editor: EDITOR }));
  await chat.page.click('.chip.editor');
  assert.ok(await chat.page.$('.chip.editor.off'));
  await chat.page.type('#prompt', 'without the file');
  await chat.page.keyboard.press('Enter');
  const sent = (await chat.posted()).filter((m) => m.type === 'send').at(-1);
  assert.equal(sent.text, 'without the file');
  assert.equal(sent.includeEditor, false);

  await chat.page.click('.chip.editor');
  await chat.page.type('#prompt', 'with the file');
  await chat.page.keyboard.press('Enter');
  assert.equal((await chat.posted()).filter((m) => m.type === 'send').at(-1).includeEditor, true);
});

test('a sent message shows which file and lines went with it', { skip }, async () => {
  await chat.send({ type: 'user', text: 'Explain this', attachments: ['/tmp/notes.txt'], editor: EDITOR });
  const chips = await chat.page.$$eval('.user-wrap:last-of-type .msg-attachments .chip', (els) => els.map((e) => e.textContent));
  assert.deepEqual(chips, ['agentController.tsL12–30', 'notes.txt']);
});

test('every theme applies, looks different, and keeps the send arrow readable', { skip }, async () => {
  const seen = new Map<string, string>();
  for (const theme of THEMES) {
    await chat.send(stateMessage({ editor: EDITOR, theme }));
    const result = await chat.page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const v = (name: string) => root.getPropertyValue(name).trim();
      const rgb = (hex: string) => {
        const h = hex.replace('#', '');
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      };
      const lum = (hex: string) => {
        const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const contrast = (a: string, b: string) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      return {
        applied: document.documentElement.dataset.theme,
        bg: v('--bg'),
        accent: v('--accent'),
        onAccent: [contrast(v('--on-accent'), v('--accent')), contrast(v('--on-accent'), v('--accent-2'))],
        text: contrast(v('--text'), v('--bg')),
        muted: contrast(v('--muted'), v('--bg')),
      };
    });
    assert.equal(result.applied, theme);
    seen.set(theme, `${result.bg}/${result.accent}`);
    assert.ok(result.text >= 7, `${theme}: body text contrast ${result.text.toFixed(1)} should be at least 7`);
    assert.ok(result.muted >= 4.5, `${theme}: secondary text contrast ${result.muted.toFixed(1)} should be at least 4.5`);
    for (const c of result.onAccent) {
      assert.ok(c >= 4.5, `${theme}: send arrow contrast ${c.toFixed(2)} too low`);
    }
    await chat.screenshot(`theme-${theme}`);
  }
  assert.equal(new Set(seen.values()).size, THEMES.length, 'each theme has its own colors');
  await chat.send(stateMessage({ editor: EDITOR, theme: 'midnight' }));
});

test('the theme menu opens below the palette button, previews on hover, and saves the choice', { skip }, async () => {
  await chat.send(stateMessage({ theme: 'midnight' }));
  await chat.page.click('#themeBtn');
  const layout = await chat.page.evaluate(() => {
    const btn = document.getElementById('themeBtn')!.getBoundingClientRect();
    const menu = document.getElementById('menu')!;
    const r = menu.getBoundingClientRect();
    return {
      hidden: menu.hidden,
      below: r.top >= btn.bottom,
      inside: r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      items: [...menu.querySelectorAll('.menu-item')].map((i) => i.getAttribute('data-value')),
      swatches: menu.querySelectorAll('.swatch').length,
      selected: menu.querySelector('.selected')?.getAttribute('data-value'),
    };
  });
  assert.equal(layout.hidden, false);
  assert.ok(layout.below, 'opens downward from the top bar');
  assert.ok(layout.inside, 'stays inside the panel');
  assert.deepEqual(layout.items, THEMES);
  assert.equal(layout.swatches, THEMES.length);
  assert.equal(layout.selected, 'midnight');
  await chat.screenshot('theme-menu');

  await chat.page.hover('.menu-item[data-value="ember"]');
  assert.equal(await chat.page.evaluate(() => document.documentElement.dataset.theme), 'ember', 'hover previews');
  await chat.page.keyboard.press('Escape');
  assert.equal(await chat.page.evaluate(() => document.documentElement.dataset.theme), 'midnight', 'closing restores');

  await chat.page.click('#themeBtn');
  await chat.page.click('.menu-item[data-value="ocean"]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'setTheme').at(-1), { type: 'setTheme', theme: 'ocean' });
  assert.equal(await chat.page.evaluate(() => document.documentElement.dataset.theme), 'ocean', 'applies at once');
  await chat.send(stateMessage({ theme: 'midnight' }));
});

test('composer pill menus still open upward', { skip }, async () => {
  await chat.page.click('#permPill');
  const above = await chat.page.evaluate(() => {
    const pill = document.getElementById('permPill')!.getBoundingClientRect();
    return document.getElementById('menu')!.getBoundingClientRect().bottom <= pill.top;
  });
  assert.ok(above);
  await chat.page.keyboard.press('Escape');
});

test('model, effort and build mode share one top-bar menu, with dividers between them', { skip }, async () => {
  await chat.send(stateMessage({ mode: 'auto', next: 'claude', effort: 'thinking' }));
  assert.equal(await chat.page.$eval('#modelLabel', (el) => el.textContent), 'Auto · Claude · Thinking');
  await chat.page.click('#modelPill');
  const menu = await chat.page.evaluate(() => {
    const m = document.getElementById('menu')!;
    const pill = document.getElementById('modelPill')!.getBoundingClientRect();
    return {
      titles: [...m.querySelectorAll('.menu-title')].map((t) => t.textContent),
      dividers: m.querySelectorAll('.menu-divider').length,
      items: [...m.querySelectorAll('.menu-item')].map((i) => i.getAttribute('data-value')),
      selected: [...m.querySelectorAll('.menu-item.selected')].map((i) => i.getAttribute('data-value')),
      below: m.getBoundingClientRect().top >= pill.bottom,
      dividerBetween: (() => {
        const kids = [...m.children];
        const d = kids.findIndex((k) => k.classList.contains('menu-divider'));
        return kids[d - 1]?.getAttribute('data-value') === 'deepseek' && kids[d + 1]?.textContent === 'Effort';
      })(),
    };
  });
  assert.deepEqual(menu.titles, ['Model', 'Effort', 'Build (this project)']);
  assert.equal(menu.dividers, 2);
  assert.ok(menu.dividerBetween, 'the divider separates the model choices from the effort choices');
  assert.deepEqual(menu.items, ['auto', 'claude', 'deepseek', 'flash', 'thinking', 'hybrid', 'reuse', 'craft']);
  assert.deepEqual(menu.selected, ['auto', 'thinking', 'hybrid'], 'one choice ticked in each section');
  assert.ok(menu.below, 'opens downward from the top bar');
  await new Promise((r) => setTimeout(r, 250));
  await chat.screenshot('model-menu');
  await chat.page.click('.menu-item[data-value="deepseek"]');
  await chat.page.click('#modelPill');
  await chat.page.click('.menu-item[data-value="flash"]');
  const posted = await chat.posted();
  assert.deepEqual(posted.filter((m) => m.type === 'setMode').at(-1), { type: 'setMode', mode: 'deepseek' });
  assert.deepEqual(posted.filter((m) => m.type === 'setEffort').at(-1), { type: 'setEffort', effort: 'flash' });
  await chat.send(stateMessage({ mode: 'deepseek', next: 'deepseek', effort: 'flash' }));
  assert.equal(await chat.page.$eval('#modelLabel', (el) => el.textContent), 'DeepSeek · Flash', 'hybrid, the default, is not shown');
  await chat.page.click('#modelPill');
  await chat.page.click('.menu-item[data-value="reuse"]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'setBuildMode').at(-1), { type: 'setBuildMode', mode: 'reuse' });
  await chat.send(stateMessage({ mode: 'deepseek', next: 'deepseek', effort: 'flash', buildMode: 'reuse' }));
  assert.equal(await chat.page.$eval('#modelLabel', (el) => el.textContent), 'DeepSeek · Flash · Reuse');
  await chat.send(stateMessage());
});

async function bottomBarGaps(page: ChatPage['page']) {
  return page.evaluate(() => {
    const bar = document.querySelector('.composer-bar')!.getBoundingClientRect();
    const kids = [...document.querySelector('.composer-bar')!.children].filter((k) => (k as HTMLElement).offsetParent);
    const rects = kids.map((k) => k.getBoundingClientRect());
    const pills = rects.slice(0, -1);
    return {
      ids: kids.map((k) => k.id),
      /** Gaps between the pills (everything but Send). */
      gaps: pills.slice(1).map((r, i) => r.left - pills[i].right),
      firstOffset: pills[0].left - bar.left,
      sendAtRight: Math.abs(rects.at(-1)!.right - bar.right) <= 0.5,
      spaceBeforeSend: rects.at(-1)!.left - pills.at(-1)!.right,
      overflow: rects.at(-1)!.right > bar.right + 0.5,
    };
  });
}

test('the bottom bar: attach, agents, permissions and tokens left-aligned with even gaps; send on the right', { skip }, async () => {
  const bar = await bottomBarGaps(chat.page);
  assert.deepEqual(bar.ids, ['attach', 'tunePill', 'agentsPill', 'permPill', 'usage', 'send']);
  assert.ok(bar.firstOffset <= 0.5, 'the first pill starts at the left edge');
  assert.ok(bar.gaps.every((g) => Math.abs(g - 6) <= 0.5), `pill gaps should all be 6px: ${bar.gaps.map((g) => g.toFixed(1)).join(', ')}`);
  assert.ok(bar.sendAtRight, 'send stays at the right edge');
  assert.ok(bar.spaceBeforeSend > 6, 'the free space is between the pills and send');
  assert.equal(bar.overflow, false);
});

const SNAPSHOT = {
  type: 'agents',
  tokens: 48_200,
  plan: [
    { content: 'Find where late fees are computed', status: 'completed', activeForm: 'Finding late fee code' },
    { content: 'Fix the rounding bug', status: 'in_progress', activeForm: 'Fixing the rounding bug' },
    { content: 'Add a test', status: 'pending', activeForm: 'Adding a test' },
  ],
  agents: [
    { id: 'main', name: 'Main agent', description: '', status: 'running', startedAt: Date.now() - 65_000, model: 'deepseek-v4-pro', tokens: 30_000, toolUses: 3, steps: [{ tool: 'TodoWrite', detail: '{"todos":[...]}', at: 0 }, { tool: 'Agent', detail: 'Find late fee code', at: 0 }, { tool: 'Agent', detail: 'Review the fix', at: 0 }], earlierSteps: 0, depth: 0 },
    { id: 'toolu_1', name: 'quick-helper', description: 'Find late fee code', status: 'done', startedAt: Date.now() - 60_000, endedAt: Date.now() - 50_000, model: 'deepseek-flash', tokens: 6_200, toolUses: 6, summary: 'Found computeLateFee in billing.ts', steps: [1, 2, 3, 4, 5, 6].map((i) => ({ tool: i % 2 ? 'Grep' : 'Read', detail: `/Users/me/projects/my-app/src/file${i}.ts`, at: 0 })), earlierSteps: 0, depth: 1 },
    { id: 'toolu_2', taskId: 'task_2', name: 'deep-thinker', description: 'Review the fix', status: 'running', startedAt: Date.now() - 20_000, model: 'deepseek-v4-pro', tokens: 12_000, toolUses: 2, summary: 'Checking edge cases for zero days', steps: [{ tool: 'Read', detail: '/Users/me/projects/my-app/src/billing.ts', at: 0 }], earlierSteps: 0, depth: 1 },
  ],
};

test('the agents pill shows how many are running; clicking opens the agents panel and clicking again closes it', { skip }, async () => {
  await chat.send({ type: 'reset' });
  assert.equal(await chat.page.$eval('#agentsLabel', (el) => el.textContent), '0 running');
  await chat.page.click('#agentsPill');
  assert.match(await chat.page.$eval('#agentsPanel', (el) => el.textContent ?? ''), /No agents have run in this chat yet/);
  await chat.page.click('#agentsPill');

  await chat.send(SNAPSHOT);
  const pill = await chat.page.$eval('#agentsPill', (el) => ({ label: el.querySelector('#agentsLabel')!.textContent, running: el.classList.contains('running') }));
  assert.deepEqual(pill, { label: 'Plan 1/3 · 2 running', running: true }, 'an unfinished plan shows its progress');
  assert.equal(await chat.page.$eval('#agentsPanel', (el) => (el as HTMLElement).hidden), true, 'closed until clicked');

  await chat.page.click('#agentsPill');
  const panel = await chat.page.evaluate(() => {
    const p = document.getElementById('agentsPanel')!;
    return {
      hidden: p.hidden,
      meta: p.querySelector('.ap-meta')?.textContent,
      tokens: p.querySelector('.ap-tokens')?.textContent,
      planCount: p.querySelector('.ap-label span')?.textContent,
      plan: [...p.querySelectorAll('.plan-item')].map((li) => [li.className.replace('plan-item ', ''), li.textContent]),
      bar: (p.querySelector('#planBar') as HTMLElement)?.style.width,
      pills: [...p.querySelectorAll('.agent-pill')].map((b) => [b.querySelector('.apl-name')?.textContent, b.querySelector('.status-icon')?.className.replace('status-icon ', ''), b.querySelector('.apl-task')?.textContent]),
      cards: [...p.querySelectorAll('.agent-card')].map((c) => ({
        name: c.querySelector('.ac-name')?.textContent,
        model: c.querySelector('.ac-model')?.textContent,
        status: c.querySelector('.status-icon')?.className.replace('status-icon ', ''),
        steps: c.querySelectorAll('.ac-steps li').length,
        more: c.querySelector('.ac-more')?.textContent,
        summary: c.querySelector('.ac-summary')?.textContent,
      })),
    };
  });
  assert.equal(panel.hidden, false);
  assert.equal(panel.meta, '2 running · 1 done');
  assert.equal(panel.tokens, '48k new tokens');
  assert.equal(panel.planCount, '1/3');
  assert.deepEqual(panel.plan, [
    ['completed', 'Find where late fees are computed'],
    ['in_progress', 'Fixing the rounding bug'],
    ['pending', 'Add a test'],
  ]);
  assert.equal(panel.bar, '33.3333%');
  assert.deepEqual(panel.pills, [
    ['Main agent', 'running', 'Fixing the rounding bug'],
    ['Quick helper', 'done', 'Find late fee code'],
    ['Deep thinker', 'running', 'Review the fix'],
  ]);
  assert.deepEqual(panel.cards, [
    { name: 'Main agent', model: 'deepseek-v4-pro', status: 'running', steps: 3 },
    { name: 'Quick helper', model: 'deepseek-flash', status: 'done', steps: 4, more: '+2 earlier steps', summary: 'Found computeLateFee in billing.ts' },
    { name: 'Deep thinker', model: 'deepseek-v4-pro', status: 'running', steps: 1, summary: 'Checking edge cases for zero days' },
  ]);
  await new Promise((r) => setTimeout(r, 250));
  await chat.screenshot('agents-panel');

  await chat.page.click('[data-agent="toolu_1"] .ac-more');
  assert.equal(await chat.page.$$eval('[data-agent="toolu_1"] .ac-steps li', (els) => els.length), 6, 'expanding shows every step');

  await chat.page.click('#agentsPill');
  assert.equal(await chat.page.$eval('#agentsPanel', (el) => (el as HTMLElement).hidden), true, 'a second click closes it');
});

test('agents at work show in the pill only: no box above the message box, and the count follows them', { skip }, async () => {
  await chat.send({ type: 'reset' });
  const label = () => chat.page.$eval('#agentsLabel', (el) => el.textContent);
  assert.equal(await chat.page.$('#liveAgents'), null, 'no list above the composer');
  await chat.send(SNAPSHOT);
  assert.equal(await label(), 'Plan 1/3 · 2 running');
  const helperDone = { ...SNAPSHOT, agents: SNAPSHOT.agents.map((a) => (a.id === 'toolu_2' ? { ...a, status: 'done', endedAt: Date.now() } : a)) };
  await chat.send(helperDone);
  assert.equal(await label(), 'Plan 1/3 · 1 running', 'a stopped helper leaves the count');
  await chat.send({ ...helperDone, agents: helperDone.agents.map((a) => (a.id === 'main' ? { ...a, status: 'idle' } : a)) });
  assert.equal(await label(), 'Plan 1/3 · 0 running');
  await chat.send({ ...SNAPSHOT, agents: [], plan: SNAPSHOT.plan.map((p) => ({ ...p, status: 'completed' })) });
  assert.equal(await label(), '0 running', 'a finished plan leaves the pill');
  await chat.send(SNAPSHOT);
  await chat.page.click('#agentsPill');
  assert.equal(await chat.page.$eval('#agentsPanel', (el) => (el as HTMLElement).hidden), false, 'the pill opens the agents');
  await chat.page.click('#agentsPill');
});

test('a running helper has its own Stop; the others keep working', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(SNAPSHOT);
  await chat.page.click('#agentsPill');
  assert.equal(await chat.page.$$eval('.ac-stop', (els) => els.length), 1, 'only the running helper, not the main agent or a finished one');
  await chat.page.click('[data-stop-agent="task_2"]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'stopAgent').at(-1), { type: 'stopAgent', taskId: 'task_2' });
  await chat.page.click('#agentsPill');
});

const ago = (ms: number) => Date.now() - ms;
const run = (id: string, over: Record<string, unknown>) => ({ id, name: 'general-purpose', description: '', status: 'done', startedAt: ago(120_000), endedAt: ago(60_000), model: 'deepseek-flash', tokens: 4_000, toolUses: 2, steps: [{ tool: 'Read', detail: '/Users/me/projects/my-app/src/crm.ts', at: 0 }, { tool: 'Grep', detail: 'contact', at: 0 }], earlierSteps: 0, depth: 1, ...over });
const TROUBLE = {
  type: 'agents',
  tokens: 91_000,
  plan: [{ content: 'Fix the sync bug', status: 'in_progress', activeForm: 'Fixing the sync bug' }, { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' }],
  agents: [
    run('main', { name: 'Main agent', status: 'running', endedAt: undefined, depth: 0, model: 'deepseek-v4-pro', tokens: 40_000 }),
    run('c1', { label: 'crm-bridge', description: 'Map CRM fields', summary: 'Mapped 14 fields' }),
    run('c2', { label: 'crm-bridge', taskId: 'task_b', description: 'Sync contacts', status: 'blocked', endedAt: undefined, todos: [{ content: 'Read API', status: 'completed', activeForm: 'Reading API' }, { content: 'Sync contacts', status: 'in_progress', activeForm: 'Syncing contacts' }, { content: 'Report', status: 'pending', activeForm: 'Reporting' }] }),
    run('c3', { name: 'quick-helper', taskId: 'task_q', description: 'Scan logs', status: 'warning', stalled: true, lastActivityAt: ago(180_000), endedAt: undefined }),
    run('c4', { name: 'deep-thinker', description: 'Review migration', status: 'failed', summary: 'Migration file not found' }),
    run('c5', { name: 'Explore', description: 'Find <b>callers</b>' }),
  ],
};

test('agents show as pills with their status and current task; clicking one shows its to-do list and every task it worked on', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(TROUBLE);
  const pill = await chat.page.$eval('#agentsPill', (el) => ({
    label: el.querySelector('#agentsLabel')!.textContent,
    alert: (el as HTMLElement).dataset.alert,
    title: (el as HTMLElement).title.includes('1 blocked · 1 warning · 1 failed'),
  }));
  assert.deepEqual(pill, { label: 'Plan 0/2 · 3 running · 1 blocked', alert: 'blocked', title: true }, 'trouble shows without opening the panel');

  await chat.page.click('#agentsPill');
  const pills = await chat.page.$$eval('.agent-pill', (els) =>
    els.map((b) => ({
      name: b.querySelector('.apl-name')?.textContent,
      status: b.querySelector('.status-icon')?.className.replace('status-icon ', ''),
      icon: !!b.querySelector('.status-icon svg'),
      count: b.querySelector('.apl-count')?.textContent ?? '',
      note: b.querySelector('.apl-note')?.textContent ?? '',
      task: b.querySelector('.apl-task')?.textContent,
    })),
  );
  assert.deepEqual(pills, [
    { name: 'Main agent', status: 'running', icon: false, count: '', note: '', task: 'Fixing the sync bug' },
    { name: 'crm-bridge', status: 'blocked', icon: true, count: '2', note: 'waiting for you', task: 'Syncing contacts' },
    { name: 'Quick helper', status: 'warning', icon: true, count: '', note: '', task: 'Scan logs' },
    { name: 'Deep thinker', status: 'failed', icon: true, count: '', note: '', task: 'Review migration' },
    { name: 'Explore', status: 'done', icon: true, count: '', note: '', task: 'Find <b>callers</b>' },
  ]);
  const spin = await chat.page.$eval('.agent-pill .status-icon.running', (el) => getComputedStyle(el, '::before').animationName);
  assert.equal(spin, 'spin', 'running shows a spinning wheel');
  assert.match(await chat.page.$eval('[data-agent="c3"] .ac-note', (el) => el.textContent ?? ''), /^No activity for 3m/);
  assert.equal(await chat.page.$eval('#agentsPanel', (el) => el.querySelectorAll('b').length), 0, 'text is escaped');

  await chat.page.click('[data-pick-agent="crm-bridge"]');
  const picked = await chat.page.evaluate(() => {
    const p = document.getElementById('agentsPanel')!;
    return {
      pressed: [...p.querySelectorAll('.agent-pill[aria-pressed="true"]')].map((b) => b.querySelector('.apl-name')?.textContent),
      labels: [...p.querySelectorAll('.ap-label')].map((l) => l.textContent),
      todos: [...p.querySelectorAll('.plan-item')].map((li) => [li.className.replace('plan-item ', ''), li.textContent]),
      runs: [...p.querySelectorAll('.agent-card')].map((c) => [c.getAttribute('data-agent'), c.querySelector('.status-icon')?.className.replace('status-icon ', ''), c.querySelector('.ac-desc')?.textContent, c.querySelector('.ac-note')?.textContent ?? '']),
      stops: [...p.querySelectorAll('.ac-stop')].map((b) => b.getAttribute('data-stop-agent')),
    };
  });
  assert.deepEqual(picked, {
    pressed: ['crm-bridge'],
    labels: ['To-do 1/3', 'Tasks 2'],
    todos: [
      ['completed', 'Read API'],
      ['in_progress', 'Syncing contacts'],
      ['pending', 'Report'],
    ],
    runs: [
      ['c2', 'blocked', 'Sync contacts', 'Waiting for you to answer'],
      ['c1', 'done', 'Map CRM fields', ''],
    ],
    stops: ['task_b'],
  });
  await new Promise((r) => setTimeout(r, 250));
  await chat.screenshot('agents-pills');

  await chat.page.click('[data-agent="c1"] .ac-head');
  assert.equal(await chat.page.$eval('[data-agent="c1"] .ac-head', (el) => el.getAttribute('aria-expanded')), 'true', 'a task opens to its steps');
  await chat.page.click('[data-pick-agent="crm-bridge"]');
  assert.equal(await chat.page.$$eval('.agent-card', (els) => els.length), 6, 'clicking the pill again shows everyone\'s work');
  await chat.page.click('#agentsPill');
});

test('while working: Enter steers, Tab queues, and the button stops only when the box is empty', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await clearPrompt();
  await chat.send(stateMessage({ busy: true }));
  const sends = async () => (await chat.posted()).filter((m) => m.type === 'send' || m.type === 'stop');
  const before = (await sends()).length;
  assert.ok(await chat.page.$('#send.busy'), 'an empty box shows Stop');
  await chat.page.focus('#prompt');
  await chat.page.keyboard.press('Enter');
  assert.equal((await sends()).length, before, 'Enter on an empty box never stops');

  await chat.page.type('#prompt', 'also update the docs');
  assert.equal(await chat.page.$('#send.busy'), null, 'with text the button sends');
  await chat.page.keyboard.press('Enter');
  assert.deepEqual((await sends()).at(-1), { type: 'send', text: 'also update the docs', attachments: [], includeEditor: false, queue: false });

  await chat.page.type('#prompt', 'then bump the version');
  await chat.page.keyboard.press('Tab');
  assert.equal((await sends()).at(-1).queue, true);

  await chat.page.click('#send');
  assert.equal((await sends()).at(-1).type, 'stop');
  await chat.send(stateMessage({ busy: false }));
});

test('the Stop button\'s ring animates only transform and opacity, behind the button face', { skip }, async () => {
  await clearPrompt();
  await chat.send(stateMessage({ busy: true }));
  const r = await chat.page.evaluate(() => {
    const send = document.getElementById('send')!;
    const ring = [...document.styleSheets]
      .flatMap((s) => [...s.cssRules])
      .find((rule): rule is CSSKeyframesRule => rule instanceof CSSKeyframesRule && rule.name === 'ring')!;
    const props = new Set([...ring.cssRules].flatMap((k) => [...(k as CSSKeyframeRule).style]));
    return {
      button: getComputedStyle(send).animationName,
      before: getComputedStyle(send, '::before').animationName,
      props: [...props].sort(),
      face: getComputedStyle(send, '::after').backgroundColor,
      surface: getComputedStyle(document.documentElement).getPropertyValue('--surface-3').trim(),
    };
  });
  assert.equal(r.button, 'none', 'the button itself never repaints');
  assert.equal(r.before, 'ring');
  assert.deepEqual(r.props, ['opacity', 'transform']);
  assert.ok(r.face !== 'rgba(0, 0, 0, 0)' && r.surface, 'the face covers the ring');
  await chat.screenshot('send-busy');
  await chat.send(stateMessage({ busy: false }));
});

const QUESTIONS = [
  { question: 'Which color should the button be?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Bold and loud' }, { label: 'Blue', description: 'Calm', preview: 'button { background: blue; }' }] },
  { question: 'Which sizes do you need?', header: 'Sizes', multiSelect: true, options: [{ label: 'Small', description: '' }, { label: 'Medium', description: '' }, { label: 'Large', description: '' }] },
];

test('a question card: readable options, Send only once every question is answered, the exact answers sent back', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({ busy: true }));
  await chat.send({ type: 'question', id: 'q1', questions: QUESTIONS });
  const card = await chat.page.evaluate(() => {
    const c = document.getElementById('ask-q1')!;
    return {
      title: c.querySelector('.ask-title')?.textContent,
      chips: [...c.querySelectorAll('.ask-chip')].map((e) => e.textContent),
      questions: [...c.querySelectorAll('.ask-text')].map((e) => e.textContent),
      options: [...c.querySelectorAll('.ask-q')].map((q) => [...q.querySelectorAll('.ask-label')].map((l) => l.textContent)),
      roles: [...c.querySelectorAll('.ask-q')].map((q) => q.querySelector('.ask-opt')!.getAttribute('role')),
      hint: c.querySelector('.ask-hint')?.textContent,
      sendDisabled: (c.querySelector('[data-ask-send]') as HTMLButtonElement).disabled,
      json: /[{}\[\]"]/.test(c.querySelector('.ask-text')!.textContent ?? ''),
    };
  });
  assert.equal(card.title, '2 questions for you');
  assert.deepEqual(card.chips, ['Color', 'Sizes']);
  assert.deepEqual(card.questions, ['Which color should the button be?', 'Which sizes do you need?']);
  assert.deepEqual(card.options, [['Red', 'Blue', 'Other…'], ['Small', 'Medium', 'Large', 'Other…']]);
  assert.deepEqual(card.roles, ['radio', 'checkbox']);
  assert.equal(card.hint, 'Choose any');
  assert.equal(card.sendDisabled, true, 'nothing chosen yet');
  assert.equal(card.json, false, 'no JSON shown to the user');

  // One card, a tab per question, one question showing at a time.
  const tabs = () => chat.page.evaluate(() => {
    const c = document.getElementById('ask-q1')!;
    return {
      labels: [...c.querySelectorAll('.ask-tab')].map((t) => t.textContent),
      active: [...c.querySelectorAll('.ask-tab')].findIndex((t) => t.getAttribute('aria-selected') === 'true'),
      done: [...c.querySelectorAll('.ask-tab')].map((t) => t.classList.contains('done')),
      visible: [...c.querySelectorAll('.ask-q')].map((q) => !(q as HTMLElement).hidden && (q as HTMLElement).offsetParent !== null),
      progress: c.querySelector('.ask-progress')?.textContent,
      back: (c.querySelector('[data-ask-back]') as HTMLElement).offsetParent !== null,
      next: (c.querySelector('[data-ask-next]') as HTMLElement).offsetParent !== null,
    };
  });
  assert.deepEqual(await tabs(), { labels: ['Color', 'Sizes'], active: 0, done: [false, false], visible: [true, false], progress: '0 of 2 answered', back: false, next: true });

  const opt = (q: number, o: string) => `#ask-q1 .ask-opt[data-q="${q}"][data-o="${o}"]`;
  await chat.page.click(opt(0, '0'));
  await chat.page.click(opt(0, '1')); // single choice: Blue replaces Red
  assert.equal(await chat.page.$eval('#ask-q1 .ask-preview[data-q="0"]', (e) => (e as HTMLElement).hidden ? '' : e.textContent), 'button { background: blue; }', 'the option preview shows');
  assert.equal(await chat.page.$eval('[data-ask-send]', (b) => (b as HTMLButtonElement).disabled), true, 'the second question is still open');
  assert.deepEqual((await tabs()).done, [true, false], 'the answered tab is ticked');
  await chat.page.click('#ask-q1 [data-ask-next]');
  assert.deepEqual(await tabs(), { labels: ['Color', 'Sizes'], active: 1, done: [true, false], visible: [false, true], progress: '1 of 2 answered', back: true, next: false });
  await chat.page.keyboard.press('Tab');
  await chat.page.focus('#ask-q1 .ask-tab[data-tab="1"]');
  await chat.page.keyboard.press('ArrowLeft');
  assert.equal((await tabs()).active, 0, 'arrow keys move between tabs');
  await chat.page.click('#ask-q1 .ask-tab[data-tab="1"]');
  await chat.page.click(opt(1, '0'));
  await chat.page.click(opt(1, '2'));
  await chat.page.click(opt(1, 'other'));
  assert.equal(await chat.page.$eval('[data-ask-send]', (b) => (b as HTMLButtonElement).disabled), true, '"Other" needs text');
  await chat.page.type('#ask-q1 .ask-other-input[data-q="1"]', 'XL');
  assert.equal((await tabs()).progress, '2 of 2 answered');
  const selected = await chat.page.$$eval('#ask-q1 .ask-opt.selected .ask-label', (els) => els.map((e) => e.textContent));
  assert.deepEqual(selected, ['Blue', 'Small', 'Large', 'Other…']);
  await chat.screenshot('question-card');
  await chat.page.click('[data-ask-send]');
  const sent = (await chat.posted()).filter((m) => m.type === 'answer').at(-1);
  assert.deepEqual(sent, { type: 'answer', id: 'q1', answers: { 'Which color should the button be?': 'Blue', 'Which sizes do you need?': 'Small, Large, XL' } });

  await chat.send({ type: 'questionResolved', id: 'q1', questions: QUESTIONS, answers: sent.answers, skipped: false });
  const done = await chat.page.evaluate(() => ({
    resolved: document.getElementById('ask-q1')!.classList.contains('resolved'),
    buttons: document.querySelectorAll('#ask-q1 button').length,
    summary: [...document.querySelectorAll('#ask-q1 .ask-sum-a')].map((e) => e.textContent),
    typing: !!document.querySelector('#log .typing'),
  }));
  assert.deepEqual(done, { resolved: true, buttons: 0, summary: ['Blue', 'Small, Large, XL'], typing: true });
  await chat.screenshot('question-answered');
});

test('a question can be skipped, and a reopened chat shows the answered question', { skip }, async () => {
  await chat.send({ type: 'question', id: 'q2', questions: [QUESTIONS[0]] });
  assert.equal(await chat.page.$eval('#ask-q2 .ask-title', (e) => e.textContent), 'A question for you');
  assert.equal(await chat.page.$eval('#ask-q2 [data-ask-send]', (e) => e.textContent), 'Send answer');
  await chat.page.click('#ask-q2 [data-ask-skip]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'answer').at(-1), { type: 'answer', id: 'q2', skipped: true });

  await chat.send({ type: 'reset' });
  await chat.send({ type: 'restore', messages: [{ type: 'questionResolved', id: 'old', questions: [QUESTIONS[0]], answers: { 'Which color should the button be?': 'Red' }, skipped: false }] });
  assert.equal(await chat.page.$eval('.ask-card.resolved .ask-sum-a', (e) => e.textContent), 'Red');
});

test('plan approval: the plan reads as formatted text, and approve or send back with feedback', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send({ type: 'planReview', id: 'p1', plan: '## Add an Installation section\n1. Write the steps\n2. Add `npm install`' });
  const card = await chat.page.evaluate(() => ({
    title: document.querySelector('#plan-p1 .ask-title')?.textContent,
    heading: document.querySelector('#plan-p1 .plan-body h4')?.textContent,
    items: [...document.querySelectorAll<HTMLInputElement>('#plan-p1 .plan-step-text')].map((e) => e.value),
  }));
  assert.deepEqual(card, { title: 'Plan ready for review', heading: 'Add an Installation section', items: ['Write the steps', 'Add `npm install`'] });
  await chat.screenshot('plan-card');
  await chat.page.type('#plan-p1 .plan-feedback', 'Mention Windows too.');
  await chat.page.click('#plan-p1 [data-plan-revise]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'planDecision').at(-1), { type: 'planDecision', id: 'p1', approve: false, feedback: 'Mention Windows too.' });
  await chat.send({ type: 'planResolved', id: 'p1', plan: 'x', approved: false, feedback: 'Mention Windows too.' });
  assert.equal(await chat.page.$eval('#plan-p1 .verdict', (e) => e.textContent), 'Sent back: Mention Windows too.');
  assert.equal(await chat.page.$('#plan-p1 .buttons'), null);

  await chat.send({ type: 'planReview', id: 'p2', plan: 'Do it' });
  await chat.page.click('#plan-p2 [data-plan-approve]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'planDecision').at(-1), { type: 'planDecision', id: 'p2', approve: true });
});

test('plan steps: numbered, bulleted, nested and no list', { skip }, async () => {
  const parse = (md: string) => chat.page.evaluate((m) => (window as any).eval('parsePlanSteps')(m), md);
  assert.deepEqual(await parse('Intro\n\n1. One\n2) Two\n\nAfter'), { intro: 'Intro\n', steps: ['One', 'Two'], outro: '\nAfter' });
  assert.deepEqual((await parse('- A\n* B\n+ C')).steps, ['A', 'B', 'C']);
  assert.deepEqual((await parse('1. Edit\n   - a.ts\n   - b.ts\n2. Test\n   more detail')).steps, ['Edit; a.ts; b.ts', 'Test more detail']);
  assert.deepEqual((await parse('```\n- not a step\n```\n- real')).steps, ['real']);
  assert.deepEqual(await parse('Just do it.'), { intro: 'Just do it.', steps: [], outro: '' });
});

test('plan editing: edit, add, move and delete steps, approve sends them, then a checklist stays', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send({ type: 'planReview', id: 'e1', plan: '## Plan\n1. Write code\n2. Run tests\n3. Ship' });
  const steps = () => chat.page.$$eval('#plan-e1 .plan-step-text', (els) => els.map((e) => (e as HTMLInputElement).value));
  assert.deepEqual(await steps(), ['Write code', 'Run tests', 'Ship']);
  assert.equal(await chat.page.$eval('#plan-e1 .plan-step-text', (e) => e.getAttribute('aria-label')), 'Step 1');
  assert.equal(await chat.page.$eval('#plan-e1 [data-step-del]', (e) => e.getAttribute('aria-label')), 'Delete step 1');
  // Unedited approve is unchanged: no steps.
  // Edit step 1, delete step 3, move step 2 up, add one with Enter.
  await chat.page.click('#plan-e1 .plan-step-text', { clickCount: 3 });
  await chat.page.keyboard.type('Write the code');
  await chat.page.click('#plan-e1 .plan-step:nth-child(3) [data-step-del]');
  await chat.page.click('#plan-e1 .plan-step:nth-child(2) [data-step-up]');
  await chat.page.focus('#plan-e1 .plan-step:nth-child(2) .plan-step-text');
  await chat.page.keyboard.press('Enter');
  await chat.page.keyboard.type('Update docs');
  assert.deepEqual(await steps(), ['Run tests', 'Write the code', 'Update docs']);
  assert.equal((await chat.posted()).filter((m) => m.type === 'planDecision' && m.id === 'e1').length, 0, 'Enter in a step does not submit');
  await chat.page.click('#plan-e1 [data-plan-approve]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'planDecision').at(-1), { type: 'planDecision', id: 'e1', approve: true, steps: ['Run tests', 'Write the code', 'Update docs'] });
  await chat.send({ type: 'planResolved', id: 'e1', plan: '1. Run tests\n2. Write the code\n3. Update docs', approved: true });
  const done = await chat.page.evaluate(() => ({
    items: [...document.querySelectorAll('#plan-e1 .plan-checklist li')].map((e) => e.textContent),
    editor: !!document.querySelector('#plan-e1 .plan-steps, #plan-e1 .buttons'),
    collapsed: document.querySelector('#plan-e1')?.classList.contains('collapsed'),
  }));
  assert.deepEqual(done, { items: ['Run tests', 'Write the code', 'Update docs'], editor: false, collapsed: true });

  await chat.send({ type: 'planReview', id: 'e2', plan: '1. A\n2. B' });
  await chat.page.click('#plan-e2 [data-plan-approve]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'planDecision').at(-1), { type: 'planDecision', id: 'e2', approve: true });
});

const USAGE_SUMMARY = {
  input: 30_000, cacheRead: 270_000, cacheWrite: 4_000, output: 12_000, tokens: 316_000, cost: 0.4321, billedCost: 0.0123, hitRate: 0.89, machines: 2, requests: 14,
  models: [
    { model: 'claude-opus-5-5', provider: 'claude', input: 10_000, cacheRead: 180_000, cacheWrite: 4_000, output: 6_000, tokens: 200_000, share: 0.633, cost: 0.42, costShare: 0.972, hitRate: 0.93, notional: true },
    { model: 'deepseek-v4-pro', provider: 'deepseek', input: 15_000, cacheRead: 80_000, cacheWrite: 0, output: 5_000, tokens: 100_000, share: 0.316, cost: 0.011, costShare: 0.025, hitRate: 0.84, notional: false },
    { model: 'deepseek-flash', provider: 'deepseek', input: 5_000, cacheRead: 10_000, cacheWrite: 0, output: 1_000, tokens: 16_000, share: 0.051, cost: 0.0013, costShare: 0.003, hitRate: 0.67, notional: false },
  ],
};

test('the token pill opens a usage panel: every model, its share, its cost, and the total; scopes switch; it closes again', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage());
  await chat.page.click('#usage');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'usageReport').at(-1), { type: 'usageReport', scope: 'chat' });
  assert.match(await chat.page.$eval('#usagePanel', (e) => e.textContent ?? ''), /Loading/);
  await chat.send({ type: 'usageReport', scope: 'chat', summary: USAGE_SUMMARY, peakNow: false });
  const panel = await chat.page.evaluate(() => {
    const p = document.getElementById('usagePanel')!;
    return {
      hidden: p.hidden,
      totals: [...p.querySelectorAll('.usage-totals b')].map((e) => e.textContent),
      models: [...p.querySelectorAll('.model-row')].map((r) => [r.querySelector('.mr-name')?.textContent, r.querySelector('.mr-provider')?.textContent, r.querySelector('.mr-share')?.textContent]),
      bars: [...p.querySelectorAll('.mr-bar span')].map((b) => (b as HTMLElement).style.width),
      detail: p.querySelector('.model-row .mr-detail')?.textContent,
      notes: p.querySelector('.usage-notes')?.textContent,
      on: p.querySelector('.scope-pill.on')?.textContent,
    };
  });
  assert.equal(panel.hidden, false);
  assert.deepEqual(panel.totals, ['316k', '$0.43', '89%']);
  assert.deepEqual(panel.models, [
    ['claude-opus-5-5', 'Claude', '63%'],
    ['deepseek-v4-pro', 'DeepSeek', '32%'],
    ['deepseek-flash', 'DeepSeek', '5%'],
  ]);
  assert.deepEqual(panel.bars, ['63.3%', '31.6%', '5.1%']);
  assert.equal(panel.detail, '200k tokens · $0.42* (97% of cost)');
  assert.match(panel.notes ?? '', /not billed per token/);
  assert.match(panel.notes ?? '', /off-peak, half price/);
  assert.match(panel.notes ?? '', /Across 2 machines/);
  assert.equal(panel.on, 'This chat');
  await new Promise((r) => setTimeout(r, 250));
  await chat.screenshot('usage-panel');

  await chat.page.click('.scope-pill[data-scope="repo"]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'usageReport').at(-1), { type: 'usageReport', scope: 'repo' });
  await chat.send({ type: 'usageReport', scope: 'repo', summary: { ...USAGE_SUMMARY, tokens: 0, models: [] }, peakNow: true });
  assert.match(await chat.page.$eval('#usagePanel', (e) => e.textContent ?? ''), /No tokens used in this repo/);

  await chat.page.click('#agentsPill');
  assert.equal(await chat.page.$eval('#usagePanel', (e) => (e as HTMLElement).hidden), true, 'opening agents closes usage');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'usageReport').at(-1), { type: 'usageReport' }, 'the extension is told it closed');
  await chat.page.click('#agentsPill');
  await chat.page.click('#usage');
  await chat.page.click('#usage');
  assert.equal(await chat.page.$eval('#usagePanel', (e) => (e as HTMLElement).hidden), true, 'a second click closes it');

  await chat.page.click('#usage');
  await chat.page.click('.scope-pill[data-scope="chat"]');
  assert.equal(await chat.page.$eval('#usagePanel', (e) => (e as HTMLElement).hidden), false, 'clicks inside keep it open');
  await chat.page.click('#prompt');
  assert.equal(await chat.page.$eval('#usagePanel', (e) => (e as HTMLElement).hidden), true, 'a click elsewhere closes it');
  await chat.page.click('#agentsPill');
  await chat.page.click('#log');
  assert.equal(await chat.page.$eval('#agentsPanel', (e) => (e as HTMLElement).hidden), true, 'a click elsewhere closes agents too');
});

test('tool calls in a row collapse into one live line that expands to every step', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({ busy: true }));
  await chat.send({ type: 'user', text: 'Run the tests', attachments: [] });
  await chat.send({ type: 'assistantStart', provider: 'deepseek', effort: 'flash' });
  await chat.send({ type: 'tool', name: 'Bash', detail: 'npm install' });
  await chat.send({ type: 'tool', name: 'Read', detail: '/Users/me/projects/my-app/package.json', path: '/Users/me/projects/my-app/package.json' });
  await chat.send({ type: 'tool', name: 'Bash', detail: 'npm test' });
  const live = await chat.page.evaluate(() => ({
    groups: document.querySelectorAll('#log .steps').length,
    oldCards: document.querySelectorAll('#log .tool').length,
    live: !!document.querySelector('.steps.live .dots'),
    count: document.querySelector('.steps-count')?.textContent,
    current: document.querySelector('.steps-current')?.textContent,
    listShown: getComputedStyle(document.querySelector('.steps-list')!).display !== 'none',
    typing: !!document.querySelector('#log .typing'),
  }));
  assert.deepEqual(live, { groups: 1, oldCards: 0, live: true, count: '3 steps', current: 'Bashnpm test', listShown: false, typing: false });

  await chat.page.click('.steps-head');
  const open = await chat.page.evaluate(() => ({
    shown: getComputedStyle(document.querySelector('.steps-list')!).display !== 'none',
    steps: [...document.querySelectorAll('.step')].map((e) => e.textContent),
  }));
  assert.deepEqual(open, { shown: true, steps: ['Bashnpm install', 'Readpackage.json', 'Bashnpm test'] });
  await chat.screenshot('steps-open');
  await chat.page.click('.steps-head');
  assert.equal(await chat.page.$eval('.steps-list', (e) => getComputedStyle(e).display), 'none', 'a second click closes it');

  await chat.send({ type: 'delta', text: 'All tests pass.' });
  await chat.send({ type: 'tool', name: 'Bash', detail: 'git status' });
  const after = await chat.page.evaluate(() => ({
    groups: [...document.querySelectorAll('#log .steps')].map((e) => e.classList.contains('live')),
  }));
  assert.deepEqual(after.groups, [false, true], 'text after steps settles them; later steps start a new line');
  await chat.send(stateMessage({ busy: false }));
  assert.equal(await chat.page.$$eval('.steps.live', (e) => e.length), 0, 'nothing animates once the turn ends');
});

test('the Split tab sets how much of today\'s tokens go to each provider', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({ split: null }));
  await chat.page.click('#usage');
  await chat.page.click('.scope-pill[data-scope="split"]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'usageReport').at(-1), { type: 'usageReport', scope: 'today' }, 'the split compares with today');
  const claude = { ...USAGE_SUMMARY.models[0], provider: 'claude', model: 'claude-opus', tokens: 300 };
  const deepseek = { ...USAGE_SUMMARY.models[0], provider: 'deepseek', model: 'deepseek-flash', tokens: 700 };
  await chat.send({ type: 'usageReport', scope: 'today', summary: { ...USAGE_SUMMARY, tokens: 1000, models: [claude, deepseek] }, peakNow: false });
  const off = await chat.page.evaluate(() => ({
    off: !!document.querySelector('.split.off'),
    disabled: (document.querySelector('.split-range') as HTMLInputElement).disabled,
    actual: document.querySelector('.split-actual-head')?.textContent,
  }));
  assert.deepEqual(off, { off: true, disabled: true, actual: 'Today so farClaude 30% · DeepSeek 70% · 1.0k tokens' });

  await chat.page.click('[data-split-toggle]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'setSplit', claude: 50 }, 'turning it on starts even');
  await chat.page.click('[data-split-preset="70"]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'setSplit', claude: 70 });
  await chat.send(stateMessage({ split: 70 }));
  const on = await chat.page.evaluate(() => ({
    claude: document.querySelector('[data-split-claude]')?.textContent,
    deepseek: document.querySelector('[data-split-deepseek]')?.textContent,
    picked: document.querySelector('[data-split-preset].on')?.textContent,
  }));
  assert.deepEqual(on, { claude: '70%', deepseek: '30%', picked: '70 / 30' });
  await chat.screenshot('usage-split');

  // Drag the divider to about a fifth of the way.
  const box = (await (await chat.page.$('.split-bar'))!.boundingBox())!;
  await chat.page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await chat.page.mouse.down();
  await chat.page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 5 });
  assert.equal(await chat.page.$eval('[data-split-claude]', (e) => e.textContent), '20%', 'the labels follow the drag');
  await chat.page.mouse.up();
  assert.deepEqual((await chat.posted()).at(-1), { type: 'setSplit', claude: 20 }, 'saved on release');

  await chat.page.click('[data-split-toggle]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'setSplit', claude: null });
  await chat.page.click('.scope-pill[data-scope="chat"]');
  await chat.page.click('#usage');
});

test('the mic records into the box, sends when the recording ends, and stops when you type', { skip }, async () => {
  await chat.send({ type: 'reset' });
  assert.equal(await chat.page.$eval('#mic', (el) => (el as HTMLElement).hidden), true, 'hidden until the extension says it can dictate');
  await chat.send({ type: 'dictation', state: 'off' });
  const bar = await bottomBarGaps(chat.page);
  assert.deepEqual(bar.ids.slice(-2), ['mic', 'send'], 'the mic sits next to Send');
  assert.equal(bar.overflow, false);

  await chat.page.type('#prompt', 'In billing.ts,');
  await chat.page.click('#mic');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'dictate' });
  await chat.send({ type: 'dictation', state: 'starting' });
  await chat.send({ type: 'dictation', state: 'listening', level: 0 });
  await chat.send({ type: 'dictation', state: 'listening', text: 'fix the rounding' });
  await chat.send({ type: 'dictation', state: 'listening', level: 0.8 });
  const live = await chat.page.evaluate(() => ({
    text: (document.getElementById('prompt') as HTMLTextAreaElement).value,
    state: document.getElementById('mic')!.dataset.state,
    bg: getComputedStyle(document.getElementById('mic')!).backgroundColor,
  }));
  assert.deepEqual({ text: live.text, state: live.state }, { text: 'In billing.ts, fix the rounding', state: 'listening' });
  assert.notEqual(live.bg, 'rgba(0, 0, 0, 0)', 'red while recording');
  await chat.screenshot('dictation');
  await chat.send({ type: 'dictation', state: 'off', send: true });
  assert.deepEqual((await chat.posted()).at(-1), { type: 'send', text: 'In billing.ts, fix the rounding', attachments: [], includeEditor: false, queue: false });

  await chat.send({ type: 'dictation', state: 'starting' });
  await chat.send({ type: 'dictation', state: 'listening', text: 'add a' });
  await chat.page.type('#prompt', ' test');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'dictationCancel' }, 'typing stops it without sending');
  assert.equal(await chat.page.$eval('#prompt', (el) => (el as HTMLTextAreaElement).value), 'add a test');
  await chat.send({ type: 'dictation', state: 'off', problem: 'No sound came from the microphone.' });
  assert.equal(await chat.page.$eval('#mic', (el) => (el as HTMLElement).dataset.state), 'off');
  assert.match(await chat.page.$eval('#log', (el) => el.textContent ?? ''), /No sound came from the microphone/);
  await chat.page.$eval('#prompt', (el) => ((el as HTMLTextAreaElement).value = ''));

  await chat.page.focus('#prompt');
  await chat.page.keyboard.down('Meta');
  await chat.page.keyboard.down('Shift');
  await chat.page.keyboard.press('KeyD');
  await chat.page.keyboard.up('Shift');
  await chat.page.keyboard.up('Meta');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'dictate' }, '⇧⌘D');
});

test('the tune menu: Remote Control with its state, and shortcuts to the Cost and Split tabs', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send({ type: 'remote', state: 'off' });
  const badge = () => chat.page.$eval('#tunePill', (el) => getComputedStyle(el, '::before').content);
  assert.equal(await badge(), 'none', 'no dot while Remote Control is off');
  const labels = () => chat.page.$$eval('#menu .menu-item .label', (els) => els.map((e) => e.textContent));
  await chat.page.click('#tunePill');
  assert.deepEqual(await labels(), ['Phone (Claude app)', 'Cost alerts and limits', 'Split between Claude and DeepSeek']);
  await chat.page.click('#menu .menu-item[data-value="remote"]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'command', command: 'dualAgent.startRemoteControl' });
  assert.equal(await chat.page.$eval('#menu', (el) => (el as HTMLElement).hidden), true, 'the menu closes');

  await chat.send({ type: 'remote', state: 'connected' });
  assert.notEqual(await badge(), 'none', 'a dot on the button once connected');
  await chat.page.click('#tunePill');
  assert.match(await chat.page.$eval('#menu .menu-item[data-value="remote"] .desc', (el) => el.textContent ?? ''), /^Connected/);
  await new Promise((r) => setTimeout(r, 300)); // let the menu's entrance finish
  await chat.screenshot('tune-menu');

  const tab = () => chat.page.$eval('#usagePanel .scope-pill.on', (el) => el.getAttribute('data-scope'));
  await chat.page.click('#menu .menu-item[data-value="cost"]');
  assert.equal(await chat.page.$eval('#usagePanel', (el) => (el as HTMLElement).hidden), false, 'Cost opens the usage panel');
  assert.equal(await tab(), 'cost');
  await chat.page.click('#tunePill');
  await chat.page.click('#menu .menu-item[data-value="split"]');
  assert.equal(await tab(), 'split', 'the Split tab stays in the panel; this is a shortcut to it');
  await chat.page.keyboard.press('Escape');
  await chat.send({ type: 'remote', state: 'off' });
});

test('the Cost tab shows spend against each limit and saves the limits', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.page.click('#usage');
  await chat.page.click('.scope-pill[data-scope="cost"]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'usageReport').at(-1), { type: 'usageReport', scope: 'today' });
  const costs = {
    since: Date.now() - 3_600_000, spent: 8.5, totalLimit: 10, spentToday: 1.2, dailyBudget: 0,
    models: [{ key: 'deepseek-v4-pro', spent: 8.5, limit: 8 }, { key: 'deepseek-flash', spent: 0.4, limit: 0 }],
  };
  await chat.send({ type: 'usageReport', scope: 'today', summary: USAGE_SUMMARY, peakNow: false, costs });
  const shown = await chat.page.evaluate(() => ({
    total: (document.querySelector('[data-cost="total"]') as HTMLInputElement).value,
    daily: (document.querySelector('[data-cost="daily"]') as HTMLInputElement).value,
    near: !!document.querySelector('.cost-limit .mr-bar span.near'),
    over: !!document.querySelector('.cost-model .mr-bar span.over'),
    models: [...document.querySelectorAll('.cost-model .mr-name')].map((e) => e.textContent),
    efficiency: !!document.querySelector('.tool-stats'),
  }));
  assert.deepEqual(shown, { total: '10', daily: '', near: true, over: true, models: ['deepseek-v4-pro', 'deepseek-flash'], efficiency: false });
  await chat.screenshot('usage-cost');

  await chat.page.click('[data-cost-preset="daily:5"]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'setCostLimits', daily: 5 });
  await chat.page.click('[data-cost="total"]', { clickCount: 3 });
  await chat.page.keyboard.type('25');
  await chat.page.keyboard.press('Tab');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'setCostLimits', total: 25 });
  await chat.page.type('[data-cost-new-key]', 'claude-opus');
  await chat.page.type('[data-cost-new-limit]', '20');
  await chat.page.click('[data-cost-add]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'setCostLimits', perModel: { 'deepseek-v4-pro': 8, 'claude-opus': 20 } });
  await chat.page.click('[data-cost-remove="deepseek-v4-pro"]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'setCostLimits', perModel: { 'deepseek-v4-pro': 0 } });
  await chat.page.click('[data-command="dualAgent.resetCostLimits"]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'command', command: 'dualAgent.resetCostLimits' });
  await chat.page.click('.scope-pill[data-scope="chat"]');
  await chat.page.click('#usage');
});

test('the usage panel graphs tokens per 10 minutes by agent and lists each agent\'s tokens', { skip }, async () => {
  // Mid-bucket, so the call 3 minutes ago is in the last bucket whatever the time of day.
  const now = Math.floor(Date.now() / 600_000) * 600_000 + 5 * 60_000;
  const call = (minAgo: number, agent: string, input: number, cacheRead: number) =>
    ({ at: now - minAgo * 60_000, machine: 'm', repo: 'r', provider: 'deepseek' as const, agent, model: agent === 'Main agent' ? 'deepseek-v4-pro' : 'deepseek-flash', billing: 'api' as const, input, cacheRead, cacheWrite: 0, output: 2000 });
  const rows = [
    ...[95, 80, 62, 41, 33, 12, 3].map((m, i) => call(m, 'Main agent', 4000 + i * 900, 60_000 + i * 15_000)),
    ...[70, 66, 50, 44].map((m) => call(m, 'crm-bridge', 3000, 45_000)),
    ...[30, 22].map((m) => call(m, 'quick-helper', 1500, 20_000)),
  ];
  const t = timeline(rows, now);
  await chat.send({ type: 'reset' });
  await chat.page.click('#usage');
  const scope = (await chat.posted()).filter((m: any) => m.type === 'usageReport').at(-1)?.scope;
  await chat.send({ type: 'usageReport', scope, summary: USAGE_SUMMARY, peakNow: false, timeline: t });
  const view = await chat.page.evaluate(() => {
    const p = document.getElementById('usagePanel')!;
    return {
      groups: p.querySelectorAll('.usage-chart g').length,
      tip: p.querySelector('.usage-chart g:last-child title')?.textContent,
      agents: [...p.querySelectorAll('.agent-usage')].map((a) => [a.querySelector('.mr-name')?.textContent, a.querySelector('.mr-detail')?.textContent]),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  assert.equal(view.groups, t.buckets.length);
  assert.match(view.tip ?? '', /tokens · Main agent/);
  assert.deepEqual(view.agents.map((a) => a[0]), ['Main agent', 'crm-bridge', 'quick-helper']);
  assert.match(view.agents[1][1] ?? '', /4 calls/);
  assert.equal(view.overflow, false);
  await new Promise((r) => setTimeout(r, 250));
  await chat.screenshot('usage-graph');
  await chat.page.click('#usage');
});

test('the usage panel shows the efficiency section: speed, tokens per turn, cache, tools, and lean on vs off', { skip }, async () => {
  const turn = (over: Partial<TurnMetrics>): TurnMetrics => ({
    at: 1, machine: 'm', repo: 'r', provider: 'deepseek', effort: 'thinking', lean: true, replyStyle: 'full', outcome: 'done',
    durationMs: 4000, ttftMs: 900, modelCalls: 3, tokens: { input: 2000, cacheRead: 18000, cacheWrite: 0, output: 400 }, cost: 0.002,
    contextPeak: 20000, tools: {}, retries: 0, fallbacks: 0, compactions: 0, ...over,
  });
  const efficiency = summarizeTurns([
    turn({ tools: { mcp__code__code_map: { calls: 1, errors: 0, ms: 40, outChars: 2000 }, Read: { calls: 2, errors: 0, ms: 10, outChars: 6000 } } }),
    turn({ durationMs: 8000, ttftMs: 1100, tools: { Bash: { calls: 2, errors: 1, ms: 3000, outChars: 800 } } }),
    turn({ lean: false, tokens: { input: 5000, cacheRead: 35000, cacheWrite: 0, output: 900 } }),
  ]);
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage());
  await chat.page.click('#usage');
  // Answer for whichever scope the page asked for (it ignores reports for another scope).
  const scope = (await chat.posted()).filter((m: any) => m.type === 'usageReport').at(-1)?.scope;
  await chat.send({ type: 'usageReport', scope, summary: USAGE_SUMMARY, peakNow: false, efficiency });
  const panel = await chat.page.evaluate(() => {
    const p = document.getElementById('usagePanel')!;
    const head = p.querySelector('.eff-head:not(.chart-head)');
    return {
      head: head?.textContent,
      totals: [...p.querySelectorAll('.usage-totals')].slice(1).flatMap((g) => [...g.querySelectorAll('b')].map((b) => b.textContent)),
      tools: [...p.querySelectorAll('.tool-stat:not(.faint) .ts-name')].map((e) => e.textContent),
      failed: p.querySelector('.ts-err')?.textContent,
      notes: [...p.querySelectorAll('.usage-notes')].at(-1)?.textContent,
    };
  });
  assert.equal(panel.head, 'Efficiency3 turns');
  assert.deepEqual(panel.totals, ['4.0s', '900ms', '27k', '89%', '1.7', '3%']);
  assert.deepEqual(panel.tools, ['Read', 'Code map', 'Bash']);
  assert.equal(panel.failed, '50% failed');
  assert.match(panel.notes ?? '', /Lean workflow on: 20k input tokens per turn \(2 turns\); off: 40k \(1 turn\)/);
  assert.match(panel.notes ?? '', /p95 reply 7\.6s · 567 output tokens per turn · 20% of tool calls failed/);
  assert.match(panel.notes ?? '', /Export Metrics/);
  await chat.page.evaluate(() => document.getElementById('usagePanel')!.scrollTo(0, 1e6));
  await new Promise((r) => setTimeout(r, 250));
  await chat.screenshot('usage-efficiency');
  await chat.page.click('#usage');
});

test('the page says it is ready; the welcome screen offers sign-in when no provider is ready, and suggestions once one is', { skip }, async () => {
  assert.ok((await chat.posted()).some((m) => m.type === 'ready'));
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({ claude: { ready: false, detail: 'Not signed in' }, deepseek: { ready: false, detail: 'No API key' } }));
  const off = await chat.page.evaluate(() => ({
    title: document.querySelector('.welcome h1')?.textContent,
    buttons: [...document.querySelectorAll('.welcome [data-command]')].map((b) => b.getAttribute('data-command')),
    suggestions: document.querySelectorAll('.welcome .suggestion').length,
  }));
  assert.deepEqual(off, { title: 'Welcome', buttons: ['dualAgent.signInClaude', 'dualAgent.setDeepSeekKey'], suggestions: 0 });
  await chat.page.click('.welcome [data-command="dualAgent.signInClaude"]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'command', command: 'dualAgent.signInClaude' });

  await chat.send(stateMessage({}));
  assert.match(await chat.page.$eval('.welcome .sub', (el) => el.textContent ?? ''), /my-app/);
  await chat.page.click('.welcome .suggestion');
  assert.equal(await chat.page.$eval('#prompt', (el) => (el as HTMLTextAreaElement).value), 'Explain this codebase', 'a suggestion fills the box');
  await chat.page.$eval('#prompt', (el) => ((el as HTMLTextAreaElement).value = ''));
});

test('the greeting shows only in a started conversation; Thinking shows until the reply streams', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({}));
  await chat.send({ type: 'hello', text: "Hello! You're signed in to Claude." });
  assert.equal(await chat.page.$('.notice.hello'), null, 'not on the welcome screen');
  await chat.send({ type: 'user', text: 'hi', attachments: [] });
  await chat.send({ type: 'hello', text: "Hello! You're signed in to Claude." });
  assert.ok(await chat.page.$('.notice.hello'));

  await chat.send({ type: 'assistantStart', provider: 'claude', effort: 'thinking' });
  assert.equal(await chat.page.$eval('#log .typing .label', (el) => el.textContent), 'Working');
  await chat.send({ type: 'thinking' });
  assert.equal(await chat.page.$eval('#log .typing .label', (el) => el.textContent), 'Thinking');
  await chat.send({ type: 'delta', text: 'Hi there.' });
  assert.equal(await chat.page.$('#log .typing'), null, 'the reply replaces the indicator');
  await chat.send({ type: 'done', summary: 'Claude' });
});

test('a permission card shows the change as a diff, sends the choice back, and shows the verdict once resolved', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({}));
  await chat.send({ type: 'user', text: 'rename it', attachments: [] });
  await chat.send({ type: 'permission', id: 'p1', title: 'Edit src/a.ts', detail: 'Rename total to sum', preview: '- const total = 1;\n+ const sum = 1;\n  unchanged', canAlways: true });
  const card = await chat.page.evaluate(() => ({
    title: document.querySelector('#perm-p1 .title')?.textContent,
    add: document.querySelector('#perm-p1 .diff-add')?.textContent,
    del: document.querySelector('#perm-p1 .diff-del')?.textContent,
    buttons: [...document.querySelectorAll('#perm-p1 [data-decision]')].map((b) => b.getAttribute('data-decision')),
  }));
  assert.deepEqual(card, { title: 'Edit src/a.ts', add: '+ const sum = 1;', del: '- const total = 1;', buttons: ['allow', 'always', 'deny'] });
  await chat.page.click('#perm-p1 [data-decision="always"]');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'permission', id: 'p1', decision: 'always' });
  await chat.send({ type: 'permissionResolved', id: 'p1', decision: 'always' });
  assert.equal(await chat.page.$('#perm-p1 .buttons'), null);
  assert.equal(await chat.page.$eval('#perm-p1 .verdict', (el) => el.textContent), 'Always allowed');

  await chat.send({ type: 'permission', id: 'p2', title: 'Run rm -rf build', detail: '', canAlways: false });
  assert.deepEqual(await chat.page.$$eval('#perm-p2 [data-decision]', (bs) => bs.map((b) => b.getAttribute('data-decision'))), ['allow', 'deny'], 'no Always when it is not offered');
  await chat.page.click('#perm-p2 [data-decision="deny"]');
  await chat.send({ type: 'permissionResolved', id: 'p2', decision: 'deny' });
  assert.equal(await chat.page.$eval('#perm-p2 .verdict', (el) => el.textContent), 'Denied');
});

test('attached files show as chips once each, can be removed, and go with the message; Attach and New chat ask the extension', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({}));
  await chat.page.click('#attach');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'attach' });
  await chat.send({ type: 'attached', files: ['/Users/me/projects/my-app/src/a.ts', '/Users/me/projects/my-app/src/b.ts'] });
  await chat.send({ type: 'attached', files: ['/Users/me/projects/my-app/src/a.ts'] });
  const labels = () => chat.page.$$eval('#chips .chip:not(.editor) .label', (ls) => ls.map((l) => l.textContent));
  assert.deepEqual(await labels(), ['a.ts', 'b.ts'], 'a file attached twice shows once');
  await chat.page.click('#chips [data-remove="0"]');
  assert.deepEqual(await labels(), ['b.ts']);
  await chat.page.type('#prompt', 'review this');
  await chat.page.keyboard.press('Enter');
  const sent = (await chat.posted()).filter((m) => m.type === 'send').at(-1);
  assert.deepEqual(sent.attachments, ['/Users/me/projects/my-app/src/b.ts']);
  await chat.page.click('#newChat');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'newChat' });
});

test('an error with a Diagnose button asks the extension once', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({}));
  await chat.send({ type: 'user', text: 'go', attachments: [] });
  await chat.send({ type: 'notice', level: 'error', text: 'Claude failed after 3 retries.', diagnose: true });
  await chat.page.click('.notice.error .notice-action');
  assert.deepEqual((await chat.posted()).at(-1), { type: 'diagnose' });
  assert.equal(await chat.page.$eval('.notice.error .notice-action', (b) => (b as HTMLButtonElement).disabled), true);
});

test('messages are escaped, not run as HTML', { skip }, async () => {
  await chat.send({ type: 'user', text: '<img src=x onerror="window.__pwned=1">', attachments: [] });
  await chat.send({ type: 'assistantStart', provider: 'deepseek', effort: 'thinking' });
  await chat.send({ type: 'delta', text: 'Try `<b>x</b>`:\n```js\nconst a = "<script>";\n```' });
  const r = await chat.page.evaluate(() => ({
    pwned: (window as any).__pwned,
    imgs: document.querySelectorAll('#log img').length,
    code: document.querySelector('.msg.assistant pre code')?.textContent,
  }));
  assert.equal(r.pwned, undefined);
  assert.equal(r.imgs, 0);
  assert.equal(r.code, 'const a = "<script>";\n');
  await chat.send({ type: 'done', summary: 'DeepSeek · 10 in / 5 out tokens · 0.1s' });
  await chat.screenshot('conversation');
});

test('replies render file links, tables, nested lists, quotes and rules; code spans stay literal; odd schemes stay text', { skip }, async () => {
  await chat.send(stateMessage({}));
  await chat.send({ type: 'assistantStart', provider: 'claude', effort: 'thinking' });
  await chat.send({
    type: 'delta',
    text: [
      'See [server.ts:421](src/proxy/server.ts#L421), [docs](https://example.com) and [x](javascript:alert(1)).',
      'Keep `**not bold**` and ~~old~~.',
      '| File | Change |',
      '|---|---|',
      '| `a.ts` | **new** |',
      '- top',
      '  - nested',
      '> quoted',
      '> on two lines',
      '---',
      '##### Small heading',
    ].join('\n'),
  });
  await chat.send({ type: 'done', summary: 'Claude' });
  const r = await chat.page.evaluate(() => {
    const m = document.querySelectorAll('.msg.assistant');
    const reply = m[m.length - 1];
    const file = reply.querySelector('a[data-open]');
    return {
      open: file?.getAttribute('data-open'),
      line: file?.getAttribute('data-line'),
      web: reply.querySelector('a[href]')?.getAttribute('href'),
      links: reply.querySelectorAll('a').length,
      code: reply.querySelector('p:nth-of-type(2) code')?.textContent,
      del: reply.querySelector('del')?.textContent,
      cells: [...reply.querySelectorAll('th, td')].map((c) => c.innerHTML),
      nested: reply.querySelector('ul > li > ul > li')?.textContent,
      quote: reply.querySelector('blockquote')?.innerHTML,
      hr: !!reply.querySelector('hr'),
      h6: reply.querySelector('h6')?.textContent,
      text: reply.textContent,
    };
  });
  assert.equal(r.open, '/Users/me/projects/my-app/src/proxy/server.ts', 'project-relative links open the file');
  assert.equal(r.line, '421');
  assert.equal(r.web, 'https://example.com');
  assert.equal(r.links, 2, 'a javascript: link is not made a link');
  assert.equal(r.code, '**not bold**');
  assert.equal(r.del, 'old');
  assert.deepEqual(r.cells, ['File', 'Change', '<code>a.ts</code>', '<strong>new</strong>']);
  assert.equal(r.nested, 'nested');
  assert.equal(r.quote, 'quoted<br>on two lines');
  assert.equal(r.hr, true);
  assert.equal(r.h6, 'Small heading');
  assert.doesNotMatch(r.text ?? '', /\]\(|\|---|&gt;/, 'no raw markdown left');
  await chat.page.click('.msg.assistant a[data-open]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'openFile').at(-1), { type: 'openFile', path: '/Users/me/projects/my-app/src/proxy/server.ts', line: 421 });
  await chat.screenshot('markdown');
});

test('agent descriptions and summaries render markdown (headings, code, table, list, link) and escape raw HTML', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({}));
  await chat.send({
    type: 'agents',
    tokens: 0,
    plan: [],
    agents: [
      run('helper_1', {
        name: 'quick-helper',
        description: [
          '## What I did',
          'Wrote the parser in `parser.ts`.',
          '',
          '```ts',
          'const x = "<b>raw</b>";',
          '```',
          '',
          '| Item | Count |',
          '|---|---|',
          '| files | **3** |',
          '',
          '- first',
          '- second',
          '',
          'See [docs](https://example.com).',
        ].join('\n'),
        summary: 'Done: **3** files and a [link](https://example.org).',
      }),
    ],
  });
  await chat.page.click('#agentsPill');
  const d = await chat.page.evaluate(() => {
    const desc = document.querySelector('[data-agent="helper_1"] .ac-desc')!;
    const summary = document.querySelector('[data-agent="helper_1"] .ac-summary')!;
    return {
      h: desc.querySelector('h4')?.textContent,
      code: desc.querySelector('pre code')?.textContent,
      cells: [...desc.querySelectorAll('th, td')].map((c) => c.textContent),
      li: [...desc.querySelectorAll('ul > li')].map((c) => c.textContent),
      link: desc.querySelector('a[href]')?.getAttribute('href'),
      raw: !!desc.querySelector('b'),
      strong: summary.querySelector('strong')?.textContent,
      sumLink: summary.querySelector('a[href]')?.getAttribute('href'),
    };
  });
  assert.equal(d.h, 'What I did');
  assert.equal(d.code?.trim(), 'const x = "<b>raw</b>";');
  assert.deepEqual(d.cells, ['Item', 'Count', 'files', '3']);
  assert.deepEqual(d.li, ['first', 'second']);
  assert.equal(d.link, 'https://example.com');
  assert.equal(d.raw, false, 'raw HTML in a code fence is not parsed');
  assert.equal(d.strong, '3');
  assert.equal(d.sumLink, 'https://example.org');
  await chat.screenshot('agent-markdown');
  // The panel stays open across a reset: close it so the next test's click opens it.
  await chat.page.click('#agentsPill');
});

test('quiet warnings go to a Warnings list under the agents panel, repeats counted; other warnings stay in the chat', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({}));
  const net = 'Network: requests to api.anthropic.com are failing (ETIMEDOUT).';
  await chat.send({ type: 'notice', level: 'warn', quiet: true, text: net });
  await chat.send({ type: 'notice', level: 'warn', quiet: true, text: 'Claude request failed (the connection to it timed out); retrying…' });
  await chat.send({ type: 'notice', level: 'warn', quiet: true, text: net });
  await chat.send({ type: 'notice', level: 'warn', text: 'Nearing a cost limit: $8 of $10.' });
  const before = await chat.page.evaluate(() => ({
    log: document.getElementById('log')?.textContent ?? '',
    pill: document.querySelector('#agentsPill .warn-badge')?.textContent,
  }));
  assert.doesNotMatch(before.log, /Network: requests|retrying/, 'quiet warnings stay out of the conversation');
  assert.match(before.log, /Nearing a cost limit/);
  assert.match(before.pill ?? '', /⚠ 2/);
  await chat.page.click('#agentsPill');
  await chat.page.click('.ap-warnings summary');
  const list = await chat.page.$$eval('.ap-warnings li', (lis) => lis.map((li) => li.textContent));
  assert.equal(list.length, 2);
  assert.match(list[0] ?? '', /Network: requests.*×2$/, 'newest first, a repeat counted');
  await chat.send({ type: 'agents', agents: [], plan: [], tokens: 0 });
  assert.equal(await chat.page.$eval('.ap-warnings', (d) => (d as HTMLDetailsElement).open), true, 'stays open across redraws');
  await chat.screenshot('warnings');
  await chat.page.click('#agentsPill');
  await chat.send({ type: 'reset' });
  assert.equal(await chat.page.$eval('#agentsPill .warn-badge', (el) => (el as HTMLElement).hidden), true, 'a new chat starts without warnings');
});

test('a saved chat is redrawn from history', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send({
    type: 'restore',
    messages: [
      { type: 'user', text: 'How is the build set up?', attachments: [], editor: EDITOR },
      { type: 'assistantStart', provider: 'claude', effort: 'thinking' },
      { type: 'tool', name: 'Read', detail: '/Users/me/projects/my-app/package.json', path: '/Users/me/projects/my-app/package.json' },
      { type: 'delta', text: 'It uses **tsc**.' },
      { type: 'usage', usage: { input: 1200, output: 80, context: 1300, cost: 0 } },
      { type: 'done', summary: 'Claude · 1,200 in / 80 out tokens · 2.0s' },
    ],
  });
  const r = await chat.page.evaluate(() => ({
    welcome: !!document.querySelector('.welcome'),
    user: document.querySelector('.msg.user')?.textContent,
    chip: document.querySelector('.msg-attachments .chip')?.textContent,
    tool: document.querySelector('.steps .step .tool-name')?.textContent,
    live: !!document.querySelector('.steps.live'),
    reply: document.querySelector('.msg.assistant')?.innerHTML,
    summary: document.querySelector('.summary')?.textContent,
    typing: !!document.querySelector('#log .typing'),
    usage: document.getElementById('usageLabel')?.textContent,
  }));
  assert.equal(r.welcome, false);
  assert.equal(r.user, 'How is the build set up?');
  assert.equal(r.chip, 'agentController.tsL12–30');
  assert.equal(r.tool, 'Read');
  assert.equal(r.live, false, 'a restored step group does not animate');
  assert.equal(r.reply, '<p>It uses <strong>tsc</strong>.</p>');
  assert.match(r.summary ?? '', /^Claude · /);
  assert.equal(r.typing, false, 'no leftover "working" indicator');
  assert.equal(r.usage, '1.3k');
  await chat.screenshot('restored-chat');
});

const REPLY = [
  'Here is what changed:',
  '',
  '- `src/a.ts`: the **parser** now keeps line numbers',
  '  - nested: [notes](src/notes.md#L4)',
  '1. first',
  '2. second',
  '',
  '| File | Lines |',
  '|---|---|',
  '| a.ts | 120 |',
  '| b.ts | 48 |',
  '',
  '```ts',
  'export function parse(s: string) {',
  '  return s.split("\\n");',
  '}',
  '```',
  '',
  '> Tests pass.',
].join('\n');

/** A saved chat shaped like a real long one: per turn, text, tool steps, cards and a summary (20 entries). */
function longTranscript(turns: number) {
  const out: Record<string, unknown>[] = [];
  const tool = (i: number) => ({ type: 'tool', name: ['Read', 'Grep', 'Edit', 'Bash'][i % 4], detail: `/Users/me/projects/my-app/src/file${i}.ts`, path: `/Users/me/projects/my-app/src/file${i}.ts` });
  for (let t = 0; t < turns; t++) {
    out.push(
      { type: 'user', text: `Step ${t}: fix the parser and add **tests**`, attachments: [], editor: EDITOR },
      { type: 'assistantStart', provider: t % 2 ? 'deepseek' : 'claude', effort: 'thinking' },
      { type: 'delta', text: 'Looking at the parser first.' },
      ...[0, 1, 2, 3, 4, 5].map(tool),
      { type: 'delta', text: REPLY },
      ...[6, 7, 8, 9, 10].map(tool),
      { type: 'permissionResolved', id: `p${t}`, decision: 'allow' },
      t % 2
        ? { type: 'questionResolved', id: `q${t}`, questions: [QUESTIONS[0]], answers: { 'Which color should the button be?': 'Red' }, skipped: false }
        : { type: 'planResolved', id: `pl${t}`, plan: '1. Read\n2. Fix\n3. Test', approved: true },
      { type: 'notice', level: 'warn', text: 'The build took longer than usual.' },
      { type: 'delta', text: 'Done.' },
      { type: 'done', summary: 'Claude · 1,200 in / 80 out tokens · 2.0s' },
    );
  }
  return out;
}

test('restoring a 2,000-entry chat reads no layout per entry, scrolls once, and beats a live replay', { skip }, async (t) => {
  const messages = longTranscript(100);
  assert.equal(messages.length, 2000);
  await chat.send({ type: 'reset' });
  // Best of three, timed in the page so the message hop isn't counted. Live replays the same
  // entries as if streamed, reading layout per entry: the restore path before 3.1.
  const time = (restore: boolean) =>
    chat.page.evaluate((m, restore) => {
      const handle = (window as any).handleMessage;
      const t0 = performance.now();
      if (restore) {
        handle({ type: 'restore', messages: m });
      } else {
        handle({ type: 'reset' });
        m.forEach(handle);
        void document.getElementById('log')!.scrollHeight;
      }
      return performance.now() - t0;
    }, messages, restore);
  const best = async (restore: boolean) => Math.min(await time(restore), await time(restore), await time(restore));
  const live = await best(false);
  const ms = await best(true);
  t.diagnostic(`restore of ${messages.length} entries: ${ms.toFixed(0)} ms; live replay: ${live.toFixed(0)} ms`);

  const r = await chat.page.evaluate((m) => {
    const log = document.getElementById('log')!;
    const get = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!.get!;
    let reads = 0;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => (reads++, get.call(log)) });
    (window as any).handleMessage({ type: 'restore', messages: m });
    delete (log as any).scrollHeight;
    return { reads, users: log.querySelectorAll('.msg.user').length, atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 2 };
  }, messages);
  assert.equal(r.users, 100);
  assert.equal(r.reads, 1, 'one layout read: the final scroll');
  assert.ok(r.atBottom, 'the restored chat opens at its end');
  // Generous: the target is 5x; headless timings vary.
  assert.ok(ms < live / 2, `restore ${ms.toFixed(0)} ms should be well under the live replay's ${live.toFixed(0)} ms`);
  await chat.send({ type: 'reset' });
});

test('off-screen messages skip rendering; the streaming reply always renders; a restored chat stays at its end', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send({ type: 'restore', messages: longTranscript(10) });
  await chat.send({ type: 'assistantStart', provider: 'claude', effort: 'thinking' });
  await chat.send({ type: 'delta', text: REPLY });
  const r = await chat.page.evaluate(() => {
    const log = document.getElementById('log')!;
    const cv = (el: Element | null) => (el ? getComputedStyle(el).contentVisibility : '');
    return {
      first: cv(log.firstElementChild),
      last: cv(log.lastElementChild),
      streaming: log.lastElementChild?.classList.contains('assistant'),
      atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 80,
    };
  });
  assert.equal(r.first, 'auto');
  assert.equal(r.streaming, true);
  assert.equal(r.last, 'visible', 'the reply being streamed is never skipped');
  assert.ok(r.atBottom, 'still at the end after estimated heights become real ones');
  await chat.send({ type: 'done', summary: 'Claude · 1 in / 1 out tokens · 1.0s' });
  await chat.send({ type: 'reset' });
});

const STREAM_FIXTURES = [
  REPLY,
  'Intro\n\n- a\n- b\n  - nested\n    1. deep\n\n- after a gap\n1. one\n2. two\n\n\n\nAfter.',
  '| A | B |\n|---|---|\n| 1 | 2 |\n\nText\n| C |\n|---|\n| 3 |\n\n| not | a table |',
  '````md\n```js\nx\n\n```\n````\n\nAfter\n\n```\n\ncode with a blank line\n\n```\n\nEnd ``` inline\n\nstill',
  'Start\n\n```py\nprint(1)\n\nprint(2)\n',
  '> a\n\n> b\n  \n\n> c\n\nText\n\n> d',
  '# Title\n\n---\n\n**bold** and `code\n\nspan`\n\n***\n\nlast *one*',
];

test('a streamed reply renders the same HTML as the whole text, however it is chunked', { skip }, async () => {
  await chat.send({ type: 'reset' });
  const r = await chat.page.evaluate((fixtures) => {
    const w = window as any;
    const bad: string[] = [];
    let froze = 0;
    // Compared as parsed HTML: the renderer leaves <li> for the parser to close.
    const whole = document.createElement('div');
    for (const [f, text] of fixtures.entries()) {
      // Size 1 and 2 split every fence across chunks.
      for (const size of [1, 2, 3, 7, 40, text.length]) {
        w.handleMessage({ type: 'assistantStart', provider: 'claude', effort: 'thinking' });
        for (let i = 0; i < text.length; i += size) {
          w.handleMessage({ type: 'delta', text: text.slice(i, i + size) });
          w.renderCurrent();
          const bubble = document.querySelector('#log .msg.assistant:last-of-type')!;
          whole.innerHTML = w.renderMarkdown(text.slice(0, i + size));
          if (bubble.innerHTML !== whole.innerHTML) {
            bad.push(`fixture ${f}, chunks of ${size}, at ${i + size}`);
            break;
          }
        }
        w.handleMessage({ type: 'done', summary: '' });
      }
      froze += w.frozenEnd(text, 0) > 0 ? 1 : 0;
    }
    return { bad, froze };
  }, STREAM_FIXTURES);
  assert.deepEqual(r.bad, []);
  assert.equal(r.froze, STREAM_FIXTURES.length, 'every fixture has a finished part to keep');
  await chat.send({ type: 'reset' });
});

test('a selection in the finished part of a streaming reply survives the next frame', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send({ type: 'assistantStart', provider: 'claude', effort: 'thinking' });
  await chat.send({ type: 'delta', text: 'First paragraph to copy.\n\nSecond' });
  await chat.page.evaluate(() => {
    const p = document.querySelector('#log .msg.assistant p')!;
    (window as any).__p = p;
    const range = document.createRange();
    range.selectNodeContents(p);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await chat.send({ type: 'delta', text: ' paragraph, still streaming' });
  await chat.send({ type: 'delta', text: '.\n\nThird.' });
  const r = await chat.page.evaluate(() => ({
    selected: getSelection()!.toString(),
    same: document.querySelector('#log .msg.assistant p') === (window as any).__p,
    paras: [...document.querySelectorAll('#log .msg.assistant p')].map((p) => p.textContent),
  }));
  assert.equal(r.selected, 'First paragraph to copy.');
  assert.equal(r.same, true, 'the finished paragraph is the same node');
  assert.deepEqual(r.paras, ['First paragraph to copy.', 'Second paragraph, still streaming.', 'Third.']);
  await chat.send({ type: 'done', summary: '' });
  await chat.send({ type: 'reset' });
});

test('the history menu lists this repo\'s chats and opens one', { skip }, async () => {
  const now = Date.now();
  await chat.send({
    type: 'history',
    current: 'b',
    items: [
      { id: 'b', title: 'How is the build set up?', updatedAt: now - 30_000, messages: 1 },
      { id: 'a', title: 'Fix the flaky login test', updatedAt: now - 3 * 3600_000, messages: 4 },
    ],
  });
  await chat.page.click('#historyBtn');
  const menu = await chat.page.evaluate(() => ({
    title: document.querySelector('.menu-title')?.textContent,
    items: [...document.querySelectorAll('.menu-item')].map((i) => [
      i.getAttribute('data-value'),
      i.querySelector('.label')?.textContent,
      i.querySelector('.desc')?.textContent,
    ]),
    selected: document.querySelector('.menu-item.selected')?.getAttribute('data-value'),
  }));
  assert.equal(menu.title, 'Chats in this repo');
  assert.deepEqual(menu.items, [
    ['b', 'How is the build set up?', 'just now · 1 message'],
    ['a', 'Fix the flaky login test', '3 h ago · 4 messages'],
    ['__clear__', 'Clear history', "Delete this repo's saved chats."],
  ]);
  assert.equal(menu.selected, 'b');
  await new Promise((r) => setTimeout(r, 250)); // let the menu finish popping in
  await chat.screenshot('history-menu');
  await chat.page.click('.menu-item[data-value="a"]');
  assert.deepEqual((await chat.posted()).filter((m) => m.type === 'openChat').at(-1), { type: 'openChat', id: 'a' });

  await chat.page.click('#historyBtn');
  await chat.page.click('.menu-item[data-value="__clear__"]');
  assert.equal((await chat.posted()).at(-1).type, 'clearHistory');

  await chat.send({ type: 'history', items: [] });
  await chat.page.click('#historyBtn');
  assert.equal(await chat.page.$eval('.menu-title', (el) => el.textContent), 'No saved chats in this repo yet');
  await chat.page.keyboard.press('Escape');
});

test('a narrow sidebar keeps everything on screen', { skip }, async () => {
  const narrow = await openChatPage(280, 600);
  try {
    await narrow.send(stateMessage({ editor: { ...EDITOR, name: 'a-very-long-file-name-for-testing.component.tsx' } }));
    const overflow = await narrow.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
    const bar = await bottomBarGaps(narrow.page);
    assert.equal(bar.overflow, false, 'the bottom bar fits');
    assert.ok(bar.gaps.every((g) => Math.abs(g - 6) <= 0.5), `pill gaps when narrow: ${bar.gaps.map((g) => g.toFixed(1)).join(', ')}`);
    assert.ok(bar.sendAtRight && bar.firstOffset <= 0.5);
    const title = await narrow.page.$eval('.brand-name', (el) => ({ h: (el as HTMLElement).offsetHeight, cut: el.scrollWidth > el.clientWidth }));
    assert.ok(title.h < 24, `the title wrapped (${title.h}px tall)`);
    assert.equal(title.cut, false, 'the title fits without being cut off');
    await narrow.screenshot('narrow');
    await narrow.send(TROUBLE);
    await narrow.page.click('#agentsPill');
    await narrow.page.click('[data-pick-agent="crm-bridge"]');
    const agentsOverflow = await narrow.page.evaluate(() => {
      const p = document.getElementById('agentsPanel')!;
      return { page: document.documentElement.scrollWidth - window.innerWidth, panel: p.scrollWidth - p.clientWidth };
    });
    assert.deepEqual(agentsOverflow, { page: 0, panel: 0 }, 'agent pills and tasks fit a narrow sidebar');
    assert.equal((await bottomBarGaps(narrow.page)).overflow, false, 'the agents pill label fits');
    await new Promise((r) => setTimeout(r, 250));
    await narrow.screenshot('agents-pills-narrow');
  } finally {
    await narrow.close();
  }
});

test('the usage pill counts new tokens, and dollars when showCostInChat is on; cache re-reads and the burn rate are in its tooltip', { skip }, async () => {
  const usage = { input: 56_400_000, output: 600_000, context: 98_000, cost: 0, estimate: 20.92, fresh: 3_812_000, cacheRead: 53_188_000, burn: { tokens: 412_000, cost: 1.2 } };
  const label = () => chat.page.evaluate(() => document.getElementById('usageLabel')?.textContent);
  await chat.send({ type: 'usage', usage });
  assert.equal(await label(), '3.81M', 'cost is hidden by default');
  await chat.send({ type: 'usage', usage: { ...usage, showCost: true } });
  const r = await chat.page.evaluate(() => ({ label: document.getElementById('usageLabel')?.textContent, title: document.getElementById('usage')?.title }));
  assert.equal(r.label, '3.81M · $20.92');
  assert.match(r.title ?? '', /Cache re-reads: 53,188,000 \(93% of all 57,000,000 tokens/);
  assert.match(r.title ?? '', /Last 10 minutes: 412k new tokens · \$1\.20/);
  assert.match(r.title ?? '', /Context now: 98,000/);
});

test('no progress strip above the composer: run tokens and time show in the message', { skip }, async () => {
  await chat.send({ type: 'reset' });
  await chat.send(stateMessage({ busy: true }));
  await chat.send({ type: 'usage', usage: { input: 251_000, output: 4000, context: 0, cost: 0, estimate: 0.95 } });
  await chat.send({ type: 'activity', text: 'Reading files' });
  assert.equal(await chat.page.evaluate(() => document.querySelector('#progress, .progress, .pg-row')), null);
  await chat.send(stateMessage({ busy: false }));
});

test('the packaged page loads one script and one stylesheet and styles everything as the separate files do', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-agent-media-'));
  const { joinMedia } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'bundle.mjs')).toString());
  joinMedia(dir);
  fs.copyFileSync(path.join(ROOT, 'media', 'logo.svg'), path.join(dir, 'logo.svg'));
  // One page at a time: a page in the background gets no animation frames.
  const look = async (mediaDir?: string) => {
    const p = await openChatPage(420, 720, mediaDir);
    try {
      await p.send(stateMessage({ editor: EDITOR }));
      return await p.page.evaluate(() => {
        // Transitions still running would differ by a frame.
        for (const a of document.getAnimations()) {
          try {
            a.finish();
          } catch {
            a.cancel();
          }
        }
        const style = (sel: string) => {
          const cs = getComputedStyle(document.querySelector(sel)!);
          return Object.fromEntries([...cs].map((k) => [k, cs.getPropertyValue(k)]));
        };
        return {
          files: document.querySelectorAll('script[src], link[rel=stylesheet]').length,
          rules: [...document.styleSheets].reduce((n, s) => n + s.cssRules.length, 0),
          styles: ['body', '.topbar', '#composer', '#prompt', '#send'].map(style),
        };
      });
    } finally {
      await p.close();
    }
  };
  try {
    const separate = await look();
    const joined = await look(dir);
    assert.equal(separate.files, 16);
    assert.equal(joined.files, 2);
    assert.equal(joined.rules, separate.rules);
    assert.deepEqual(joined.styles, separate.styles);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// @ts-check
/** Question cards and plan approval. */
// ---------- Questions and plan approval ----------

/** Answers for one question card: the chosen options per question, and any typed answer. */
function askAnswer(q, picked, otherText) {
  const labels = [...picked].filter((i) => i !== 'other').sort().map((i) => q.options[i].label);
  if (picked.has('other') && otherText.trim()) {
    labels.push(otherText.trim());
  }
  return labels.join(', ');
}

function renderQuestionCard(msg) {
  endBubble();
  hideTyping();
  const many = msg.questions.length > 1;
  const last = msg.questions.length - 1;
  // Several questions: one card, a tab per question, one question showing at a time.
  const tabs = many
    ? `<div class="ask-tabs" role="tablist">` +
      msg.questions
        .map(
          (q, qi) =>
            `<button class="ask-tab" role="tab" data-tab="${qi}" id="ask-${msg.id}-t${qi}" aria-controls="ask-${msg.id}-p${qi}">` +
            `<span class="ask-tab-mark"></span><span class="ask-tab-label">${escapeHtml(q.header || `Question ${qi + 1}`)}</span></button>`,
        )
        .join('') +
      `</div>`
    : '';
  const html =
    `<div class="ask-head">${ICON('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>')}` +
    `<span class="ask-title">${many ? `${msg.questions.length} questions for you` : 'A question for you'}</span>` +
    (many ? `<span class="ask-progress"></span>` : '') +
    `</div>` +
    tabs +
    msg.questions
      .map(
        (q, qi) =>
          `<div class="ask-q" data-q="${qi}"${many ? ` role="tabpanel" id="ask-${msg.id}-p${qi}" aria-labelledby="ask-${msg.id}-t${qi}"` : ''}>` +
          `<div class="ask-qhead"><span class="ask-chip">${escapeHtml(q.header)}</span>${q.multiSelect ? '<span class="ask-hint">Choose any</span>' : ''}</div>` +
          `<div class="ask-text">${escapeHtml(q.question)}</div>` +
          `<div class="ask-options" role="${q.multiSelect ? 'group' : 'radiogroup'}">` +
          q.options
            .map(
              (o, oi) =>
                `<button class="ask-opt${q.multiSelect ? ' multi' : ''}" data-q="${qi}" data-o="${oi}" role="${q.multiSelect ? 'checkbox' : 'radio'}" aria-checked="false">` +
                `<span class="ask-mark"></span><span class="ask-opt-text"><span class="ask-label">${escapeHtml(o.label)}</span>` +
                (o.description ? `<span class="ask-desc">${escapeHtml(o.description)}</span>` : '') +
                `</span></button>`,
            )
            .join('') +
          `<button class="ask-opt other${q.multiSelect ? ' multi' : ''}" data-q="${qi}" data-o="other" role="${q.multiSelect ? 'checkbox' : 'radio'}" aria-checked="false">` +
          `<span class="ask-mark"></span><span class="ask-opt-text"><span class="ask-label">Other…</span><span class="ask-desc">Type your own answer</span></span></button>` +
          `</div>` +
          `<input class="ask-other-input" data-q="${qi}" type="text" placeholder="Your answer" hidden>` +
          `<pre class="ask-preview" data-q="${qi}" hidden></pre>` +
          `</div>`,
      )
      .join('') +
    `<div class="buttons">` +
    (many ? `<button class="btn" data-ask-back>Back</button><button class="btn" data-ask-next>Next</button>` : '') +
    `<button class="btn primary" data-ask-send disabled>Send ${many ? 'answers' : 'answer'}</button>` +
    `<button class="btn" data-ask-skip>Skip</button></div>`;
  const card = add(many ? 'ask-card tabbed' : 'ask-card', html);
  card.id = `ask-${msg.id}`;

  const picked = msg.questions.map(() => new Set());
  const other = msg.questions.map(() => '');
  const sendBtn = /** @type {HTMLButtonElement} */ (card.querySelector('[data-ask-send]'));
  const backBtn = /** @type {HTMLButtonElement | null} */ (card.querySelector('[data-ask-back]'));
  const nextBtn = /** @type {HTMLButtonElement | null} */ (card.querySelector('[data-ask-next]'));
  const answered = (qi) => !!askAnswer(msg.questions[qi], picked[qi], other[qi]) && (!picked[qi].has('other') || !!other[qi].trim());
  /** Shows question `i`'s tab and hides the others. */
  const show = (i, focus = false) => {
    if (!many) {
      return;
    }
    card.querySelectorAll('.ask-q').forEach((p) => (/** @type {HTMLElement} */ (p).hidden = Number(p.getAttribute('data-q')) !== i));
    card.querySelectorAll('.ask-tab').forEach((t) => {
      const on = Number(t.getAttribute('data-tab')) === i;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
      /** @type {HTMLElement} */ (t).tabIndex = on ? 0 : -1;
      if (on && focus) {
        /** @type {HTMLElement} */ (t).focus();
      }
    });
    backBtn.hidden = i === 0;
    nextBtn.hidden = i === last;
    active = i;
  };
  let active = 0;
  const refresh = () => {
    card.querySelectorAll('.ask-opt').forEach((b) => {
      const qi = Number(b.getAttribute('data-q'));
      const o = b.getAttribute('data-o');
      const on = picked[qi].has(o === 'other' ? 'other' : Number(o));
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    });
    msg.questions.forEach((q, qi) => {
      const input = /** @type {HTMLInputElement} */ (card.querySelector(`.ask-other-input[data-q="${qi}"]`));
      input.hidden = !picked[qi].has('other');
    });
    // Every question needs a choice, and a ticked "Other" needs its text.
    sendBtn.disabled = !msg.questions.every((_, qi) => answered(qi));
    if (many) {
      card.querySelectorAll('.ask-tab').forEach((t) => t.classList.toggle('done', answered(Number(t.getAttribute('data-tab')))));
      card.querySelector('.ask-progress').textContent = `${msg.questions.filter((_, qi) => answered(qi)).length} of ${msg.questions.length} answered`;
    }
  };
  card.querySelectorAll('.ask-tab').forEach((t) => {
    t.addEventListener('click', () => show(Number(t.getAttribute('data-tab'))));
    t.addEventListener('keydown', (e) => {
      const key = /** @type {KeyboardEvent} */ (e).key;
      if (key === 'ArrowRight' || key === 'ArrowLeft') {
        e.preventDefault();
        show((active + (key === 'ArrowRight' ? 1 : last)) % (last + 1), true);
      }
    });
  });
  backBtn?.addEventListener('click', () => show(Math.max(0, active - 1)));
  nextBtn?.addEventListener('click', () => show(Math.min(last, active + 1)));
  card.querySelectorAll('.ask-opt').forEach((b) =>
    b.addEventListener('click', () => {
      const qi = Number(b.getAttribute('data-q'));
      const q = msg.questions[qi];
      const o = b.getAttribute('data-o');
      const key = o === 'other' ? 'other' : Number(o);
      if (q.multiSelect) {
        picked[qi].has(key) ? picked[qi].delete(key) : picked[qi].add(key);
      } else {
        picked[qi] = new Set([key]);
      }
      const preview = /** @type {HTMLElement} */ (card.querySelector(`.ask-preview[data-q="${qi}"]`));
      const opt = key === 'other' ? undefined : q.options[key];
      preview.hidden = !opt?.preview;
      preview.textContent = opt?.preview ?? '';
      refresh();
      if (key === 'other' && picked[qi].has('other')) {
        /** @type {HTMLInputElement} */ (card.querySelector(`.ask-other-input[data-q="${qi}"]`)).focus();
      }
    }),
  );
  card.querySelectorAll('.ask-other-input').forEach((input) => {
    input.addEventListener('input', () => {
      other[Number(input.getAttribute('data-q'))] = /** @type {HTMLInputElement} */ (input).value;
      refresh();
    });
    input.addEventListener('keydown', (e) => {
      if (/** @type {KeyboardEvent} */ (e).key === 'Enter' && !sendBtn.disabled) {
        sendBtn.click();
      }
    });
  });
  show(0);
  refresh();
  sendBtn.addEventListener('click', () => {
    const answers = {};
    msg.questions.forEach((q, qi) => (answers[q.question] = askAnswer(q, picked[qi], other[qi])));
    card.classList.add('sending');
    vscode.postMessage({ type: 'answer', id: msg.id, answers });
  });
  card.querySelector('[data-ask-skip]').addEventListener('click', () => {
    card.classList.add('sending');
    vscode.postMessage({ type: 'answer', id: msg.id, skipped: true });
  });
  scroll(true);
}

/** An answered (or skipped) question card, also used when a saved chat is reopened. */
function resolveQuestionCard(msg) {
  const summary =
    `<div class="ask-head">${ICON('<path d="M20 6 9 17l-5-5"/>')}<span class="ask-title">${msg.skipped ? 'Question skipped' : 'You answered'}</span></div>` +
    msg.questions
      .map(
        (q) =>
          `<div class="ask-sum"><span class="ask-chip">${escapeHtml(q.header)}</span><span class="ask-sum-q">${escapeHtml(q.question)}</span>` +
          (msg.answers?.[q.question] ? `<span class="ask-sum-a">${escapeHtml(msg.answers[q.question])}</span>` : '') +
          `</div>`,
      )
      .join('');
  const card = document.getElementById(`ask-${msg.id}`);
  if (card) {
    card.className = `ask-card resolved${msg.skipped ? ' skipped' : ''}`;
    card.innerHTML = summary;
  } else {
    add(`ask-card resolved${msg.skipped ? ' skipped' : ''}`, summary);
  }
  if (busy) {
    showTyping('Working');
  }
}

/**
 * Splits a plan's Markdown into the text before its first list, that list's top-level items
 * (nested items and indented lines fold into their parent), and the text after it.
 */
function parsePlanSteps(md) {
  const lines = String(md).split('\n');
  const steps = [];
  let start = -1;
  let end = -1;
  let base = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      if (start >= 0) {
        break;
      }
      fence = !fence;
      continue;
    }
    const m = fence ? null : /^(\s*)(?:\d+[.)]|[-*+])\s+(\S.*)$/.exec(line);
    if (m) {
      const indent = m[1].replace(/\t/g, '    ').length;
      if (start < 0) {
        start = i;
        base = indent;
      }
      if (indent <= base) {
        steps.push(m[2].trim());
      } else {
        steps[steps.length - 1] += `; ${m[2].trim()}`;
      }
      end = i;
    } else if (start >= 0 && line.trim()) {
      if (!/^\s/.test(line)) {
        break;
      }
      steps[steps.length - 1] += ` ${line.trim()}`;
      end = i;
    }
  }
  if (!steps.length) {
    return { intro: String(md), steps, outro: '' };
  }
  return { intro: lines.slice(0, start).join('\n'), steps, outro: lines.slice(end + 1).join('\n') };
}

const STEP_BTNS = [
  ['up', 'Move up', '<path d="m18 15-6-6-6 6"/>'],
  ['down', 'Move down', '<path d="m6 9 6 6 6-6"/>'],
  ['del', 'Delete', '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'],
];

/** One editable plan step; its buttons are labelled with the step's number by `renumberSteps`. */
function planStepRow(text) {
  const row = document.createElement('li');
  row.className = 'plan-step';
  row.innerHTML =
    `<input class="plan-step-text" type="text">` +
    STEP_BTNS.map(([k, label, icon]) => `<button class="icon-btn plan-step-btn" data-step-${k} data-label="${label}" title="${label}">${ICON(icon)}</button>`).join('');
  /** @type {HTMLInputElement} */ (row.firstChild).value = text;
  return row;
}

function renumberSteps(list) {
  const rows = [...list.children];
  rows.forEach((row, i) => {
    row.querySelector('.plan-step-text').setAttribute('aria-label', `Step ${i + 1}`);
    row.querySelectorAll('.plan-step-btn').forEach((b) => b.setAttribute('aria-label', `${b.getAttribute('data-label')} step ${i + 1}`));
    row.querySelector('[data-step-up]').disabled = i === 0;
    row.querySelector('[data-step-down]').disabled = i === rows.length - 1;
  });
}

function renderPlanCard(msg) {
  endBubble();
  hideTyping();
  const { intro, steps, outro } = parsePlanSteps(msg.plan);
  const editable = steps.length > 0;
  const card = add(
    'plan-card',
    `<div class="ask-head">${ICON('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>')}<span class="ask-title">Plan ready for review</span></div>` +
      `<div class="plan-body msg">${renderMarkdown(editable ? intro : msg.plan)}</div>` +
      (editable
        ? `<ol class="plan-steps" aria-label="Plan steps, editable"></ol><button class="btn plan-add" data-plan-add>Add step</button>` +
          (outro.trim() ? `<div class="plan-outro msg">${renderMarkdown(outro)}</div>` : '')
        : '') +
      `<textarea class="plan-feedback" rows="2" placeholder="Changes you'd like (optional)"></textarea>` +
      `<div class="buttons"><button class="btn primary" data-plan-approve>Approve and start</button><button class="btn" data-plan-revise>Keep planning</button></div>`,
  );
  card.id = `plan-${msg.id}`;
  if (!intro.trim()) {
    card.querySelector('.plan-body').remove();
  }
  const list = card.querySelector('.plan-steps');
  const inputs = () => [...card.querySelectorAll('.plan-step-text')].map((i) => /** @type {HTMLInputElement} */ (i));
  const addRow = (text, before = null, focus = false) => {
    const row = planStepRow(text);
    list.insertBefore(row, before);
    renumberSteps(list);
    if (focus) {
      /** @type {HTMLInputElement} */ (row.firstChild).focus();
    }
  };
  steps.forEach((t) => addRow(t));
  list?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('.plan-step-btn');
    const row = btn?.closest('.plan-step');
    if (!btn || !row || btn.hasAttribute('disabled')) {
      return;
    }
    if (btn.hasAttribute('data-step-up')) {
      list.insertBefore(row, row.previousElementSibling);
    } else if (btn.hasAttribute('data-step-down')) {
      list.insertBefore(row.nextElementSibling, row);
    } else {
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      /** @type {HTMLElement | null} */ (next?.querySelector('.plan-step-text') ?? card.querySelector('[data-plan-add]'))?.focus();
    }
    renumberSteps(list);
    if (!btn.isConnected) {
      return;
    }
    /** @type {HTMLElement} */ (btn.hasAttribute('disabled') ? row.querySelector('.plan-step-text') : btn).focus();
  });
  // Enter adds a step below instead of submitting the card.
  list?.addEventListener('keydown', (e) => {
    const ke = /** @type {KeyboardEvent} */ (e);
    if (ke.key === 'Enter' && /** @type {HTMLElement} */ (ke.target).classList.contains('plan-step-text')) {
      ke.preventDefault();
      addRow('', /** @type {HTMLElement} */ (ke.target).closest('.plan-step').nextElementSibling, true);
    }
  });
  card.querySelector('[data-plan-add]')?.addEventListener('click', () => addRow('', null, true));
  const feedback = () => /** @type {HTMLTextAreaElement} */ (card.querySelector('.plan-feedback')).value;
  card.querySelector('[data-plan-approve]').addEventListener('click', () => {
    const now = inputs().map((i) => i.value.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const edited = editable && now.length > 0 && JSON.stringify(now) !== JSON.stringify(steps);
    vscode.postMessage(edited ? { type: 'planDecision', id: msg.id, approve: true, steps: now } : { type: 'planDecision', id: msg.id, approve: true });
  });
  card.querySelector('[data-plan-revise]').addEventListener('click', () =>
    vscode.postMessage({ type: 'planDecision', id: msg.id, approve: false, feedback: feedback() }),
  );
  scroll(true);
}

function resolvePlanCard(msg) {
  const verdict = msg.approved ? 'Approved, starting' : msg.feedback ? `Sent back: ${msg.feedback}` : 'Kept planning';
  const { steps } = parsePlanSteps(msg.plan);
  // An approved plan shrinks to a read-only checklist; a sent-back one shows the original text.
  const body =
    msg.approved && steps.length
      ? `<ul class="plan-checklist" aria-label="Approved plan">${steps.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : `<div class="plan-body msg">${renderMarkdown(msg.plan)}</div>`;
  let card = document.getElementById(`plan-${msg.id}`);
  if (card) {
    card.querySelectorAll('.plan-body, .plan-steps, .plan-add, .plan-outro, .plan-feedback, .buttons').forEach((e) => e.remove());
  } else {
    card = add('plan-card', `<div class="ask-head"><span class="ask-title">Plan</span></div>`);
  }
  card.querySelector('.ask-title').textContent = msg.approved ? 'Plan approved' : 'Plan';
  card.classList.add('resolved');
  card.classList.toggle('collapsed', body.startsWith('<ul'));
  card.insertAdjacentHTML('beforeend', body);
  const v = document.createElement('div');
  v.className = 'verdict';
  v.textContent = verdict;
  card.appendChild(v);
  if (busy) {
    showTyping('Working');
  }
}

// @ts-check
/** The composer: the box, file chips, sending, steering and queueing, and dictation. */
// ---------- Composer ----------

function autosize() {
  promptBox.style.height = 'auto';
  promptBox.style.height = `${Math.min(promptBox.scrollHeight, window.innerHeight * 0.4)}px`;
  sendBtn.classList.toggle('empty', !promptBox.value.trim());
  updateSendBtn();
}

/** While working, the button stops when the box is empty and sends (steers) when it has text. */
function updateSendBtn() {
  const stops = busy && !promptBox.value.trim();
  sendBtn.classList.toggle('busy', stops);
  sendBtn.title = stops ? 'Stop' : busy ? 'Send to the running task (Enter) · Tab queues it for after' : 'Send (Enter)';
  sendBtn.setAttribute('aria-label', stops ? 'Stop' : 'Send');
}

/** "12-30" -> "L12–30", "7-7" -> "L7". */
function lineLabel(selection) {
  const [a, b] = String(selection).split('-');
  return a === b || !b ? `L${a}` : `L${a}–${b}`;
}

function lineCount(selection) {
  const [a, b] = String(selection).split('-').map(Number);
  return (b || a) - a + 1;
}

/** The chip for a file the agent is given, with the highlighted lines if any. */
function editorChipContent(ed) {
  return (
    `${FILE_ICON}<span class="label">${escapeHtml(ed.name)}</span>` +
    (ed.selection ? `<span class="chip-sel">${lineLabel(ed.selection)}</span>` : '')
  );
}

function renderChips() {
  const parts = [];
  const ed = state?.editor;
  if (ed) {
    const what = ed.selection
      ? `The agent sees this file and the ${lineCount(ed.selection)} highlighted line${lineCount(ed.selection) === 1 ? '' : 's'}.`
      : 'The agent sees this file.';
    parts.push(
      `<span class="chip editor${includeEditor ? '' : ' off'}" data-toggle-editor title="${escapeHtml(ed.path)}\n${
        includeEditor ? `${what} Click to leave it out.` : 'Left out. Click to include it.'
      }">${editorChipContent(ed)}</span>`,
    );
  }
  attachments.forEach((file, i) => {
    parts.push(
      `<span class="chip" title="${escapeHtml(file)}">${TOOL_ICONS.file}<span class="label">${escapeHtml(basename(file))}</span>` +
        `<button class="remove" data-remove="${i}" aria-label="Remove ${escapeHtml(basename(file))}">×</button></span>`,
    );
  });
  chips.innerHTML = parts.join('');
}

chips.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const remove = target.closest('[data-remove]');
  if (remove) {
    attachments.splice(Number(remove.getAttribute('data-remove')), 1);
    renderChips();
    return;
  }
  if (target.closest('[data-toggle-editor]')) {
    includeEditor = !includeEditor;
    renderChips();
  }
});

function setBusy(value) {
  busy = value;
  updateSendBtn();
  promptBox.placeholder = busy ? 'Steer the task (Enter), queue for after (Tab)…' : 'Ask, or describe a change…';
  if (!busy) {
    hideTyping();
    settleSteps();
  }
}

function submit(queue = false) {
  const text = promptBox.value.trim();
  if (dictation && text) {
    // Sent by hand mid-recording: the rest isn't wanted.
    stopDictating();
  }
  if (!text) {
    if (busy) {
      vscode.postMessage({ type: 'stop' });
    }
    return;
  }
  promptBox.value = '';
  autosize();
  vscode.postMessage({ type: 'send', text, attachments, includeEditor: includeEditor && !!state?.editor, queue });
  attachments = [];
  renderChips();
}

sendBtn.addEventListener('click', () => submit());
promptBox.addEventListener('input', () => {
  autosize();
  // Typing while it records stops it and leaves the text to you.
  if (dictation) {
    stopDictating();
  }
});
promptBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    // Enter never stops: with an empty box while working it does nothing.
    if (promptBox.value.trim()) {
      submit();
    }
  } else if (e.key === 'Tab' && !e.shiftKey && busy && promptBox.value.trim()) {
    e.preventDefault();
    submit(true);
  }
});
$('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
$('attach').addEventListener('click', () => vscode.postMessage({ type: 'attach' }));

// ---------- Dictation ----------

const mic = $('mic');
/** While recording: what the box held before, which the words follow. */
let dictation = null;

function stopDictating() {
  dictation = null;
  vscode.postMessage({ type: 'dictationCancel' });
  renderMic('off');
}

function renderMic(st, level = 0) {
  mic.dataset.state = st;
  mic.style.setProperty('--level', String(level));
  const on = st !== 'off';
  mic.setAttribute('aria-label', on ? 'Stop recording and send' : 'Dictate');
  mic.title = st === 'starting' ? 'Starting the mic… click to cancel' : on ? 'Recording… pause to send, or click to send now' : 'Dictate (⇧⌘D): pause to send';
}

function onDictation(msg) {
  mic.hidden = false;
  if (msg.state === 'starting') {
    const before = promptBox.value;
    dictation = { before: before && !/\s$/.test(before) ? `${before} ` : before };
  } else if (msg.state === 'listening' && dictation && typeof msg.text === 'string') {
    promptBox.value = dictation.before + msg.text;
    autosize();
    promptBox.scrollTop = promptBox.scrollHeight;
  } else if (msg.state === 'off') {
    const send = msg.send && dictation;
    dictation = null;
    if (send) {
      submit();
    }
    if (msg.problem) {
      handleMessage({ type: 'notice', level: 'warn', text: msg.problem });
    }
  }
  renderMic(msg.state, msg.level ?? Number(mic.style.getPropertyValue('--level')) ?? 0);
}

mic.addEventListener('click', () => {
  vscode.postMessage({ type: 'dictate' });
  promptBox.focus();
});
document.addEventListener('keydown', (e) => {
  // ⇧⌘D, as in the Mac assistant; kept from VS Code, where it opens Run and Debug.
  if (e.code === 'KeyD' && e.shiftKey && (e.metaKey || e.ctrlKey) && !mic.hidden) {
    e.preventDefault();
    e.stopPropagation();
    mic.click();
  }
});

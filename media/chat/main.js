// @ts-check
/** Remote Control's state, the router for messages from the extension, and the page's start. */
// ---------- Remote Control ----------

const REMOTE_TITLE = {
  off: 'Off. Start it to use this folder from the Claude app.',
  starting: 'Starting: waiting for it to connect to claude.ai. Click to see its terminal.',
  connected: 'Connected: open this folder from the Claude app or claude.ai/code. Click to see its terminal.',
};
let remoteState = 'off';
/** The tune button carries a dot while Remote Control is on; its menu says the rest. */
function renderRemote(st) {
  remoteState = REMOTE_TITLE[st] ? st : 'off';
  $('tunePill').dataset.remote = remoteState;
}

// ---------- Messages from the extension ----------

function handleMessage(msg) {
  switch (msg.type) {
    case 'state':
      state = msg;
      renderState();
      break;
    case 'user': {
      endBubble();
      const chipsHtml = [
        ...(msg.editor ? [`<span class="chip static editor-sent">${editorChipContent(msg.editor)}</span>`] : []),
        ...msg.attachments.map((f) => `<span class="chip static">${FILE_ICON}<span class="label">${escapeHtml(basename(f))}</span></span>`),
      ];
      add(
        'user-wrap',
        `<div class="msg user">${renderMarkdown(msg.text)}</div>` +
          (chipsHtml.length ? `<div class="msg-attachments">${chipsHtml.join('')}</div>` : ''),
      );
      scroll(true);
      break;
    }
    case 'assistantStart': {
      endBubble();
      add('turn-head', `<span class="dot ${msg.provider}"></span>${NAMES[msg.provider]} · ${effortName(msg.provider, msg.effort)}`);
      showTyping('Working');
      break;
    }
    case 'thinking':
      if (!current) {
        showTyping('Thinking');
      }
      break;
    case 'delta':
      hideTyping();
      if (!current) {
        current = add('msg assistant', '');
      }
      currentText += msg.text;
      if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(renderCurrent);
      }
      break;
    case 'tool':
      endBubble();
      addStep(msg);
      break;
    case 'activity':
      if (busy && steps) {
        steps.el.title = msg.text;
        steps.el.classList.toggle('stalled', msg.stalled);
      }
      // Only relabels the indicator that's showing; streamed text keeps its place.
      if (busy && typing?.isConnected) {
        /** @type {HTMLElement} */ (typing.querySelector('.label')).textContent = msg.text;
        typing.classList.toggle('stalled', msg.stalled);
      }
      break;
    case 'notice': {
      if (msg.quiet) {
        addWarning(msg.text);
        break;
      }
      endBubble();
      const note = add(`notice ${msg.level}`, `<span>${escapeHtml(msg.text)}</span>`);
      // A saved chat's old failure has no live log to diagnose.
      if (msg.diagnose && !restoring()) {
        const btn = document.createElement('button');
        btn.className = 'notice-action';
        btn.textContent = 'Diagnose';
        btn.title = 'Ask the agent to find the cause from the failure log';
        btn.addEventListener('click', () => {
          btn.disabled = true;
          vscode.postMessage({ type: 'diagnose' });
        });
        note.appendChild(btn);
      }
      break;
    }
    case 'hello':
      if (started) {
        add('notice hello', `<span>${escapeHtml(msg.text)}</span>`);
      }
      break;
    case 'permission': {
      endBubble();
      hideTyping();
      const card = add(
        'permission',
        `<div class="title">${escapeHtml(msg.title)}</div>` +
          `<div class="detail">${escapeHtml(msg.detail)}</div>` +
          (msg.preview ? `<pre><code>${renderDiff(msg.preview)}</code></pre>` : '') +
          `<div class="buttons">` +
          `<button class="btn primary" data-decision="allow">Allow</button>` +
          (msg.canAlways ? `<button class="btn" data-decision="always">Always allow</button>` : '') +
          `<button class="btn" data-decision="deny">Deny</button>` +
          `</div>`,
      );
      card.id = `perm-${msg.id}`;
      card.querySelectorAll('[data-decision]').forEach((btn) =>
        btn.addEventListener('click', () =>
          vscode.postMessage({ type: 'permission', id: msg.id, decision: btn.getAttribute('data-decision') }),
        ),
      );
      scroll(true);
      break;
    }
    case 'question':
      renderQuestionCard(msg);
      break;
    case 'questionResolved':
      resolveQuestionCard(msg);
      break;
    case 'planReview':
      renderPlanCard(msg);
      break;
    case 'planResolved':
      resolvePlanCard(msg);
      break;
    case 'permissionResolved': {
      const card = document.getElementById(`perm-${msg.id}`);
      if (card) {
        card.classList.add('resolved');
        card.querySelector('.buttons')?.remove();
        const verdict = document.createElement('div');
        verdict.className = 'verdict';
        verdict.textContent = msg.decision === 'deny' ? 'Denied' : msg.decision === 'always' ? 'Always allowed' : 'Allowed';
        card.appendChild(verdict);
      }
      if (busy) {
        showTyping('Working');
      }
      break;
    }
    case 'usage':
      renderUsage(msg.usage);
      break;
    case 'usageReport':
      usageReport = msg;
      renderUsagePanel();
      break;
    case 'agents':
      agents = msg;
      renderAgentsPill();
      renderAgentsPanel();
      tickAgents();
      break;
    case 'attached':
      for (const f of msg.files) {
        if (!attachments.includes(f)) {
          attachments.push(f);
        }
      }
      renderChips();
      promptBox.focus();
      break;
    case 'done':
      endBubble();
      hideTyping();
      settleSteps();
      add('summary', escapeHtml(msg.summary));
      break;
    case 'reset':
      warnings = [];
      endBubble();
      hideTyping();
      settleSteps();
      started = false;
      welcomeHtml = '';
      includeEditor = true;
      agents = null;
      expandedAgents.clear();
      pickedAgent = null;
      usageReport = null;
      if (usageOpen) {
        vscode.postMessage({ type: 'usageReport', scope: usageScope });
      }
      renderAgentsPill();
      renderAgentsPanel();
      tickAgents();
      renderWelcome();
      break;
    case 'restore':
      // Redraw a saved chat without replaying every entrance animation.
      warnings = [];
      endBubble();
      hideTyping();
      settleSteps();
      started = false;
      welcomeHtml = '';
      document.body.classList.add('restoring');
      try {
        for (const m of msg.messages) {
          // One bad saved entry mustn't stop the rest of the chat drawing.
          try {
            handleMessage(m);
          } catch (err) {
            console.error('restore: skipped an entry', m && m.type, err);
          }
        }
      } finally {
        document.body.classList.remove('restoring');
      }
      hideTyping();
      settleSteps();
      endBubble();
      if (!msg.messages.length) {
        renderWelcome();
      }
      scroll(true);
      break;
    case 'history':
      savedChats = msg.items;
      currentChat = msg.current;
      break;
    case 'remote':
      renderRemote(msg.state);
      break;
    case 'dictation':
      onDictation(msg);
      break;
  }
}

window.addEventListener('message', (event) => handleMessage(event.data));

autosize();
renderAgentsPill();
renderWelcome();
vscode.postMessage({ type: 'ready' });

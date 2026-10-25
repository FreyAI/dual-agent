# Using Dual Agent

How a task runs, what the chat shows, helper agents, project memory and the guards.

## A typical task

1. **Open a chat.** Use the sidebar icon, or the logo at the top right of an editor for a chat in its own tab. The sidebar reopens this repo's last chat. **+** starts a new one, and the clock button lists earlier ones.
2. **Choose how it runs.** Open the model pill in the top bar:
   - **Mode:** Auto, Claude or DeepSeek.
   - **Effort:** Flash for quick, mechanical edits; Thinking for bugs and design.
   - **Build mode:** see [build modes](build-modes.md).

   Auto with Thinking suits most work.
3. **Choose permissions** in the bottom bar:
   - *Ask* (the default) shows a card before each edit or command, but read-only commands run without one.
   - *Auto-edit* changes files without asking.
   - *Plan* only reads, then shows a plan for you to approve.
4. **Give it context.** The file you're on goes along as a chip above the box. Highlight lines to send only those, or click the chip to leave the file out. Attach other files or images with the paperclip.
5. **Send** with **Enter**. While it works:
   - **Enter** adds a message to the running task. The agent reads it between steps, so use it to steer.
   - **Tab** queues a message for when the task is done.
   - The send button becomes **Stop** when the box is empty.
6. **Answer as it goes.** The agents pill counts the working agents, helpers included; click it to see what each is doing. Permission and question cards appear in the chat.
7. **Check the result.** The line under each reply shows:
   - which provider finished it;
   - tokens, time and cost;
   - **not verified** when the agent claimed something its work doesn't show (for example "tests pass" with no test run since the last edit).

### Keeping cost in check

- **Token pill (bottom bar):** shows new tokens and their cost for this chat. Click it for the usage panel:
  - **Split** tab: how much of the day goes to Claude vs DeepSeek in this repo.
  - **Cost** tab: a spend limit, a daily budget and per-model limits.
- **Dual Agent: Diagnose Token Burn:** where the tokens went: which chats, helpers, tool outputs and cache misses.
- **Cheaper for simple jobs:** use Flash, or DeepSeek mode. [Saving tokens](performance.md#saving-tokens) lists the settings behind the defaults.

### When something goes wrong

- **A provider fails:** the chat continues on the other one and says so. If your Claude sign-in expires mid-reply, a card offers **Sign in** or **Continue on DeepSeek**.
- **The agent seems stuck:** a notice appears after 90 seconds of silence. Press **Stop**, then tell it what to try next.
- **To see what failed:**
  - **Dual Agent: Show Failures** lists the last 24 hours' errors, retries and refusals, with reasons.
  - The **Dual Agent** output panel has the live log.
  - A failure notice in the chat has a **Diagnose** button that hands the problem to the agent.

## The chat

- **Top bar:** a status dot (ready, working or not set up) and the model pill, for example *Auto · Claude · Thinking*. Its menu holds **Model**, **Effort** and **Build** mode. Then come the new chat, history, theme, open-in-tab and settings buttons.
- **Bottom bar:** attach, the tune menu, **Agents**, **Permissions**, the token pill, the mic (Mac) and send.
- **Tune menu** (the sliders icon):
  - **Phone (Claude app)** starts [Remote Control](remote-control.md) and shows its state. A dot on the icon means it's on.
  - **Cost alerts and limits** opens the usage panel's Cost tab.
  - **Split between Claude and DeepSeek** opens its Split tab. Both tabs are also in the panel itself.
- **Token pill:** new tokens and their cost at API prices, e.g. *3.81M · $20.92*. Cache re-reads aren't counted there: they re-send what was already sent, cost 5-10% of new input, and were 95% of a long chat's tokens. Its tooltip has the re-reads, the last 10 minutes' new tokens and cost, the context now, and what is billed per token. Click it for the usage panel: subscription use is marked * (what the API would charge), the **Split** tab has an on/off switch and a slider in steps of 5, and the **Cost** tab has presets and adds per-model limits by name.
- **Spending fast:** when 10 minutes cost more than $3 or 1M new tokens, the chat says so (at most once per 10 minutes), with who spent it. The pill turns amber when the context passes 150k tokens.
- **Dictation (Mac, macOS 13 or later):** click the mic, or press **⇧⌘D** while the chat has focus, and talk. Your words appear in the box as you speak, and the message sends when you pause (about 1.6 s), or as soon as you click the mic again. Typing while it records stops it without sending; after a minute it stops and sends what it heard. One chat records at a time.
  - The first time, macOS asks to let **Dual Agent Dictation** use the microphone and speech recognition. Speech is recognised on the Mac when your language supports it. If it never hears you, check System Settings › Sound › Input; if macOS says Dictation is off, turn it on in Keyboard settings.
  - The chat page can't use the microphone itself (VS Code allows none in its panels), so a small bundled app, `bin/Dual Agent Dictation.app` (source in `native/dictation`), records and sends the words back over a local connection. The build scripts (`scripts/build-dictation.mjs`) make it on a Mac with the Xcode command line tools, and only when its source changes, because macOS asks for the permissions again for each new build. VSIXs built on Linux or Windows have no mic.
- **Agents pill:** shows how many agents are running, with a spinner while any are, and the count goes down as each one stops. It turns amber when an agent goes quiet for 90 seconds or its last tool failed, and red when one waits for your answer. Click it for the agents panel:
  - the **plan** (the main agent's to-do list, with progress);
  - each agent's model, status, current step, recent steps and tokens;
  - a **Stop** for each running helper, which leaves the others working;
  - pills per agent name that filter the view, and each run's last 4 steps (expand for the earlier ones).
- **Live status:** while the agent works, the indicator says what it's doing and for how long, for example *Running Bash: npm test · 42s · 2 helpers working*. If the model sends nothing for 90 seconds outside a tool, a notice says it may be stuck.
- **Typing while it works:**
  - **Enter** sends your message into the running task; the agent reads it between steps.
  - **Tab** queues it for when the task is done.
  - With the box empty, the send button becomes **Stop**. Stop ends the current reply only; background helpers keep working.
- **Permissions:** *Ask* before edits and commands, *Auto-edit* to edit files without asking, *Bypass* to never ask, or *Plan* for read-only. A change applies immediately, even mid-task, and to every chat (the mode and the theme are saved to your user settings). With *Ask*, commands that only read (git status, ls, rg…) run without a card (`dualAgent.autoApproveReadOnly`).
  - A permission card shows the edit's diff, with **Allow**, **Always allow** (when Claude Code offers a rule) and **Deny**.
  - In *Plan* mode, a finished plan comes as a card: **Approve and start** (the chat switches to *Ask*) or **Keep planning**, with room for feedback.
- **Questions from the agent:** one card. Several questions get a tab each (a dot turns green once answered), with Back and Next and the arrow keys to move between them; checkbox questions take several answers, and **Other…** takes your own. **Send answers** turns on once every question has an answer.
- **The file you're on:**
  - It shows as a chip above the message box, and the highlighted lines as a pill next to it (e.g. `L12–30`). Both go with your message; click the chip to leave the file out.
  - With lines highlighted, only those lines go (up to 12,000 characters; more are sent as a range to read). Otherwise the whole file goes when it's under 12,000 characters and has changed since the agent last saw it. The agent is told when the file has unsaved changes.
  - Attached text files are included up to 16 KB; bigger and binary ones go by path. Images (png, jpg, gif, webp, up to 5 MB) go as images.
- **Under each reply:** the provider that finished it, tokens in and out, the share cached, tool calls (and how many failed), helper calls, time to first token, total time, the per-token cost (not shown for subscription use), and *not verified* when the report check found claims its work doesn't show.
- **Tool steps:** a run of tool calls folds into one "N steps" line; click it for the steps, and a step with a file opens it.
- **History:** chats are saved per repo, up to 50 (the oldest go first, and very long chats lose their oldest parts). The sidebar reopens the repo's last chat; new tabs start fresh, and the clock button lists the others; opening one resumes it. Unanswered cards aren't saved. **Dual Agent: Clear Chat History (this repo)** deletes them.
- **Themes:** eight dark themes from the palette button (Graphite by default); hovering one previews it.
- **Esc** or a click outside closes menus and panels. The status-bar item (*Auto → Claude · Thinking*) opens **Switch Provider**. An editor tab is titled *Dual Agent · folder* and stays on the folder it was opened from.

### Effort

The model pill's **Effort** applies to whichever provider answers next:
- **Flash:** DeepSeek Flash with thinking off, or Claude at low effort (labelled **Fast** on Claude).
- **Thinking:** DeepSeek V4 Pro at high effort, or Claude at `dualAgent.claude.thinkingEffort` (medium by default, although the menu's tooltip says "High effort").

DeepSeek defaults to Flash (`dualAgent.deepseek.effort`): in the benchmarks it solved every task at about 1/50 of Claude's cost. Claude defaults to Thinking.

## Helper agents

The main agent hands jobs to helpers and picks one per job:

| Helper | Used for | On DeepSeek | On Claude | Step limit |
|---|---|---|---|---|
| **searcher** | Finding code: returns paths and line ranges only, reads nothing else | Flash | Haiku | 6 |
| **quick-helper** | Searching, reading and summarizing, running a command, small edits in named files | Flash | Haiku | 30 |
| **deep-thinker** | Tricky debugging, multi-file design, careful review | V4 Pro | Sonnet | 40 |
| **general-purpose** | A well-briefed multi-step change or research task (replaces Claude Code's built-in one) | Flash | Sonnet | 80 |

quick-helper and searcher run at low effort and don't load the project's `CLAUDE.md`; the searcher can't run commands or edit. deep-thinker runs at high effort, and general-purpose at low on DeepSeek and medium on Sonnet. Claude Code's other built-in helpers run on Flash or Sonnet instead of the main model.

**Claude leads, DeepSeek helps** (`dualAgent.deepseekHelpers`, on by default). When Claude is the main agent, it plans, writes the briefs, integrates and reviews, and is told to delegate every well-defined part.
- **Where the helpers run:** on DeepSeek while DeepSeek is below its share of the split, or always with no split. Once DeepSeek is 5 points ahead, Claude's helpers run on Claude until DeepSeek falls behind again.
- **Switching** the helpers to the other provider restarts the agent, so it waits until no helper is working.
- **How requests get there:** the local proxy sends the helpers' requests to DeepSeek with the DeepSeek key. Your claude.ai sign-in is never sent there.
- **Web search:** DeepSeek runs Claude Code's server-side web search too, so DeepSeek helpers in a Claude chat search the same way.
- **The other direction** (`dualAgent.claudeHelpers`, on by default): when DeepSeek leads and is below its share, planning runs on V4 Pro; once it is ahead, planning moves to Claude (`dualAgent.claude.plannerModel`) and delegated work to Claude's smaller models, with your sign-in behind the local proxy, which strips it from every DeepSeek request. Off: DeepSeek chats use DeepSeek only.

**How helpers are kept small:**
- **Scoped briefs:** every brief names the helper and two lines, `Edit only: <files or globs>` (or `none`) and `Read first: <files>`. A brief without an `Edit only:` line gets the files it names as its scope, and is refused only if it names none. Edits outside the scope are refused too, including obvious shell writes. Globs also match in other repos the brief names (`in ~/code/x: Edit only: …`) and in worktree copies; `/tmp` is always writable. Build output that git ignores (`build/`, `.gradle/`, `target/`…) is the exception, so helpers can build and test their work; one that couldn't says "not built".
- **Short reports:** helpers are asked to report in about 1,500 tokens, since a report stays in the main chat's context. It isn't enforced: a longer report is logged, because sending it back to be shortened costs more than it saves.
- **A project brief:** every helper (except the searcher) starts with the build and test commands that worked here and the known gotchas, from [project memory](#project-memory).
- **Limits:**
  - At most `dualAgent.maxParallelHelpers` (4) run at once.
  - Every helper compacts its context at 100k tokens.
  - Helpers can't start helpers.
- **Waiting for helpers:** parallel helpers report back within the same reply; the main agent waits for them and reviews all their work once. Each report that arrives after a reply has ended starts another reply, which re-reads the whole conversation (in a measured chat these were 55% of its cost), so Claude Code's fork mode, which makes every helper a background one, is turned off (`CLAUDE_CODE_FORK_SUBAGENT=0`).
- **Background helpers** are for jobs over about 5 minutes. They keep working after the reply ends, stay in the agents list until they really finish, and the agent picks up their reports when they arrive.

Turn helpers off with `dualAgent.helperAgents`, or turn helpers off on one provider with `dualAgent.deepseekHelpers` / `dualAgent.claudeHelpers`.

## Project memory

Agents keep what they learn about a project in plain Markdown under `.dual-agent/memory/` (git-ignored), so the next agent doesn't work it out again. You can read and edit the files.

- **What's kept:** short notes (`notes.md`), each with the files it's about and a kind:
  - a **command** that worked (build and test commands that succeed are recorded automatically);
  - a **gotcha**: what looked right and what is true;
  - a **decision** the code doesn't show;
  - **where** something lives.

  There are no overviews of how code flows: in studies they cost tokens without helping agents find files.
- **Who gets what:**
  - A new chat's main agent gets each note's title and first line (up to 1,600 characters) and a pointer to `handoff.md` (recent tasks and compaction summaries, up to 4 KB), read only when the request continues earlier work. It gets them again after a compaction.
  - Every helper but the searcher gets a brief of up to 2,000 characters: the checked commands and gotchas. It is the same for the whole session, so it stays cached.
  - Reading a file of 8 KB or more also shows the confirmed notes about that file (up to 800 characters), once per agent until the next compaction.
  - Agents read the rest with `notes_read` and save with `notes_add` (titles of 3-120 characters, bodies up to 1,500, up to 20 files; another repo's notes through `path`). These tools come with the lean workflow (`dualAgent.leanWorkflow`).
  - Recorded commands are only whole build and test runs that passed: not installs or cleans, not one filtered test, never with a key in them. At most once a day each; the newest 12 are kept.
- **What can be trusted:**
  - A helper's note is a proposal until a build or test it ran passes; the main agent can confirm one by saving the same title. Helpers can't replace or delete other notes.
  - Notes written after an agent used WebFetch, WebSearch or an MCP tool other than the code tools stay `Pending: untrusted` until you delete that line; the chat says so once. Like any unconfirmed proposal, they go after 7 days.
  - A note says when its files changed since it was checked, or that it cites no files and nothing checks it.
  - Notes holding keys or credential paths are refused, and keys are masked in the handoff.
- **Tidying:** notes nobody used or checked for 30 days, notes whose files have all been gone for 14 days, and notes past the 32 KB cap move to `notes-archive.md`, which no agent sees. Unconfirmed proposals go after 7 days.
- **Off switch:** `dualAgent.projectMemory` turns off everything agents are given (the titles, the brief and the file notes), to compare with and without; notes are still kept.
- Facts about you and how you like to work stay in Claude Code's own memory, not here.

## Guards

These are enforced in code, not just asked for in the prompt.

- **Reports are checked against the work.** Before the main agent or a helper finishes, its report is compared with what it did:
  - "Tests pass" needs a test run that passed since the last edit (an earlier reply's run counts if nothing changed after it).
  - "It builds" needs a build or test command.
  - "I changed `file.ts`" needs an edit to that file, or git showing it changed (shell writes count as edits).
  - "Done" with open to-do items doesn't count.

  A report the work **contradicts** (the last test or build failed, or a named file has no changes) is sent back once; if it still does, a **Check this** warning says so. A claim with **no evidence** (no test since the last edit, changed code with nothing run, a narrowed test after several changes, open to-dos) isn't sent back: the reply's summary line says *not verified*, and the failure log keeps why. Claude Code's own untyped side agents and automatic turns aren't checked; a helper's evidence counts for the agent that started it.
- **Hidden failures:** `npm test | tail -5` exits 0 even when tests fail. Output showing failed tests, compiler errors, tracebacks, `npm ERR!`, "command not found" or a segfault is pointed out to the agent, and counts as a failure in the report check and toward moving to a stronger model. A command that failed outright gets a note not to carry on as if it worked.
- **Loops:**
  - The same call with the same result gets a nudge the third time and is refused the fourth.
  - A call that failed twice is refused until something changes (test and build reruns excepted).
  - Bouncing between two calls gets a nudge at 5 and a refusal at 7.
  - A call refused again within 10 minutes gets a firmer reason. A third loop refusal in one reply stops the reply.
- **Runaway replies:** a reply stops after 150 steps (`dualAgent.maxStepsPerTurn`).
- **Shell file dumps:** `cat`, `head`, `tail`, `sed -n`, `less`, `nl`, `bat` and the like on source, Markdown and config files are refused; the agent reads with Read and a range, or the code tools. Piping into a filter (`cat x | jq`) and `tail -f` are allowed.
- **Big reads:** reading a file over 400 lines without a range gets a hint to outline it first.
- **Downloads in reuse and hybrid modes:** `git clone`, `npm pack`, `pip download` and `curl`/`wget` from code hosts are refused; code comes in only through the vetted import in [build modes](build-modes.md).
- **One build at a time:** a build or test while another agent's runs in the same git repo is refused with "use its result, or say not built": two at once fight over locks and caches (Gradle's `.gradle`). Background runs are exempt, and a hold ends with the run's result, a declined permission card or after 15 minutes.

# Settings reference

Every `dualAgent.*` setting, with its default: the full list from the extension's configuration.

The **All settings** button in the usage panel opens VS Code's settings filtered to them, or edit `settings.json` directly. Settings that say "new chats" or "new agent sessions" apply from the next chat or session. Modes (*permissions*, *effort*, *build*, *theme*) are also changed from the chat itself and apply at once.

| `dualAgent.mode` | `"auto"` | Which backend the agent runs on. |
| `dualAgent.effort` | `"thinking"` | How hard Claude thinks (DeepSeek has its own dualAgent.deepseek.effort). Changing it applies from the next message; the conversation continues. |
| `dualAgent.deepseek.effort` | `"thinking"` | Which DeepSeek model leads by default. The Effort menu in the chat changes it whenever DeepSeek answers next. |
| `dualAgent.helperAgents` | `true` | Let the agent hand jobs to helper agents on their own models: a quick helper on the fast model (DeepSeek Flash / Claude Haiku) for searches, reading and small edits, and a deep thinker on the strong model (DeepSeek V4 Pro / Claude Sonnet) for hard problems. The main agent picks per job. Each helper stops after 30 steps. |
| `dualAgent.deepseekHelpers` | `true` | When Claude leads, its delegated work (quick jobs, searches, general tasks) runs on DeepSeek Flash as long as DeepSeek is below its share of `dualAgent.tokenSplit` (always, with no split); once DeepSeek is ahead, it runs on Claude's smaller models. Planning (Plan, deep thinker) follows the same provider on its strongest model — DeepSeek V4 Pro below its share, Claude's planner model once ahead. Needs a DeepSeek key; the claude.ai sign-in is never sent to DeepSeek. |
| `dualAgent.claudeHelpers` | `true` | When DeepSeek leads, planning (Plan, deep thinker) runs on DeepSeek's strongest model while it is below its share of `dualAgent.tokenSplit`, and moves to Claude (`dualAgent.claude.plannerModel`) — along with the delegated work on Claude's smaller models — once DeepSeek is ahead of its share. The session then runs with your Claude sign-in behind the local proxy, which strips it from every DeepSeek request. Off: DeepSeek chats use DeepSeek only. |
| `dualAgent.autoApproveReadOnly` | `true` | With permissions set to Ask, run shell commands that only read (git status/diff/log, ls, rg, grep, find without -exec, wc…) without asking. Anything that writes or runs other programs still asks. |
| `dualAgent.maxParallelHelpers` | `4` | How many helper agents may run at once. Each new helper re-reads its brief and files at full price, so more at once costs more for most coding work. Claude Code's own default is 20. |
| `dualAgent.clearOldToolResults` | `true` | On DeepSeek, mask old tool output in long conversations, in fixed batches through a local proxy so the prompt cache stays intact. Cuts the tokens every later call re-sends. Takes effect for new agent sessions. |
| `dualAgent.claude.clearOldToolResults` | `false` | On Claude, turn on Anthropic's server-side clearing of old tool output once the context passes 100k tokens. Each clear rewrites the whole cached conversation (on Opus a cache write costs 40 reads), so it rarely pays back before compaction. Takes effect for new agent sessions. |
| `dualAgent.projectMemory` | `true` | Give agents the project memory in .dual-agent/memory: the notes index at the start of a chat, a brief of checked commands and gotchas to every helper, and the notes about a large file when it is read. Turn off to compare cost and results without it; notes are still kept. Takes effect for new agent sessions. |
| `dualAgent.retrieval` | `true` | On a new task's first message that names no file, add a short list of the files and definitions the repository index ranks for it (about 300 tokens), so the agent opens the right files first. Turn off to compare cost and results without it. |
| `dualAgent.autoCheck` | `"typecheck"` | When the main agent stops after editing files, run the project's checks (from .dual-agent/memory/conventions.md) and send failures back to it: typecheck only, or typecheck, lint and tests. Takes effect for new agent sessions. |
| `dualAgent.autoCheckTimeoutSeconds` | `60` | Timeout for the automatic typecheck and lint runs. |
| `dualAgent.autoCheckTestTimeoutSeconds` | `180` | Timeout for the automatic test run (dualAgent.autoCheck: all). |
| `dualAgent.cacheDiagnostics` | `true` | Ask the Claude API why the prompt cache missed, and log each miss with its cause (Dual Agent: Show Failures). Adds no tokens. Takes effect for new agent sessions. |
| `dualAgent.trimToolOutput` | `true` | Cut long tool output before the model sees it: test and build runs to their failures and summary, anything over 8,000 characters to its start and end with the full text saved in .dual-agent/outputs. |
| `dualAgent.leanEscalation` | `true` | In auto mode, when a stronger model takes over a conversation with more than 100k tokens of history, start it fresh with a short handoff (requests, files changed, open to-dos, the last reply) instead of re-reading the whole history at full price. |
| `dualAgent.maxStepsPerTurn` | `150` | Stop a reply after this many model steps: it's likely going in circles. 0 = no limit. Repeated identical tool calls and retries of a command that failed twice are refused anyway. |
| `dualAgent.compactWindow` | `0` | Context size in tokens at which the conversation is summarized (compacted). Every call re-sends the whole context, so a smaller window costs less on long sessions. 0 = 200,000 on Claude and 160,000 on DeepSeek; values from 100,000 to 1,000,000 are used as given. |
| `dualAgent.replyStyle` | `"full"` | How terse the agent's replies are. Fewer output tokens means faster, cheaper replies; code, commands, errors, commits and files are never compressed, and security warnings and questions to you stay in full sentences. Applies to new chats. |
| `dualAgent.leanWorkflow` | `true` | Reuse-first, token-saving coding rules: search before writing and extend existing code, read ranges instead of whole files, change only the layer that owns a bug, test-first without weakening tests, comments only for what the code can't say. Adds the code_map, find_duplicates and language-server tools (outline, definition, references, problems), and a check after each edit for duplicated code and comments that narrate the edit. Also one-line code-review findings, Conventional Commits, and compact reports from helper agents. Applies to new chats. |
| `dualAgent.buildMode` | `"hybrid"` | How the agent builds things. Reuse and hybrid can search GitHub, download a pinned commit into the workspace's ignored .dual-agent/reuse folder, scan it for malware patterns without running it, and import the needed files with license checks, attribution and provenance (you approve each import). "Dual Agent: Set Build Mode" sets it per project. Applies to new chats. |
| `dualAgent.webTools` | `"auto"` | How the agents search and read the web. |
| `dualAgent.claudeRole` | `"backup"` | How much auto mode uses Claude. The usage panel shows how many replies still needed Claude, to tell when it can be switched off. |
| `dualAgent.tokenSplit` | `50` | Delegation split for auto mode: Claude's target share of tokens, 0-100 (DeepSeek gets the rest). The providers take turns in stints of half their share of a usual day (70/30: Claude 35%, then DeepSeek 15%, twice a day), so the provider changes only at stint ends. Stuck tasks still escalate and Claude backs off when its quota runs low. A split set from the Split tab is saved for that repo and stays its default; this setting is the default for other repos. `null` turns it off and uses `dualAgent.claudeRole`. |
| `dualAgent.dailyBudgetUsd` | `0` | Stop starting new replies once today's per-token spend (DeepSeek, Anthropic key) reaches this many dollars; a warning comes at 80%. 0 = no limit. Subscription use doesn't count. |
| `dualAgent.showCostInChat` | `false` | Show the chat's cost at API prices next to the token count in the message box. The usage panel and the pill's tooltip always show it. |
| `dualAgent.costLimitUsd` | `0` | Stop once per-token spend across all models since the last reset reaches this many dollars: the running reply stops and no new one starts until "Dual Agent: Reset Cost Limits". A warning comes at 80%. Counting starts when you first set a limit. 0 = off. Subscription use doesn't count. |
| `dualAgent.modelCostLimitsUsd` | `{}` | Spend limits per model since the last reset, in dollars, e.g. `{ "deepseek-v4-pro": 5, "claude-opus": 20 }`. A name covers every model id that starts with it. A model that reaches its limit stops the reply and isn't used until **Dual Agent: Reset Cost Limits**; another model answers instead (in auto mode, possibly the other provider). DeepSeek's helpers run on its fast model, so a limit on that one pauses DeepSeek. Empty = off. |
| `dualAgent.logRetentionDays` | `90` | Days of failure, turn and model-call logs to keep (the usage folder's diag, turns and calls files); older rows are dropped when VS Code starts. Usage rows are kept as billing history. |
| `dualAgent.fallbackCooldownMinutes` | `30` | After a provider fails in auto mode, how long to stay on the other one before trying it again (unless the provider reports its own reset time). |
| `dualAgent.claude.model` | `""` | Claude model to use (for example claude-opus-5-5 or claude-sonnet-5-5). Leave empty to use your Claude Code default. |
| `dualAgent.claude.plannerModel` | `""` | Claude model for the Plan and deep thinker helpers. Leave empty for Opus (its latest release), or Sonnet if your account doesn't offer Opus. |
| `dualAgent.claude.helperModel` | `""` | Claude model for delegated work when it runs on Claude (quick jobs and searches use Haiku). Leave empty for Sonnet (its latest release). |
| `dualAgent.claude.thinkingEffort` | `"medium"` | How hard Claude thinks when effort is Thinking. Medium answers faster with fewer, shorter tool calls; high and xhigh think longer on every turn, status replies included. |
| `dualAgent.claude.fastMode` | `false` | Fast mode for Opus: up to 2.5x faster output at about twice the price per token. Best for long answers and big edits. |
| `dualAgent.deepseek.advisor` | `false` | When DeepSeek runs on Flash, give it an ask_advisor tool that consults V4 Pro on plans, when stuck and before finishing hard tasks. Each question is one extra V4 Pro call. |
| `dualAgent.claude.advisor` | `false` | Run the main agent on Sonnet (faster, cheaper) with Opus as an advisor it consults at key points. Ignored when Claude: Model is set. |
| `dualAgent.deepseek.baseUrl` | `"https://api.deepseek.com/anthropic"` | DeepSeek's Anthropic-compatible endpoint. |
| `dualAgent.deepseek.apiKeyFile` | `""` | Optional path to a .env-style file containing DEEPSEEK_API_KEY=... . When set and readable, it is used instead of the key stored with "Set DeepSeek API Key". |
| `dualAgent.deepseek.model` | `""` | DeepSeek model for Thinking effort and planning. Leave empty for the newest Pro model DeepSeek lists (checked daily), else deepseek-v4-pro. |
| `dualAgent.deepseek.fastModel` | `""` | DeepSeek model for Flash effort, delegated work and background tasks. Leave empty for the newest Flash model DeepSeek lists (checked daily), else deepseek-flash. |
| `dualAgent.permissionMode` | `"default"` | Ask, Auto-edit, Bypass or Plan. Default: ask before edits and commands. Changes apply immediately, even mid-task. |
| `dualAgent.theme` | `"graphite"` | Color theme of the chat. All are dark. Also changeable from the palette button in the chat. |
| `dualAgent.usageFolder` | `""` | Folder for token-usage records (one file per machine). Point it at a folder you sync between machines (Dropbox, iCloud, Syncthing, a private git repo) to see totals across all of them. Empty: kept in VS Code's storage on this machine. Takes effect after a reload. |
| `dualAgent.telemetry.otlpEndpoint` | `""` | Optional OpenTelemetry collector (for example http://localhost:4318). When set, Claude Code's own metrics and events (tokens, cost, latency, tool results) are exported there. Prompts and tool contents are never included. Empty: nothing leaves this machine. Applies from the next new chat. |
| `dualAgent.telemetry.otlpProtocol` | `"http/protobuf"` | Protocol for dualAgent.telemetry.otlpEndpoint. |

The same defaults and descriptions are in `package.json` under `contributes.configuration`.

## Permission modes

`dualAgent.permissionMode`, and the **Permissions** control in the chat, which changes it for every chat:

| Value | What runs without asking |
|---|---|
| `default` (Ask) | Read-only commands, when `dualAgent.autoApproveReadOnly` is on |
| `acceptEdits` (Auto-edit) | File edits and new files |
| `bypassPermissions` (Bypass) | Everything |
| `plan` (Plan) | Nothing; the agent only reads and proposes a plan |

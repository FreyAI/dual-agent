# Speed and token use

How the extension keeps replies fast and each call small. Most of the token saving comes from keeping the context small, because every call re-sends it.

## Saving tokens

- **Fewer tool definitions:**
  - Unused built-in tools aren't sent, and each helper gets only the tools it needs.
  - Tool search loads the rest on demand (per call: Claude 33k instead of 55k tokens, DeepSeek 16k instead of 31k).
- **Old tool output is cleared** on DeepSeek (`dualAgent.clearOldToolResults`, through a local proxy): results older than the newest 8 are masked in batches of 10, so the cache prefix stays stable. Results under 400 characters stay.
- **Output caps:** MCP tool output is capped at 8,000 tokens and a file read at 10,000, unless your environment sets them.
  - On Claude, Anthropic's server-side clearing is off by default (`dualAgent.claude.clearOldToolResults`): each clear rewrites the whole cached conversation, which costs more than it saves before compaction.
- **Cache misses are explained** (`dualAgent.cacheDiagnostics`): the Claude API says why each miss happened (a changed system prompt, tools or history, or an expired entry), and **Show Failures** and **Diagnose Token Burn** list them. On DeepSeek, which has no such API, a call that reads much less of its cache than the call before is logged instead.
- **Tool output is trimmed** (`dualAgent.trimToolOutput`):
  - Test and build runs keep only their failures and summary.
  - Anything over 8,000 characters keeps about 3,000 of its start and end, with the full text in `.dual-agent/outputs` (kept 7 days). Read, Edit and Write output is never trimmed, and nothing is when the workspace is your home folder.
  - Shell output over 12k characters goes to a file the agent can search.
- **Earlier compaction:** long chats are summarized at 200k tokens on Claude and 160k on DeepSeek (`dualAgent.compactWindow`). Compact instructions say what to keep, and project memory is re-added afterwards.
- **A stable, cached prefix:** the system prompt's fixed parts are the same across sessions. A **Cache miss** notice says when a reply of 50k tokens or more got less than half of them from cache.
- **Lean escalation** (`dualAgent.leanEscalation`, auto mode): a stronger model taking over more than 100k tokens of history starts fresh with a handoff, instead of re-reading everything.
- **Step budget:** once there are 20 finished replies, 5 steps before your usual number (the 75th percentile, at least 20), the agent is told how many are left.
- **Terse replies** (`dualAgent.replyStyle`, default `full`; or **Dual Agent: Set Reply Style**):
  - The answer comes first, with no preamble or recap. `lite` keeps full sentences; `ultra` compresses the most; `off` adds no style rules.
  - Code, commands, paths, errors, commits and files are never compressed.
  - Security warnings and questions to you stay in full sentences.
- **Lean workflow** (`dualAgent.leanWorkflow`): reuse-first coding rules (search before writing, one home for each type, no one-off abstractions), reading in ranges, fixes at the narrowest layer, tests never weakened, and comments only for what code can't say.
- **Code tools** (part of the lean workflow; they never ask permission):
  - `code_map`: what the repo already defines, ranked by the files you're editing and the names you mention.
  - `find_duplicates`: copied blocks.
  - `code_outline`, `code_definition`, `code_references` and `code_problems`: these use VS Code's own language servers.
  - After every edit, a check tells the agent if it duplicated existing code or wrote comments narrating the edit, and, for a file open in a tab, which new errors the editor found (language servers don't check files that aren't open).
- **Project memory:** checked commands and gotchas reach every helper, so each launch doesn't rediscover them; see [project memory](usage.md#project-memory). The `code_map` index is saved in `.dual-agent/index/`.
- **Retrieval** (`dualAgent.retrieval`): on a task's first message that names no file, a short list of the files and definitions the repo index ranks for it (about 300 tokens) is added, so the agent opens the right files first.
- **Compress Memory File** rewrites a file that loads into every session (`CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`) in compressed form.
  - It keeps a backup outside the repo, checks that code, URLs and headings are unchanged, and can restore the original with one click.
  - It refuses files whose names suggest secrets.
- **Split CLAUDE.md into Path-Scoped Rules** moves sections about specific folders into `.claude/rules/`, which load only when matching files are touched.

Claude Code keeps a chat's instructions from its first message, to keep the cache warm. Changes to these settings apply to new chats.

## Speed

The extension keeps its own work out of the model's way.

- **Claude Code starts before you send.**
  - Opening a chat starts its Claude Code process, so the first message doesn't wait 1–3 seconds for a launch.
  - After a reply, if the next message will go to a different provider or effort, that process is started ahead too.
  - A process nobody uses closes after 10 minutes. Each open chat holds one (about 250 MB).
  - A process waiting like this makes no model calls.
- **Network blips cost seconds, not minutes.** The local proxy:
  - drops connections idle for 15 seconds, and flushes the rest after a network error;
  - resends a request once on a fresh connection when a reused one turns out to be dead;
  - caches DNS answers, and keeps using the last good one if a lookup fails;
  - gives up on a stalled connect or TLS handshake after 10 seconds, and on requests other than model calls after 30 seconds. Failures are answered so that Claude Code retries within a second.
  - Claude Code's background traffic (Remote Control heartbeats, token counts) uses its own connections, so a failed heartbeat doesn't hold up a switch to the other provider.
- **Fewer background calls:** session titles, prompt suggestions, away summaries and the official plugin marketplace install are off.
- **Long chats stay quick:**
  - Reopening a 2,000-entry chat takes about 60 ms instead of about 1 second.
  - Messages off screen aren't laid out.
  - A streaming reply redraws only its unfinished end, so you can select earlier text while it streams.
- **Light on the editor:**
  - The heavy parts (the web page reader, the reuse tools) load on first use. Startup loads about 66 small modules, in about 20 ms.
  - The packaged extension is bundled: 38 files instead of 8,000+.
  - Saved chats are stored one per chat, and logs are read incrementally.
  - Old log rows are pruned once a day, in the background.
- **Automatic checks** (`dualAgent.autoCheck`): when the main agent stops after editing files, the project's checks (from `.dual-agent/memory/conventions.md`) run and failures go back to it. `typecheck` (the default) runs the typecheck only; the other option adds lint and tests.
- **Measuring it:**
  - `node scripts/perf-report.mjs` prints turn times, time to first token, launch times, retries and network errors per day from your usage logs.
  - `npm run perf:activation` measures startup.
  - In VS Code, **Developer: Show Running Extensions** shows activation time as the editor sees it.

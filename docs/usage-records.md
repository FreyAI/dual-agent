# Usage, metrics and logs

What Dual Agent records about cost and failures, and where to look.

- **Usage panel** (click the token pill), for this chat, this repo, today or all time:
  - tokens per 10 minutes by agent, over the last 24 hours;
  - tokens, calls, cost and cache share per agent and per model;
  - the **Split** tab;
  - an **efficiency** section: reply times, tokens per turn, cache hit rate, tool calls and failures, retries, provider switches, compactions, and how many replies still needed Claude.
- **Records:**
  - Every model call (`calls-<machine>.jsonl`), every reply (`turns-<machine>.jsonl`), every helper launch (`helpers-<machine>.jsonl`) and the token ledger (`usage-<machine>.jsonl`) are kept in VS Code's storage. Point `dualAgent.usageFolder` at a synced folder to see usage from several machines together.
  - A helper's calls carry its launch id (`helper`) and, when they come between replies, the reply that launched it (`spawnTurn`). Its row in the helpers file has its type, model, calls, new tokens and cache re-reads, peak context, cost, time, output per tool and how its report checked out.
  - Tool output is counted as what the model reads (the tool result), per tool and per helper.
  - Costs use the price table in `src/usage.ts`. Claude's cache writes are priced by lifetime as the API reports them: 1-hour writes (the main agent) at 2x input, 5-minute writes (helpers) at 1.25x.
  - No prompt, reply or file contents are recorded. File paths and commands are, in the failure log (up to 300 characters, with anything shaped like a key masked).
  - **Dual Agent: Export Metrics (CSV)** saves one row per reply.
- **Failures and events** (`diag-<machine>.jsonl`), one row each, with the exact time (`at`, epoch milliseconds), the chat's Claude Code session, the reply (`turn`), the provider, model and agent:
  - **Failures:** API retries and errors, provider switches, tool errors, refusals, report checks, proxy errors with the provider's own reason (for example DeepSeek's "content[].thinking must be passed back"), and exceptions the extension caught (`swallowed`).
  - **What happened around them:** every warning or error the chat showed (`notice`, with `level`), each agent start (`launch`), what the post-edit checks found (`edit_check`: new errors, copied code), automatic diagnoses and restarts.
  - **What drives token use:** prompt cache misses with their cause (`cache_miss`; Claude from the API, DeepSeek when a call reads much less of its cache than the call before), tool results over 20k characters with the file or command (`big_output`), ten minutes past $3 or 1M new tokens with who spent it (`burn_spike`, also said in the chat), each compaction with the context before and after (`compaction`), and what project memory gave the agents (`memory`). Automatic turns record the helper whose report started them (`wokenBy` in the turns file).
  - **Joining them up:** the `turn` id is also on that reply's row in `turns-<machine>.jsonl` (with `route`, why auto mode picked its model) and on its model calls in `calls-<machine>.jsonl`. The session id names the full conversation in Claude Code's transcripts (`~/.claude/projects/` for Claude chats, `~/.claude-dual-agent/projects/` for DeepSeek chats).
  - **Kept** `dualAgent.logRetentionDays` (90 by default, at least 1) for failures, replies, calls and helpers; the usage ledger is billing history and stays. Request bodies are never logged, and anything shaped like a key or token in a command or error is masked.
  - **Dual Agent: Show Failures** summarizes the last 24 hours: failures by kind, diagnoses, what no rule explains yet, warnings shown in the chat, edit checks, where each reply's time went, cache misses, and the cost gates (automatic turns per message of yours, the cache-write share of Opus cost, helper calls and refusals per launch, unverified claims, Flash tokens per launch, and what memory gave the agents) against their targets.
  - **Dual Agent: Diagnose Token Burn** shows where the tokens went over the last hour, 6 hours, day or week: what to look at first, cost by chat, the busiest 10 minutes and who spent them, the costliest helper launches, the biggest tool outputs, automatic turns and which helpers caused them, cache misses, compactions and spikes.
  - A failure notice in the chat has a **Diagnose** button that hands that chat's failures to the agent.
  - Live lines are in the **Dual Agent** output panel.
- **Remote Control sessions** have no chat, so the proxy records them: each reply's usage goes in the usage and calls files (agent `remote`), and their failures, quota fallbacks and cost-limit refusals in the failure log.
- **OpenTelemetry (optional):** `dualAgent.telemetry.otlpEndpoint` sends Claude Code's own metrics and events to a collector such as Grafana, Honeycomb or Langfuse. Prompts and tool contents stay redacted.

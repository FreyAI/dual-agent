# Token balancing: how the work is shared

Claude and DeepSeek share each day's work. This page is the detailed version of [Token balancing](../README.md#token-balancing).

Pick the mode from the model pill in the top bar, the status-bar item, or **Dual Agent: Switch Provider**.

| Mode | What runs |
|---|---|
| **Auto** (default) | Claude and DeepSeek by the split below |
| **Claude** | Claude as the main agent, always |
| **DeepSeek** | DeepSeek as the main agent, always |

## The split (Auto)

`dualAgent.tokenSplit` is Claude's target share of each day's tokens in a repo; DeepSeek gets the rest. The default is **50**. Set it per repo from the **Split** tab of the usage panel (click the token count in the bottom bar). The presets are DeepSeek only, 30/70, 50/50, 70/30 and Claude only, and the tab shows today's actual shares against the target.

- **Stints:** the providers take turns, each running half its share of a usual day before handing over. At 70/30 that means Claude 35%, then DeepSeek 15%, twice a day. The provider changes only between tasks.
- **On Claude's stint**, Claude is the main agent.
- **On DeepSeek's stint**, Flash handles quick mechanical edits and V4 Pro the rest.
- **Helpers are part of the split.** When Claude leads, its helpers run on DeepSeek while DeepSeek is below its share, and back on Claude once DeepSeek is 5 points ahead (see [Helper agents](usage.md#helper-agents)). Every call is counted under the provider that served it, so the split sees the real balance.
- **Trouble moves up:**
  - Failing checks, tool errors, failed edits or many turns without success move the task to a stronger model: Flash, then V4 Pro, then Claude.
  - Inside a reply, Flash that hits two failing checks, two failed edits, four tool errors or 40 steps switches to V4 Pro at once.
  - Follow-ups like "yes, go ahead" stay on the current model.
- **Failover**, in every mode: if a provider fails (signed out, over its limit, out of credit, down), the conversation continues on the other one. A request is retried 3 times first (after 2, 5 and 10 seconds); a request the provider rejects as malformed switches at once, without being resent. The failed provider is skipped until its limit resets, or for `dualAgent.fallbackCooldownMinutes`. A failed automatic turn (a helper's report) is reported, not retried.
  - If the Claude sign-in expires mid-reply, the reply pauses on a card: **Sign in**, or **Continue on DeepSeek**.
  - A split of 0% for Claude, or `dualAgent.claudeRole` set to `off`, also rules Claude out as the fallback.
- **Quota:** Claude is skipped when your subscription use is more than 10 points ahead of the time gone in its window (80% when there's no window information), and on a quota warning or refusal. A notice says when use reaches a warning level.
- **What the split counts:** every token, cache re-reads included, against a usual day (the average of the last 7 days with use; 20M before there's history). Each repo's split is kept for that repo.

With the split turned off (`dualAgent.tokenSplit` set to `null`), `dualAgent.claudeRole` decides instead:
- `backup` (the default): DeepSeek does the work, and Claude takes over only when V4 Pro is stuck or DeepSeek is down.
- `primary`: Claude handles hard tasks while its quota keeps pace.
- `off`: auto mode never uses Claude.

# Remote Control from the Claude app

Drive a session in a folder from your phone or claude.ai, with DeepSeek answering when Claude can't.

**Phone (Claude app)** in the tune menu (or **Dual Agent: Start Remote Control**) opens a terminal running Claude Code's Remote Control server for this folder, signed in with your claude.ai account. Open the Code tab in the Claude app (or claude.ai/code) to start and drive sessions from your phone. The menu item's dot is grey while it's off, pulses while it connects, and turns green once claude.ai can reach this folder; a dot on the tune icon shows it's on.

- **DeepSeek in the same session:** `/model deepseek-flash` (or `deepseek-v4-pro`) switches a session to DeepSeek, on your DeepSeek key; `/model sonnet` switches back.
- **When Claude runs out:** if Claude answers that your quota is used up, DeepSeek answers that message and every Claude message after it until the reset time Claude gives (5 minutes if it gives none): Flash for Haiku-class requests, V4 Pro for the rest. The session keeps going. Without a DeepSeek key, Remote Control runs on Claude only.
- **How:** Remote Control works only when Claude Code talks to api.anthropic.com itself, so the local proxy is its HTTPS proxy rather than its endpoint. The proxy decrypts api.anthropic.com only, with a certificate made on this machine for that host alone (in `~/.dual-agent-tls`) and trusted only by that terminal's Claude Code. Every other host is passed through untouched, and your sign-in is never sent to DeepSeek.
- **Costs and limits:** their usage is recorded like a chat's (agent `remote`), and `dualAgent.costLimitUsd` / `modelCostLimitsUsd` apply: a request over a limit is refused with the reason. The daily budget doesn't apply, and Claude use there counts as subscription.
- **Limits:** chats in the panel can't be driven remotely; only the terminal sessions can. VS Code has to stay open, since the proxy runs inside it.
- **Compatibility:** this depends on how the bundled Claude Code treats `HTTPS_PROXY` and its first-party check. It works with the pinned version; re-test it after updating the Agent SDK.

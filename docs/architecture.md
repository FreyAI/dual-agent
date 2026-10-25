# How it works

How Dual Agent runs on Claude and DeepSeek.

Both providers run Claude Code, Anthropic's agent, through the Claude Agent SDK. Claude Code insists on api.anthropic.com, so on DeepSeek the SDK talks to a local proxy instead.

- **Claude mode:** a local HTTPS server translates between the proxy and DeepSeek's OpenAI-compatible API. Requests, streamed replies and tools go both ways.
- **Each chat:** your chat page and Claude Code share one local input/output stream, so tool calls, permissions and thoughts show as they happen, in the same reply.
- **One Claude Code per chat:** the main agent and its helpers. Background helpers take a second, so a follow-up can start while they work.
- **Some of Claude Code's own features are off:** subagent resume, title suggestion, away summaries, the pre-tool "hook runner", a hand-written `ANTHROPIC_BASE_URL` (the proxy overrides it) and the template loader, to save tokens and time.
  - Fork mode is off so parallel helpers report back in the same reply and DeepSeek keeps a stable cache prefix.
- **Pinned model names:** Sonnet, Opus, Haiku and Fable map to `dualAgent.claude.model`, `dualAgent.claude.opusModel`, `dualAgent.claude.helperModel` and `dualAgent.claude.fableModel`.
  - `deepseek-flash` and `deepseek-v4-pro` map to `dualAgent.deepseek.fastModel` and `dualAgent.deepseek.model`; both default to the newest model DeepSeek lists (`deepseek-flash` and `deepseek-v4-pro` if it can't ask).
  - Each keeps its own cache and settings, so switching provider keeps both warm.
- **Tool search:** on for both providers, which trades a small tool for most of the tool definitions.
- **Model refusal fallback:** when DeepSeek's safety classifier refuses a request, a message is answered by the next model: Flash → V4 Pro → Claude in Auto mode, or Flash → Sonnet in Claude mode.
- **Updates:** the extension never makes model calls itself, so it never spends tokens without a task, and it never asks for network access except to providers, GitHub (only when vetting an import) and the search engines.
- **What the proxy sees:** your API keys and the conversation, on this machine. Nothing is uploaded anywhere else.
- **Where things live:** the proxy is in `src/providers.ts`; the chat page in `media/chat/`; usage recording in `src/usage.ts`.

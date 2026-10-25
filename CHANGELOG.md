# Changelog

All notable changes to this extension are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.9.0] - Unreleased

First public release (beta). Tested on macOS; Windows and Linux are still untested.

### Added

- Chat panel running on Claude (claude.ai sign-in or an Anthropic key) and DeepSeek (V4 Pro and Flash), with switching mid-chat.
- Auto mode: routes each new task by type (mechanical edits to Flash, coding to V4 Pro, hard work to Claude when Claude is primary), escalates a stuck task one level, and falls back to the other provider on rate limits or errors (`dualAgent.fallbackCooldownMinutes`).
- Token split (`dualAgent.tokenSplit`): a target share of tokens per provider, run in alternating stints.
- Helper agents (searcher, quick helper, deep thinker, general purpose) on the cheaper model.
- Cost controls: spend limit, daily budget, per-model limits, cost in chat.
- Project memory, loop and failure guards, one build or test at a time per repo.
- Build modes (hybrid, reuse, craft), web search, Remote Control, Mac dictation.
- Eval suite (`npm run eval`) that measures pass rate and cost per arm.

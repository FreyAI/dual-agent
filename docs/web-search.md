# Web search

The tools the agent uses to search the web and read pages.

Three tools: **web_search** (numbered results), **web_read** (a page's main text) and **web_search_and_read**. The agent cites what it uses as [n].

- **Free fallbacks:** DuckDuckGo, then DuckDuckGo Lite, then Brave's public results. A site that rate-limits is rested for 5 minutes, and repeat searches come from a 10-minute cache. These sites block scripted searches after one or two, so `auto` doesn't rely on them.
- **Optional keys:** `BRAVE_API_KEY=` or `TAVILY_API_KEY=` in the [credentials file](../README.md#provider-configuration); that API is then tried first, and `auto` gives DeepSeek these tools.
- **Safety:** web content reaches the agent marked as untrusted, with hidden characters and fake wrapper tags stripped, and the agent is told never to follow instructions in it.
- **Which tools each provider uses** (`dualAgent.webTools`):
  - `auto`: Claude Code's own web search on both (DeepSeek runs it server-side; $0.75 per 1,000 searches from 2026-11-01), or these tools on DeepSeek once a search key is set.
  - `dualAgent`: these tools on both.
  - `builtin`: Claude Code's on both.
- PDFs can't be read yet.

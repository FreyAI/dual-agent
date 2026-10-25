/**
 * The web tools the agents get: web_search, web_read and web_search_and_read,
 * served in-process to Claude Code as an MCP server named "web". Every result
 * is wrapped as untrusted (see untrusted.ts) and numbered as a source to cite.
 */
import type * as Sdk from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { z } from 'zod';
import { ReadPage, readPage } from './read';
import { SearchEngine, SearchResult } from './search';
import { SourceList } from './sources';
import { wrapUntrusted } from './untrusted';
import { reply, toolFailed } from '../mcp';
import { errorMessage as failure, short } from '../text';

/** web_search_and_read stops reading pages after this, so with the 30 s search it stays well inside the 120 s tool limit. */
const READ_BUDGET_MS = 40_000;

const site = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

function formatResult(n: number, r: SearchResult) {
  return `[${n}] ${short(r.title || site(r.url), 140)} — ${site(r.url)}${r.date ? ` · ${r.date}` : ''}\n${r.url}\n${short(r.snippet, 320)}`;
}

function formatPage(n: number, page: ReadPage) {
  const more =
    page.totalChars > page.text.length
      ? `\n\n(Showing ${page.text.length.toLocaleString()} of ${page.totalChars.toLocaleString()} characters. Call web_read with a larger max_chars for more.)`
      : '';
  return `[${n}] ${page.title} — ${page.url}${page.pdf ? ' (PDF)' : ''}\n\n${page.text}${more}`;
}

export interface WebDeps {
  engine: SearchEngine;
  sources: SourceList;
  read?: typeof readPage;
  /** Tests: READ_BUDGET_MS. */
  readBudgetMs?: number;
}

export function createWebServer(sdk: typeof Sdk, deps: WebDeps) {
  const { engine, sources } = deps;
  const read = deps.read ?? readPage;
  const budget = deps.readBudgetMs ?? READ_BUDGET_MS;
  const annotations = { readOnlyHint: true, openWorldHint: true };

  const webSearch = sdk.tool(
    'web_search',
    'Searches the web and returns numbered results ([n] title — site, URL, snippet). Use it for anything current, factual or outside your knowledge ' +
      '(news, prices, releases, docs, error messages, people, places). Snippets are short and can be stale: before answering a factual question, ' +
      'call web_read on the 1–3 most relevant results (or use web_search_and_read). Cite sources in your answer as [n] using only these numbers.',
    {
      query: z.string().min(1).describe("Search query, as you'd type it into a search engine. Add a year or 'latest' for current events."),
      count: z.number().int().min(1).max(10).optional().describe('Number of results, 1–10 (default 6)'),
    },
    async ({ query, count }) => {
      try {
        const out = await engine.search(query, count ?? 6);
        if (!out.results.length) {
          return reply(wrapUntrusted('web_search', `No results for "${query}" (via ${out.provider}). Try other words.`));
        }
        const blocks = out.results.map((r) => formatResult(sources.number(r.url), r));
        const head = `Web results for "${query}" (via ${out.provider}${out.cached ? ', from a search a few minutes ago' : ''}):`;
        return reply(`${wrapUntrusted('web_search', `${head}\n\n${blocks.join('\n\n')}`)}\nNext: web_read the most relevant 1–3 URLs before answering, and cite them as [n].`);
      } catch (err) {
        return reply(toolFailed('web_search', err), true);
      }
    },
    { annotations },
  );

  const webRead = sdk.tool(
    'web_read',
    "Opens a web page and returns its main readable text (headings as #, list items as -), numbered as a source [n] to cite. Use it on search results before answering, or on any link the user gives you. If the text is cut short and you need more, call again with a larger max_chars.",
    {
      url: z.string().min(1).describe('The page to read (http or https; a bare domain is fine)'),
      max_chars: z.number().int().min(500).max(12000).optional().describe('Most characters to return, 500–12000 (default 6000)'),
    },
    async ({ url, max_chars }) => {
      try {
        const page = await read(url, max_chars ?? 6000);
        return reply(wrapUntrusted('web_read', formatPage(sources.number(page.url), page)));
      } catch (err) {
        return reply(`Couldn't read ${url}: ${toolFailed('web_read', err)}`, true);
      }
    },
    { annotations },
  );

  const searchAndRead = sdk.tool(
    'web_search_and_read',
    "Searches the web and reads the top results in one step (faster than web_search followed by several web_read calls). Returns each page's main text, " +
      "numbered [n] for citation, plus the other results' titles. Best for factual or current questions that need a few good sources.",
    {
      query: z.string().min(1).describe("Search query, as you'd type it into a search engine"),
      count: z.number().int().min(1).max(5).optional().describe('Pages to read, 1–5 (default 3)'),
    },
    async ({ query, count }) => {
      const want = count ?? 3;
      const stop = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        const out = await engine.search(query, want + 4);
        if (!out.results.length) {
          return reply(wrapUntrusted('web_search_and_read', `No results for "${query}" (via ${out.provider}). Try other words.`));
        }
        const perPage = Math.min(2500, Math.floor(7000 / want));
        const pending = [...out.results];
        const pages: { n: number; page: ReadPage }[] = [];
        const failed: string[] = [];
        // Three at a time; a page that fails is replaced by the next result. Slow pages are cut off at the budget.
        timer = setTimeout(() => stop.abort(new Error(`still loading after ${budget / 1000}s`)), budget);
        const worker = async () => {
          while (pages.length < want && pending.length && !stop.signal.aborted) {
            const r = pending.shift()!;
            try {
              const page = await read(r.url, perPage, stop.signal);
              if (pages.length < want) {
                pages.push({ n: sources.number(page.url), page });
              }
            } catch (err) {
              failed.push(`${site(r.url)}: ${failure(err)}`);
            }
          }
        };
        await Promise.all([worker(), worker(), worker()]);
        pages.sort((a, b) => a.n - b.n);
        const readUrls = new Set(pages.map((p) => p.page.url));
        const others = pending.filter((r) => !readUrls.has(r.url)).map((r) => `[${sources.number(r.url)}] ${short(r.title, 110)} — ${r.url}`);
        const body = [
          `Pages for "${query}" (via ${out.provider}):`,
          pages.map((p) => formatPage(p.n, p.page)).join('\n\n---\n\n') || '(None of the pages could be read.)',
          others.length ? `Other results (not read; use web_read if needed):\n${others.join('\n')}` : '',
          failed.length ? `Couldn't read: ${failed.join('; ')}` : '',
        ];
        return reply(wrapUntrusted('web_search_and_read', body.filter(Boolean).join('\n\n')));
      } catch (err) {
        return reply(toolFailed('web_search_and_read', err), true);
      } finally {
        clearTimeout(timer);
      }
    },
    { annotations },
  );

  return sdk.createSdkMcpServer({ name: 'web', version: '1.0.0', timeout: 120_000, tools: [webSearch, webRead, searchAndRead] });
}

import '../helpers/vscodeStub';
import { test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { FakeWeb } from '../helpers/fakeWeb';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Endpoints, ParseError, SearchEngine, SearchProvider, buildProviders, parseBraveHtml, parseDdgHtml, unwrapDdgLink } from '../../web/search';
import { allowPrivateHosts, extractReadable, normalizeUrl, readPage, trimText } from '../../web/read';
import { BlockedError, HttpResponse, StatusError, isPrivateAddress, parseJson } from '../../web/http';
import { recentDiag, resetDiag } from '../../diag/log';
import { wrapUntrusted } from '../../web/untrusted';
import { createWebServer } from '../../web/tools';
import { SourceList } from '../../web/sources';
import { ARTICLE_HTML } from '../helpers/fakeWeb';

const web = new FakeWeb();
let endpoints: Endpoints;
let sdk: any;

before(async () => {
  // The fake web is served from localhost, which page reads otherwise refuse.
  allowPrivateHosts(true);
  endpoints = await web.start();
  sdk = await import('@anthropic-ai/claude-agent-sdk');
});
after(() => web.stop());
beforeEach(() => {
  web.hits.length = 0;
  web.behaviour = { ddgHtml: 'ok', ddgLite: 'ok', braveHtml: 'ok', braveApi: 'ok', tavily: 'ok' };
});

const engine = (keys = {}) => new SearchEngine(() => buildProviders(keys, endpoints), { minGapMs: 0 });

test('DuckDuckGo results: real links unwrapped, ads skipped, duplicates merged', async () => {
  const out = await engine().search('late fees', 10);
  assert.equal(out.provider, 'DuckDuckGo');
  assert.deepEqual(out.results.map((r) => r.url), [`${web.base}/article`, `${web.base}/calculator`, `${web.base}/missing`, `${web.base}/article2`]);
  assert.equal(out.results[0].snippet, 'A late fee is charged when a payment arrives after its due date.');
  const hit = web.hitsTo('/ddg-html')[0];
  assert.equal(hit.method, 'POST');
  assert.match(hit.body, /q=late\+fees/);
  assert.match(String(hit.headers['user-agent']), /Safari/);
});

test('the DuckDuckGo link unwrapper keeps ordinary links as they are', () => {
  assert.equal(unwrapDdgLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fx&rut=1'), 'https://a.example/x');
  assert.equal(unwrapDdgLink('https://b.example/y'), 'https://b.example/y');
});

test('Brave results pages: titles from the title attribute, dates split off', () => {
  const [r] = parseBraveHtml(`<div class="snippet" data-type="web"><a href="https://x.example/a"><div class="title" title="Full title">Full ti…</div></a><div class="snippet-description">10 hours ago - The snippet.</div></div>`);
  assert.deepEqual(r, { title: 'Full title', url: 'https://x.example/a', snippet: 'The snippet.', date: '10 hours ago' });
});

test('with API keys, Brave Search then Tavily are tried first, with their keys', async () => {
  const out = await engine({ brave: 'brave-key', tavily: 'tavily-key' }).search('late fees');
  assert.equal(out.provider, 'Brave Search');
  assert.equal(out.results[0].title, 'Late fees (API)', 'tags stripped');
  assert.equal(out.results[0].date, '2 days ago');
  assert.equal(web.hitsTo('/brave-api')[0].headers['x-subscription-token'], 'brave-key');

  web.behaviour.braveApi = 'blocked';
  const out2 = await engine({ brave: 'brave-key', tavily: 'tavily-key' }).search('other fees');
  assert.equal(out2.provider, 'Tavily');
  assert.equal(web.hitsTo('/tavily')[0].headers.authorization, 'Bearer tavily-key');
  assert.equal(JSON.parse(web.hitsTo('/tavily')[0].body).query, 'other fees');
  assert.ok(out2.results[0].snippet.length <= 500);
});

test('a blocked provider falls through to the next, and is rested on later searches', async () => {
  web.behaviour.ddgHtml = 'blocked';
  web.behaviour.ddgLite = 'blocked';
  const e = engine();
  const out = await e.search('first');
  assert.equal(out.provider, 'Brave');
  web.hits.length = 0;
  await e.search('second');
  assert.equal(web.hitsTo('/ddg').length, 0, 'DuckDuckGo is left alone after blocking us');
  assert.equal(web.hitsTo('/brave-html').length, 1);
});

test('when every provider blocks, the error says how to fix it', async () => {
  web.behaviour = { ddgHtml: 'blocked', ddgLite: 'blocked', braveHtml: 'blocked', braveApi: 'ok', tavily: 'ok' };
  await assert.rejects(engine().search('x'), /blocked right now.*BRAVE_API_KEY or TAVILY_API_KEY/);
});

test('no results gets one second opinion from another site, then stops', async () => {
  web.behaviour = { ddgHtml: 'empty', ddgLite: 'empty', braveHtml: 'empty', braveApi: 'ok', tavily: 'ok' };
  const out = await engine().search('nothing matches this');
  assert.deepEqual(out.results, []);
  assert.equal(web.hitsTo('/ddg-lite').length, 0, 'the other DuckDuckGo page is the same site, so no second opinion there');
  assert.equal(web.hitsTo('/brave-html').length, 1);
});

test('repeat searches come from the cache', async () => {
  const e = engine();
  await e.search('Late  Fees', 4);
  const again = await e.search('late fees', 3);
  assert.equal(again.cached, true);
  assert.equal(again.results.length, 3);
  assert.equal(web.hitsTo('/ddg-html').length, 1);
});

test('searches to the same site are spaced out', async () => {
  const e = new SearchEngine(() => buildProviders({}, endpoints), { minGapMs: 300 });
  const started = Date.now();
  await Promise.all([e.search('one'), e.search('two'), e.search('three')]);
  assert.ok(Date.now() - started >= 550, `took ${Date.now() - started}ms`);
});

test('reading a page returns its main text, without menus, cookie banners and footers', async () => {
  const page = await readPage(`${web.base}/article`);
  assert.equal(page.title, 'Late fees explained');
  assert.match(page.text, /^#{1,2} How late fees work/m, 'Readability may demote the article title to ##');
  assert.match(page.text, /^## Calculating the fee/m);
  assert.match(page.text, /^- Grace period: three days$/m);
  assert.match(page.text, /Days late \| Fee/);
  assert.doesNotMatch(page.text, /Log in|cookies|Copyright/);
  assert.equal(page.totalChars, page.text.length);
});

test('long pages are cut at a sentence or line end, with the full length reported', async () => {
  const full = await readPage(`${web.base}/article`);
  const page = await readPage(`${web.base}/article`, 500);
  assert.ok(page.text.length <= 500 && page.text.length >= 400, `cut near the limit (${page.text.length})`);
  assert.equal(page.totalChars, full.text.length);
  assert.ok(full.text.startsWith(page.text));
  assert.equal(full.text[page.text.length], '\n', 'cut at the end of a line');
  // A sentence end within the last 20% of the limit is used; otherwise the text is cut at the limit.
  assert.equal(trimText(`${'a'.repeat(90)}. ${'b'.repeat(20)}`, 100), `${'a'.repeat(90)}.`);
  assert.equal(trimText(`${'a'.repeat(50)}. ${'b'.repeat(60)}`, 100).length, 100);
});

test('plain text, PDFs, missing pages and slow sites', async () => {
  assert.equal((await readPage(`${web.base}/notes.txt`)).text, 'plain text notes\nline two');
  const pdf = await readPage(`${web.base}/doc.pdf`);
  assert.equal(pdf.pdf, true);
  assert.match(pdf.text, /PDF/);
  await assert.rejects(readPage(`${web.base}/missing`), /doesn't exist \(HTTP 404\)/);
  assert.equal(normalizeUrl('example.com/docs'), 'https://example.com/docs');
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /only http and https/);
});

test('web content is wrapped as untrusted: hidden characters removed, fake tags defused', () => {
  const { text } = extractReadable(ARTICLE_HTML);
  const wrapped = wrapUntrusted('web_read', text);
  assert.ok(wrapped.startsWith('<untrusted source="web_read">\n'));
  assert.ok(wrapped.endsWith('\n</untrusted>'));
  assert.equal((wrapped.match(/<\/untrusted>/g) ?? []).length, 1, 'the page cannot close the wrapper early');
  assert.equal((wrapped.match(/<untrusted/g) ?? []).length, 1, 'or open a fake one');
  assert.doesNotMatch(wrapped, /[​‮]/);
  assert.match(wrapUntrusted('x', 'a'.repeat(20_000)), /…\[truncated\]\n<\/untrusted>$/);
});

/** Runs one of the server's tools directly, as Claude Code would through MCP. */
async function call(server: any, name: string, args: Record<string, unknown>) {
  const defs = server.__tools as any[];
  const def = defs.find((d) => d.name === name);
  return def.handler(args, {});
}

function tools(keys = {}) {
  const sources = new SourceList();
  const e = engine(keys);
  // Keep hold of the tool definitions so the tests can call their handlers.
  const fakeSdk = { ...sdk, createSdkMcpServer: (opts: any) => ({ ...sdk.createSdkMcpServer(opts), __tools: opts.tools }) };
  return { server: createWebServer(fakeSdk, { engine: e, sources }), sources };
}

test('web_search: numbered results with site, link and snippet, wrapped as untrusted', async () => {
  const { server } = tools();
  const res = await call(server, 'web_search', { query: 'late fees', count: 2 });
  const text = res.content[0].text as string;
  assert.equal(res.isError, false);
  assert.match(text, /^<untrusted source="web_search">\nWeb results for "late fees" \(via DuckDuckGo\):/);
  assert.match(text, /\[1\] How late fees work — 127\.0\.0\.1\n.*\/article\nA late fee is charged/);
  assert.match(text, /\[2\] Late fee calculator/);
  assert.match(text, /Next: web_read the most relevant 1–3 URLs before answering, and cite them as \[n\]\.$/);
});

test('sources keep their numbers for the whole conversation', async () => {
  const { server } = tools();
  await call(server, 'web_search', { query: 'late fees', count: 2 });
  const read = await call(server, 'web_read', { url: `${web.base}/calculator` });
  assert.match(read.content[0].text, /^<untrusted source="web_read">\n\[2\] Late fees explained — .*\/calculator/);
});

test('web_search_and_read reads the top pages, replacing ones that fail, and lists the rest', async () => {
  const { server } = tools();
  const res = await call(server, 'web_search_and_read', { query: 'late fees', count: 3 });
  const text = res.content[0].text as string;
  assert.equal((text.match(/^\[\d\] Late fees explained/gm) ?? []).length, 3, 'three pages read');
  assert.match(text, /Couldn't read: 127\.0\.0\.1: that page doesn't exist/);
  assert.match(text, /# How late fees work/);
  assert.equal((text.match(/\n---\n/g) ?? []).length, 2);
});

test('tool errors are reported as errors, not as content', async () => {
  web.behaviour = { ddgHtml: 'blocked', ddgLite: 'blocked', braveHtml: 'blocked', braveApi: 'ok', tavily: 'ok' };
  const { server } = tools();
  const res = await call(server, 'web_search', { query: 'x' });
  assert.equal(res.isError, true);
  const read = await call(server, 'web_read', { url: `${web.base}/missing` });
  assert.equal(read.isError, true);
  assert.match(read.content[0].text, /^Couldn't read .*: that page doesn't exist/);
});

test('page reads refuse local and private addresses, also through a redirect', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  allowPrivateHosts(false);
  try {
    await assert.rejects(readPage(`${web.base}/article`), /local or private address/);
    await assert.rejects(readPage('http://169.254.169.254/latest/meta-data'), /local or private address/);
  } finally {
    allowPrivateHosts(true);
  }
});

// --- failure handling ---

/** A provider for the engine tests: `run` decides what each search does. */
function fake(id: string, run: (signal?: AbortSignal) => Promise<{ title: string; url: string; snippet: string }[]>): SearchProvider & { calls: number } {
  const p = { id, label: id, rateKey: id, calls: 0, search: (_q: string, _n: number, signal?: AbortSignal) => { p.calls++; return run(signal); } };
  return p;
}
const hit = [{ title: 'A', url: 'https://a.example/', snippet: '' }];
const hangs = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));

test('a results page that cannot be parsed is a ParseError with a short sample, not a block', () => {
  const page = `<html><head><title>New layout</title><script>var secret = 1;</script></head><body>${'Something changed. '.repeat(40)}</body></html>`;
  assert.throws(() => parseDdgHtml(page), (err: unknown) => {
    assert.ok(err instanceof ParseError && !(err instanceof BlockedError));
    assert.ok(err.sample.length <= 200 && err.sample.startsWith('New layout Something changed.'));
    assert.doesNotMatch(err.sample, /secret/);
    return true;
  });
  assert.throws(() => parseBraveHtml('<html><body>hello</body></html>'), ParseError);
});

test('a parse failure is logged with its sample and the provider is not rested', async () => {
  resetDiag();
  const broken = fake('broken', async () => { throw new ParseError('Broken returned a page without results', '<p>odd page</p>'); });
  const good = fake('good', async () => hit);
  const e = new SearchEngine(() => [broken, good], { minGapMs: 0, cacheTtlMs: 0 });
  assert.equal((await e.search('one')).provider, 'good');
  await e.search('two');
  assert.equal(broken.calls, 2, 'tried again on the next search');
  const rows = recentDiag(60_000).filter((r) => r.code === 'web_search');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].target, 'broken');
  assert.match(rows[0].detail!, /without results: odd page/);
  resetDiag();
});

test('a timeout, network error or 5xx rests a provider briefly; a bad key or bad query does not', async () => {
  const slow = fake('slow', async () => { throw new Error('timed out after 15s'); });
  const down = fake('down', async () => { throw new StatusError('Down returned HTTP 502', 502); });
  const badKey = fake('bad-key', async () => { throw new StatusError('Bad rejected the API key', 401); });
  const good = fake('good', async () => hit);
  const e = new SearchEngine(() => [slow, down, badKey, good], { minGapMs: 0, cacheTtlMs: 0, failRestMs: 200 });
  await e.search('one');
  await e.search('two');
  assert.deepEqual([slow.calls, down.calls, badKey.calls], [1, 1, 2]);
  await new Promise((r) => setTimeout(r, 250));
  await e.search('three');
  assert.deepEqual([slow.calls, down.calls], [2, 2], 'back after the rest');
});

test('one deadline covers the whole search and cancels the request in flight, without resting it', async () => {
  let cancelled = false;
  const stuck = fake('stuck', (signal) => { signal?.addEventListener('abort', () => (cancelled = true)); return hangs(signal); });
  const never = fake('never', async () => hit);
  const e = new SearchEngine(() => [stuck, never], { minGapMs: 0, cacheTtlMs: 0, deadlineMs: 100 });
  const started = Date.now();
  await assert.rejects(e.search('x'), /Web search failed\. stuck: out of time \(0.1s for the whole search\)/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(cancelled, true);
  assert.equal(never.calls, 0, 'no provider is started after the deadline');
  await assert.rejects(e.search('y'));
  assert.equal(stuck.calls, 2, 'running out of time is not the provider\'s fault');
});

test('a non-JSON reply from a search API says so', () => {
  const res = (contentType: string, body: string): HttpResponse =>
    ({ status: 200, url: 'https://api.example/', contentType, headers: new Headers(), bytes: Buffer.from(body), truncated: false, text: () => body });
  assert.throws(() => parseJson(res('text/html; charset=utf-8', '<html>Log in to the Wi-Fi</html>')), /non-JSON reply \(HTTP 200, text\/html; charset=utf-8\)/);
  assert.throws(() => parseJson(res('', '')), /no content type/);
  assert.deepEqual(parseJson(res('application/json', '{"a":1}')), { a: 1 });
});

test('web_search_and_read stops waiting for slow pages at its budget and says which', async () => {
  const pages = [`${web.base}/slow`, `${web.base}/article`].map((url, i) => ({ title: `P${i}`, url, snippet: '' }));
  const e = new SearchEngine(() => [fake('fake', async () => pages)], { minGapMs: 0 });
  const fakeSdk = { ...sdk, createSdkMcpServer: (opts: any) => ({ ...sdk.createSdkMcpServer(opts), __tools: opts.tools }) };
  const server = createWebServer(fakeSdk, { engine: e, sources: new SourceList(), readBudgetMs: 300 });
  const started = Date.now();
  const res = await call(server, 'web_search_and_read', { query: 'q', count: 2 });
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  const text = res.content[0].text as string;
  assert.match(text, /How late fees work/);
  assert.match(text, /Couldn't read: 127\.0\.0\.1: still loading after 0\.3s/);
});

test('a failing web tool writes one tool_error row', async () => {
  resetDiag();
  web.behaviour = { ddgHtml: 'blocked', ddgLite: 'blocked', braveHtml: 'blocked', braveApi: 'ok', tavily: 'ok' };
  const { server } = tools();
  await call(server, 'web_search', { query: 'x' });
  await call(server, 'web_read', { url: `${web.base}/missing` });
  assert.deepEqual(recentDiag(60_000).map((r) => [r.kind, r.code]), [['tool_error', 'web_search'], ['tool_error', 'web_read']]);
  resetDiag();
});

test('huge pages are cut at 2 MB before parsing, and an article-less page still gives its text', async () => {
  const filler = `<p>${'word '.repeat(1000)}</p>`;
  const big = `<html><head><title>Big</title></head><body><main><h1>Start of the page</h1>${filler.repeat(800)}</main></body></html>`;
  const server = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(big); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const page = await readPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, 2000);
    assert.ok(big.length > 3 * 1024 * 1024);
    assert.match(page.text, /Start of the page/);
    assert.ok(page.totalChars < 2.1 * 1024 * 1024, `parsed ${page.totalChars} chars`);
  } finally {
    server.close();
  }
  const short = extractReadable('<html><head><title>Tiny</title></head><body><nav>Menu</nav><main><p>Only a line.</p></main></body></html>');
  assert.deepEqual(short, { title: 'Tiny', text: 'Only a line.' });
});

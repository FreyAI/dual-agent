import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import * as net from 'net';
import * as https from 'https';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { hostCert, makeHostCert } from '../../proxy/cert';
import { AnthropicRequest, Block, Message, maskOldToolResults } from '../../proxy/mask';
import { errorReason, requestMeta, startProxy } from '../../proxy/server';
import { usageTap } from '../../proxy/usageTap';
import { declareInlineTools } from '../../proxy/inlineTools';
import { CACHE_USER_ID, stableUserId, stableUserIdBytes } from '../../proxy/cacheScope';
import { cachedLookup, dnsCache } from '../../proxy/dns';
import * as dns from 'dns';
import { MISSING_THINKING, keepThinking } from '../../proxy/thinkingReplay';
import { fixPatterns } from '../../proxy/schemaFix';
import { forDeepSeek, limitResetsAt, proxyProcessPid, proxyUrl, routeDeepSeekHelpers, runProxiesInChildProcess, setProxyLog, setRemoteHooks, stopProxies, toDeepSeek } from '../../proxy/registry';
import { recentDiag, resetDiag } from '../../diag/log';
import { missRow, resetCacheDiagnostics, setCacheDiagnostics, tagRequest } from '../../proxy/cacheDiag';
import { finalOutput } from '../../metrics/calls';

const BIG = Array.from({ length: 50 }, (_, i) => `line ${i} of a long tool output`).join('\n');

/** A conversation of n tool round-trips; the last user message holds the last result. */
function convo(n: number, content: (i: number) => Block['content'] = () => BIG): AnthropicRequest {
  const messages: Message[] = [{ role: 'user', content: 'fix the bug' }];
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `cmd ${i}` } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: content(i) }] });
  }
  return { model: 'deepseek-chat', system: 'sys', tools: [{ name: 'Bash' }], messages };
}

const results = (b: AnthropicRequest): Block[] =>
  (b.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((x) => x.type === 'tool_result') : []));
const isMasked = (b: Block) => JSON.stringify(b.content).includes('[Old tool output');
const maskedFlags = (b: AnthropicRequest) => results(b).map(isMasked);

test('boundary advances only in whole batches', () => {
  const count = (n: number) => maskOldToolResults(convo(n)).maskedCount;
  assert.equal(count(9), 0);
  assert.equal(count(17), 0);
  assert.equal(count(18), 10);
  assert.equal(count(19), 10);
  assert.equal(count(27), 10);
  assert.equal(count(28), 20);
});

test('consecutive requests within a batch share a byte-identical prefix', () => {
  const prefix = (n: number, upto: number) => JSON.stringify(maskOldToolResults(convo(n)).body.messages!.slice(0, upto));
  const upto = 1 + 2 * 18;
  assert.equal(prefix(18, upto), prefix(19, upto));
  assert.equal(prefix(19, upto), prefix(27, upto));
  assert.notEqual(prefix(27, upto), prefix(28, upto));
});

test('placeholder keeps ids and error flag; assistant turns untouched', () => {
  const body = convo(19);
  (results(body)[0] as Block).is_error = true;
  const r = maskOldToolResults(body);
  const first = results(r.body)[0];
  assert.equal(first.tool_use_id, 't0');
  assert.equal(first.is_error, true);
  assert.deepEqual(first.content, [{ type: 'text', text: `[Old tool output (50 lines, ${BIG.length} chars) cleared to save context. Re-run the tool if you need it again.]` }]);
  assert.deepEqual(r.body.messages!.filter((m) => m.role === 'assistant'), body.messages!.filter((m) => m.role === 'assistant'));
  assert.equal(r.body.system, body.system);
  assert.equal(r.body.tools, body.tools);
  assert.ok(r.savedChars > 0);
});

test('small results are kept', () => {
  const r = maskOldToolResults(convo(19, (i) => (i % 2 ? 'ok' : BIG)));
  assert.equal(r.maskedCount, 5);
  assert.deepEqual(maskedFlags(r.body).slice(0, 10), [true, false, true, false, true, false, true, false, true, false]);
});

test('array content with text and image is masked; mixed string/array', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(1000) } };
  const r = maskOldToolResults(convo(18, (i) => (i % 2 ? [{ type: 'text', text: 'shot' }, img] : BIG)));
  assert.equal(r.maskedCount, 10);
  assert.ok(!JSON.stringify(r.body).slice(0, JSON.stringify(r.body).indexOf('t10')).includes('AAAA'));
});

test('last user message is never touched', () => {
  const body = convo(0);
  body.messages!.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] });
  body.messages!.push({ role: 'user', content: Array.from({ length: 12 }, (_, i) => ({ type: 'tool_result', tool_use_id: `p${i}`, content: BIG })) });
  const r = maskOldToolResults(body, { keepRecent: 0 });
  assert.equal(r.maskedCount, 0);
  assert.equal(r.body, body);
});

test('input is not mutated and re-masking is idempotent', () => {
  const body = convo(19);
  const before = JSON.stringify(body);
  const once = maskOldToolResults(body);
  assert.equal(JSON.stringify(body), before);
  const twice = maskOldToolResults(once.body);
  assert.equal(twice.maskedCount, 0);
  assert.equal(JSON.stringify(twice.body), JSON.stringify(once.body));
});

// --- server ---

interface Seen { path?: string; headers?: http.IncomingHttpHeaders; body?: string }

async function fakeUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void) {
  const seen: Seen = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      Object.assign(seen, { path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      handler(req, res, seen);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/anthropic`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

function send(url: string, path: string, body: string, headers: http.OutgoingHttpHeaders = {}, onChunk?: (c: string) => void) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => { text += c; onChunk?.(c.toString()); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const ok = (_q: http.IncomingMessage, res: http.ServerResponse) => res.end('{"ok":true}');

test('masks long request bodies and forwards headers and path', async () => {
  const up = await fakeUpstream(ok);
  const proxy = await startProxy({ upstream: up.url });
  try {
    const r = await send(proxy.url, '/v1/messages?beta=true', JSON.stringify(convo(19)), { 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });
    assert.equal(r.status, 200);
    assert.equal(up.seen.path, '/anthropic/v1/messages?beta=true');
    assert.equal(up.seen.headers!['x-api-key'], 'sk-test');
    assert.equal(up.seen.headers!['anthropic-version'], '2023-06-01');
    assert.equal(up.seen.headers!['content-length'], String(Buffer.byteLength(up.seen.body!)));
    assert.equal(maskedFlags(JSON.parse(up.seen.body!)).filter(Boolean).length, 10);
    assert.equal(proxy.stats().masked, 10);
    assert.equal(proxy.stats().requests, 1);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('mask: false and non-JSON bodies pass through unchanged', async () => {
  const up = await fakeUpstream(ok);
  const off = await startProxy({ upstream: up.url, mask: false });
  const on = await startProxy({ upstream: up.url });
  try {
    const raw = JSON.stringify(convo(19));
    await send(off.url, '/v1/messages', raw);
    assert.equal(up.seen.body, raw);
    await send(on.url, '/v1/messages', '{not json');
    assert.equal(up.seen.body, '{not json');
  } finally {
    await off.stop();
    await on.stop();
    await up.close();
  }
});

test('SSE response streams chunk by chunk', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let upstreamDone = false;
  const up = await fakeUpstream((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {}\n\n');
    gate.then(() => { upstreamDone = true; res.end('event: message_stop\ndata: {}\n\n'); });
  });
  const proxy = await startProxy({ upstream: up.url });
  try {
    let firstBeforeEnd: boolean | undefined;
    const r = await send(proxy.url, '/v1/messages', '{}', {}, () => {
      if (firstBeforeEnd === undefined) { firstBeforeEnd = !upstreamDone; release(); }
    });
    assert.equal(firstBeforeEnd, true);
    assert.equal(r.headers['content-type'], 'text/event-stream');
    assert.match(r.body, /message_start[\s\S]*message_stop/);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('upstream down is a retryable 529 logged with the step; a failure that isn\'t the network gives a 502 JSON error', async () => {
  const up = await fakeUpstream(ok);
  await up.close();
  const { lines, log } = collect();
  const proxy = await startProxy({ upstream: up.url, log });
  // TLS to a plain HTTP server: a protocol error, not the network.
  const plain = await fakeUpstream(ok);
  const mismatch = await startProxy({ upstream: plain.url.replace('http:', 'https:') });
  try {
    assertRetryFast(await send(proxy.url, '/v1/messages', '{}'), /\(ECONNREFUSED\)/);
    assert.match(lines[0].line, /upstream error ECONNREFUSED \(connect: connect ECONNREFUSED 127\.0\.0\.1:\d+\)/);
    const r = await send(mismatch.url, '/v1/messages', '{}');
    assert.equal(r.status, 502);
    const err = JSON.parse(r.body);
    assert.equal(err.type, 'error');
    assert.match(err.error.message, /unreachable/);
  } finally {
    await proxy.stop();
    await mismatch.stop();
    await plain.close();
  }
});

test('stop() closes the listener', async () => {
  const up = await fakeUpstream(ok);
  const proxy = await startProxy({ upstream: up.url });
  await proxy.stop();
  await assert.rejects(send(proxy.url, '/v1/messages', '{}'), /ECONNREFUSED/);
  await up.close();
});

test('an oversized body gets a 413 Anthropic error and never reaches the upstream', async () => {
  const up = await fakeUpstream(ok);
  const proxy = await startProxy({ upstream: up.url, maxBodyBytes: 1024 });
  try {
    const declared = await send(proxy.url, '/v1/messages', 'x'.repeat(2048));
    assert.equal(declared.status, 413);
    assert.equal(JSON.parse(declared.body).error.type, 'request_too_large');
    const chunked = await send(proxy.url, '/v1/messages', 'x'.repeat(2048), { 'transfer-encoding': 'chunked' });
    assert.equal(chunked.status, 413, 'a chunked upload is counted as it arrives');
    assert.equal(up.seen.path, undefined);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a client that hangs up mid-upload is dropped without calling the upstream', async () => {
  const up = await fakeUpstream(ok);
  const proxy = await startProxy({ upstream: up.url });
  try {
    const req = http.request(proxy.url + '/v1/messages', { method: 'POST', headers: { 'content-length': 1000 } });
    req.on('error', () => undefined);
    req.write('{"partial":');
    await new Promise((r) => setTimeout(r, 50));
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(up.seen.path, undefined);
    assert.equal((await send(proxy.url, '/v1/messages', '{}')).status, 200, 'the proxy keeps serving');
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a proxy that fails to start is logged and retried on the next launch', async () => {
  const lines: string[] = [];
  setProxyLog((l) => lines.push(l));
  try {
    assert.equal(await proxyUrl('not a url', 'mask'), undefined);
    assert.equal(await proxyUrl('not a url', 'mask'), undefined);
    assert.equal(lines.length, 2, 'not cached as a failure');
    assert.match(lines[0], /failed to start.*Invalid URL/);
  } finally {
    setProxyLog(() => undefined);
    await stopProxies();
  }
});

const INLINE_TOOL = { name: 'mcp__web__web_read', description: 'Read a page', input_schema: { type: 'object' } };
/** What Claude Code sends when it adds a tool mid-conversation ("inline tools"). */
const withInlineTool = (): AnthropicRequest => ({
  model: 'deepseek-v4-pro',
  tools: [{ name: 'Bash' }],
  messages: [
    { role: 'user', content: 'read the docs page' },
    { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: INLINE_TOOL } }, { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Old' } }] },
    { role: 'user', content: 'go on' },
  ],
});

test('inline tool definitions DeepSeek rejects become deferred tools shown by reference', () => {
  const body = withInlineTool();
  const out = declareInlineTools(body)!;
  assert.deepEqual(out.messages![1].content, [
    { type: 'tool_addition', tool: { type: 'tool_reference', name: 'mcp__web__web_read' } },
  ], 'DeepSeek has no tool_removal type: dropped');
  assert.deepEqual(out.tools, [{ name: 'Bash' }, { ...INLINE_TOOL, defer_loading: true }]);
  assert.equal((body.messages![1].content as Block[])[0].tool && ((body.messages![1].content as Block[])[0].tool as any).type, 'tool_definition', 'the input is not mutated');
  assert.equal(declareInlineTools(convo(3)), undefined, 'nothing to change: undefined, so the bytes pass through');
  const twice = declareInlineTools({ ...body, tools: [{ name: 'mcp__web__web_read' }] })!;
  assert.equal((twice.tools as unknown[]).length, 1, 'a tool already declared is not added again');
});

test('a tool removed after a switch from Claude is neither shown nor declared to DeepSeek', () => {
  const removal = { role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: INLINE_TOOL.name } }] };
  const body = withInlineTool();
  const out = declareInlineTools({ ...body, messages: [...body.messages!, removal] })!;
  assert.deepEqual(out.messages!.map((m) => m.content), ['read the docs page', 'go on'], 'emptied messages are dropped');
  assert.deepEqual(out.tools, [{ name: 'Bash' }]);
  const readded = declareInlineTools({ ...body, messages: [...body.messages!, removal, body.messages![1]] })!;
  assert.deepEqual(readded.tools, [{ name: 'Bash' }, { ...INLINE_TOOL, defer_loading: true }], 'added again: declared');
});

test('the DeepSeek proxies reshape inline tools on messages and count_tokens, with masking on or off', async () => {
  const up = await fakeUpstream(ok);
  try {
    for (const kind of ['mask', 'fix'] as const) {
      const url = (await proxyUrl(up.url, kind))!;
      for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
        await send(url, path, JSON.stringify(withInlineTool()));
        assert.doesNotMatch(up.seen.body!, /tool_definition/, `${kind} ${path}`);
        assert.match(up.seen.body!, /"defer_loading":true/);
      }
    }
    const claude = (await proxyUrl(up.url, 'clear'))!;
    await send(claude, '/v1/messages/count_tokens', JSON.stringify(withInlineTool()));
    assert.match(up.seen.body!, /tool_definition/, 'Claude accepts inline tools: left alone');
  } finally {
    await stopProxies();
    await up.close();
  }
});

test('DeepSeek requests share one cache scope: the per-session user_id becomes one stable id', async () => {
  const body = { ...convo(1), metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: 's1' }) } };
  assert.deepEqual(stableUserId(body)!.metadata, { user_id: CACHE_USER_ID });
  assert.equal(stableUserId(convo(1)), undefined, 'no user_id: unchanged, so the bytes pass through');
  const up = await fakeUpstream(ok);
  try {
    await send((await proxyUrl(up.url, 'fix'))!, '/v1/messages', JSON.stringify(body));
    assert.match(up.seen.body!, /"user_id":"dual-agent"/);
    await send((await proxyUrl(up.url, 'mask'))!, '/v1/messages', JSON.stringify({ ...withInlineTool(), metadata: body.metadata }));
    assert.match(up.seen.body!, /"user_id":"dual-agent"/, 'with inline tools reshaped too');
    assert.match(up.seen.body!, /"defer_loading":true/);
    await send((await proxyUrl(up.url, 'claude'))!, '/v1/messages', JSON.stringify(body));
    assert.match(up.seen.body!, /session_id/, 'Claude: left alone');
    // Patched in the bytes: a body with nothing else to change is not serialised again (its spacing stays).
    const spaced = '{"model":"deepseek-flash",  "messages":[], "metadata":{"user_id":"sess-1"}}';
    await send((await proxyUrl(up.url, 'fix'))!, '/v1/messages', spaced);
    assert.equal(up.seen.body, spaced.replace('sess-1', CACHE_USER_ID));
  } finally {
    await stopProxies();
    await up.close();
  }
  const raw = Buffer.from(JSON.stringify(body));
  assert.deepEqual(JSON.parse(stableUserIdBytes(raw, body).toString()), { ...body, metadata: { user_id: CACHE_USER_ID } });
  assert.equal(stableUserIdBytes(raw, convo(1)), raw, 'no user_id: the same bytes');
  const pretty = Buffer.from(JSON.stringify(body, null, 1));
  assert.equal(JSON.parse(stableUserIdBytes(pretty, body).toString()).metadata.user_id, CACHE_USER_ID, 'written another way: serialised again');
});

test('a Claude request that mentions deepseek (a folder name) is not parsed to look for a DeepSeek model', () => {
  const route = { url: 'x', key: 'k', fastModel: 'deepseek-flash' };
  const raw = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'read /Users/me/deepseek_vs_plugin/src/a.ts' }] }));
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => (parsed++, parse(...a))) as typeof JSON.parse;
  try {
    assert.equal(toDeepSeek(raw, {}, route), undefined);
  } finally {
    JSON.parse = parse;
  }
  assert.equal(parsed, 0);
  assert.ok(toDeepSeek(Buffer.from('{"model":"deepseek-v4-pro","messages":[]}'), {}, route), 'a DeepSeek model still goes');
});

test('assistant turns without thinking get a placeholder when DeepSeek thinks with tools', () => {
  const body = convo(2);
  (body.messages![1].content as Block[]).shift();
  const out = keepThinking(body)!;
  assert.deepEqual((out.messages![1].content as Block[])[0], { type: 'thinking', thinking: MISSING_THINKING, signature: '' });
  assert.equal((out.messages![3].content as Block[]).filter((b) => b.type === 'thinking').length, 1, 'a turn with thinking is left alone');
  assert.equal((body.messages![1].content as Block[])[0].type, 'tool_use', 'the input is not mutated');
  assert.equal(keepThinking(convo(2)), undefined, 'nothing missing: unchanged');
  assert.equal(keepThinking({ ...body, thinking: { type: 'disabled' } }), undefined, 'thinking off: not needed');
  assert.equal(keepThinking({ ...body, tools: [] }), undefined, 'without tools DeepSeek ignores old reasoning');
  const redacted = keepThinking({ ...convo(1), tools: [], messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'hi' }] }] })!;
  assert.deepEqual((redacted.messages![0].content as Block[]).map((b) => b.type), ['thinking', 'text'], 'Claude\'s redacted thinking becomes a placeholder: DeepSeek has no such type');
});

test('tool-schema patterns DeepSeek can\'t compile are rewritten; others are left alone', () => {
  const tool = (pattern: string) => ({ name: 'Artifact', input_schema: { type: 'object', properties: { path: { type: 'string', pattern } } } });
  const out = fixPatterns({ tools: [tool('^[^\\0]*$')] })!;
  assert.equal((out.tools as any)[0].input_schema.properties.path.pattern, '^[^\\x00]*$');
  assert.equal(fixPatterns({ tools: [tool('^[a-z]+$'), tool('\\012')] }), undefined, 'octal escapes and plain patterns stay');
  const all = forDeepSeek({ ...convo(1), tools: [tool('^[^\\0]*$')] })!;
  assert.match(JSON.stringify(all), /\\\\x00/, 'applied by the DeepSeek proxies');
});

// --- failure logging and timeouts ---

type Line = { line: string; fail?: { status?: number } };
const collect = () => {
  const lines: Line[] = [];
  return { lines, log: (line: string, fail?: { status?: number }) => lines.push({ line, fail }) };
};

test('the shared proxies log failures as diag rows, and successful requests not at all', async () => {
  let status = 200;
  const up = await fakeUpstream((_q, res) => { res.statusCode = status; res.end('{}'); });
  resetDiag();
  try {
    const url = (await proxyUrl(up.url, 'mask'))!;
    await send(url, '/v1/messages', '{}');
    assert.equal(recentDiag(60_000).length, 0, 'a 200 is not a failure');
    status = 429;
    await send(url, '/v1/messages?beta=true', '{}');
    const rows = recentDiag(60_000);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'proxy');
    assert.equal(rows[0].status, 429);
    assert.equal(rows[0].provider, 'DeepSeek');
    assert.equal(rows[0].detail, 'POST /v1/messages -> 429');
    assert.equal(rows[0].target, new URL(up.url).host);
    assert.equal((rows[0] as { background?: boolean }).background, undefined, 'a model call');
    status = 500;
    await send(url, '/v1/code/sessions/cse_1/worker/heartbeat', '{}');
    assert.equal((recentDiag(60_000)[1] as { background?: boolean }).background, true, 'a heartbeat is background traffic');
  } finally {
    await stopProxies();
    await up.close();
    resetDiag();
  }
});

test('a request rewrite that throws is logged, and the original body still goes out', async () => {
  const up = await fakeUpstream(ok);
  const { lines, log } = collect();
  const proxy = await startProxy({ upstream: up.url, mask: false, fix: () => { throw new Error('fix broke'); }, log });
  try {
    assert.equal((await send(proxy.url, '/v1/messages', '{"a":1}')).status, 200);
    assert.equal(up.seen.body, '{"a":1}');
    const failed = lines.filter((l) => l.fail);
    assert.equal(failed.length, 1);
    assert.match(failed[0].line, /POST \/v1\/messages rewrite failed, sent unchanged: fix broke/);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

/** The answer that makes Claude Code retry at once. */
function assertRetryFast(r: { status: number; headers: http.IncomingHttpHeaders; body: string }, reason: RegExp) {
  assert.equal(r.status, 529);
  assert.equal(r.headers['x-should-retry'], 'true');
  assert.equal(r.headers['retry-after'], '1');
  const err = JSON.parse(r.body);
  assert.equal(err.type, 'error');
  assert.equal(err.error.type, 'overloaded_error');
  assert.match(err.error.message, /upstream 127\.0\.0\.1:\d+ did not answer/);
  assert.match(err.error.message, reason);
}

test('an upstream that sends no headers gets a retryable 529 after the header timeout, logged once', async () => {
  const up = await fakeUpstream(() => undefined);
  const { lines, log } = collect();
  const proxy = await startProxy({ upstream: up.url, headerTimeoutMs: 100, log });
  try {
    assertRetryFast(await send(proxy.url, '/v1/messages', '{"stream":true}'), /\(no response headers in 0.1s\)/);
    assert.deepEqual(lines.filter((l) => l.fail).map((l) => l.fail), [{ status: 529 }]);
    assert.match(lines[0].line, /upstream error no response headers in 0\.1s \(headers\)$/, 'our timer, while waiting for headers');
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a non-streamed request may take longer than the header timeout: its headers come with the whole answer', async () => {
  const up = await fakeUpstream((_req, res) => setTimeout(() => res.end('{"ok":true}'), 300));
  const proxy = await startProxy({ upstream: up.url, headerTimeoutMs: 100 });
  try {
    const r = await send(proxy.url, '/v1/messages', '{"stream":false}');
    assert.equal(r.status, 200, 'not cut off at 0.1s');
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a client that hangs up while the upstream thinks is not logged as a failure', async () => {
  const up = await fakeUpstream(() => undefined);
  const { lines, log } = collect();
  const proxy = await startProxy({ upstream: up.url, log });
  try {
    const req = http.request(proxy.url + '/v1/messages', { method: 'POST' });
    req.on('error', () => undefined);
    req.end('{}');
    await new Promise((r) => setTimeout(r, 100));
    req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(lines, []);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a connection reset before any reply byte is a retryable 529', async () => {
  const up = await fakeUpstream((q) => q.socket.destroy());
  const { lines, log } = collect();
  const proxy = await startProxy({ upstream: up.url, log });
  try {
    assertRetryFast(await send(proxy.url, '/v1/messages', '{}'), /\(ECONNRESET\)/);
    assert.deepEqual(lines.map((l) => l.fail), [{ status: 529 }]);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a stream cut after the first bytes is never turned into a 529: the client sees the cut', async () => {
  const up = await fakeUpstream((q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {}\n\n', () => setTimeout(() => q.socket.destroy(), 20));
  });
  const proxy = await startProxy({ upstream: up.url });
  try {
    const got = await new Promise<{ status: number; body: string; cut: boolean }>((resolve) => {
      const req = http.request(proxy.url + '/v1/messages', { method: 'POST' }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode!, body, cut: false }));
        res.on('error', () => resolve({ status: res.statusCode!, body, cut: true }));
        res.on('aborted', () => resolve({ status: res.statusCode!, body, cut: true }));
      });
      req.on('error', () => undefined);
      req.end('{}');
    });
    assert.equal(got.status, 200);
    assert.equal(got.cut, true);
    assert.doesNotMatch(got.body, /overloaded_error/);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('upstream connections are kept alive and reused', async () => {
  const ports: number[] = [];
  const up = await fakeUpstream((q, res) => { ports.push(q.socket.remotePort!); res.end('{}'); });
  const proxy = await startProxy({ upstream: up.url });
  try {
    await send(proxy.url, '/v1/messages', '{}');
    await send(proxy.url, '/v1/messages', '{}');
    assert.equal(ports.length, 2);
    assert.equal(ports[0], ports[1], 'the second call reuses the first socket');
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a proxy widens the dual-stack connect attempt to 1 s', async () => {
  const up = await fakeUpstream(ok);
  const proxy = await startProxy({ upstream: up.url });
  try {
    if (typeof net.getDefaultAutoSelectFamilyAttemptTimeout === 'function') assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 1000);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

// --- recovering from network drops ---

test('kept sockets idle past the limit are closed, so a request after a quiet spell never meets a dead one', async () => {
  // Like a Wi-Fi change: a socket idle over 100 ms is dead, which the proxy only learns by using it.
  const lastUse = new WeakMap<net.Socket, number>();
  let killed = 0;
  const up = await fakeUpstream((q, res) => {
    const last = lastUse.get(q.socket);
    if (last !== undefined && Date.now() - last > 100) {
      killed++;
      q.socket.destroy();
      return;
    }
    res.end('{}', () => lastUse.set(q.socket, Date.now()));
  });
  const proxy = await startProxy({ upstream: up.url, idleSocketMs: 50 });
  try {
    assert.equal((await send(proxy.url, '/v1/messages', '{}')).status, 200);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await send(proxy.url, '/v1/messages', '{}')).status, 200);
    assert.equal(killed, 0, 'it went out on a new socket the first time');
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a stream silent for longer than the idle limit is not cut', async () => {
  const up = await fakeUpstream((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {}\n\n');
    setTimeout(() => res.end('event: message_stop\ndata: {}\n\n'), 300);
  });
  const proxy = await startProxy({ upstream: up.url, idleSocketMs: 50 });
  try {
    assert.match((await send(proxy.url, '/v1/messages', '{"stream":true}')).body, /message_start[\s\S]*message_stop/);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('after a reset the upstream\'s other kept sockets are dropped: the next request opens a new one', async () => {
  const ports: number[] = [];
  const up = await fakeUpstream((q, res) => {
    if (q.headers['x-reset']) {
      q.socket.destroy();
      return;
    }
    ports.push(q.socket.remotePort!);
    setTimeout(() => res.end('{}'), 20);
  });
  const { lines, log } = collect();
  const proxy = await startProxy({ upstream: up.url, log });
  try {
    await Promise.all([send(proxy.url, '/v1/messages', '{}'), send(proxy.url, '/v1/messages', '{}')]);
    const kept = [...ports];
    assert.equal(new Set(kept).size, 2, 'two kept sockets');
    assertRetryFast(await send(proxy.url, '/v1/messages', '{}', { 'x-reset': '1' }), /\(ECONNRESET\)/);
    assert.match(lines.find((l) => l.fail)!.line, /upstream error ECONNRESET \(headers: socket hang up\)$/, 'sent again once on a new socket, which failed too');
    await send(proxy.url, '/v1/messages', '{}');
    assert.ok(!kept.includes(ports[2]), 'not the other kept socket');
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a kept socket that died is sent again once on a new one: the client sees one 200', async () => {
  let resets = 0;
  const served = new WeakMap<net.Socket, number>();
  const up = await fakeUpstream((q, res) => {
    const n = (served.get(q.socket) ?? 0) + 1;
    served.set(q.socket, n);
    if (n === 2 && !resets++) {
      q.socket.destroy();
      return;
    }
    res.end('{"ok":true}');
  });
  const { lines, log } = collect();
  const proxy = await startProxy({ upstream: up.url, log });
  try {
    assert.equal((await send(proxy.url, '/v1/messages', '{}')).status, 200);
    assert.equal((await send(proxy.url, '/v1/messages', '{"a":1}')).status, 200);
    assert.equal(up.seen.body, '{"a":1}');
    assert.equal(resets, 1);
    assert.deepEqual(lines.filter((l) => l.fail), [], 'not a failure');
    assert.ok(lines.some((l) => /ECONNRESET on a kept connection; sent again on a new one/.test(l.line)));
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a kept socket that breaks after the reply began is not sent again', async () => {
  let calls = 0;
  const up = await fakeUpstream((q, res) => {
    if (++calls === 1) return void res.end('{}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {}\n\n', () => setTimeout(() => q.socket.destroy(), 20));
  });
  const proxy = await startProxy({ upstream: up.url });
  try {
    await send(proxy.url, '/v1/messages', '{}');
    await new Promise<void>((resolve) => {
      const req = http.request(proxy.url + '/v1/messages', { method: 'POST' }, (res) => {
        res.resume();
        res.on('close', () => resolve());
      });
      req.on('error', () => resolve());
      req.end('{}');
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 2);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('paths other than /v1/messages get the short header timeout: a stalled heartbeat is a 529 at once', async () => {
  const up = await fakeUpstream(() => undefined);
  const { lines, log } = collect();
  const proxy = await startProxy({ upstream: up.url, backgroundHeaderTimeoutMs: 100, log });
  try {
    const started = Date.now();
    assertRetryFast(await send(proxy.url, '/v1/code/sessions/cse_1/worker/heartbeat', '{}'), /\(no response headers in 0.1s\)/);
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(lines.filter((l) => l.fail).map((l) => l.fail), [{ status: 529, background: true }], 'marked as background traffic');
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a host that accepts the connection but never answers TLS fails within the connect timeout', async () => {
  const sockets: net.Socket[] = [];
  const silent = net.createServer((s) => sockets.push(s));
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  const { lines, log } = collect();
  const proxy = await startProxy({ upstream: `https://127.0.0.1:${(silent.address() as net.AddressInfo).port}`, connectTimeoutMs: 200, log });
  try {
    const started = Date.now();
    assertRetryFast(await send(proxy.url, '/v1/messages', '{}'), /\(ETIMEDOUT\)/);
    assert.ok(Date.now() - started < 2000);
    assert.match(lines[0].line, /upstream error ETIMEDOUT \(tls: connect timeout\)$/, 'our timer, in the TLS handshake');
  } finally {
    await proxy.stop();
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => silent.close(r));
  }
});

test('network errors before any reply byte are retryable 529s, logged with the step they happened in', async () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED']) {
    const { lines, log } = collect();
    const lookup = ((_h: string, _o: unknown, cb: (err: Error) => void) => process.nextTick(cb, Object.assign(new Error(`failed ${code}`), { code }))) as unknown as net.LookupFunction;
    const proxy = await startProxy({ upstream: 'http://upstream.test/anthropic', lookup, log });
    try {
      const r = await send(proxy.url, '/v1/messages', '{}');
      assert.equal(r.status, 529, code);
      assert.equal(r.headers['x-should-retry'], 'true');
      assert.match(lines[0].line, new RegExp(`upstream error ${code} \\(lookup: failed ${code}\\)$`));
    } finally {
      await proxy.stop();
    }
  }
});

test('heartbeats and polls have their own sockets: 64 hung ones don\'t hold up a model call', async () => {
  let hung = 0;
  const up = await fakeUpstream((q, res) => {
    if (q.url!.includes('/work/poll')) hung++;
    else res.end('{"ok":true}');
  });
  const proxy = await startProxy({ upstream: up.url });
  const polls: http.ClientRequest[] = [];
  try {
    for (let i = 0; i < 64; i++) {
      const req = http.request(`${proxy.url}/v1/environments/env_1/work/poll`);
      req.on('error', () => undefined);
      req.end();
      polls.push(req);
    }
    await until(() => hung === 64);
    assert.equal((await send(proxy.url, '/v1/messages', '{}')).status, 200);
  } finally {
    polls.forEach((p) => p.destroy());
    await proxy.stop();
    await up.close();
  }
});

// --- DNS cache ---

const addr = (address: string, family = 4) => ({ address, family });

test('DNS cache: an answer is reused for a minute, with every address for all: true, in each of dns.lookup\'s call forms', async () => {
  let calls = 0;
  let clock = 0;
  const lookup = dnsCache({ now: () => clock, resolve: (_h, _o, cb) => (calls++, cb(null, [addr('10.0.0.1'), addr('fd00::1', 6)])) });
  const ask = (opts: dns.LookupOptions) => new Promise<unknown[]>((ok) => lookup('api.example', opts, (...a) => ok(a)));
  assert.deepEqual(await ask({ all: true }), [null, [addr('10.0.0.1'), addr('fd00::1', 6)]]);
  assert.deepEqual(await ask({}), [null, '10.0.0.1', 4]);
  assert.deepEqual(await new Promise((ok) => (lookup as unknown as typeof dns.lookup)('api.example', (...a) => ok(a))), [null, '10.0.0.1', 4]);
  assert.equal(calls, 1, 'one real lookup');
  clock = 61_000;
  await ask({});
  assert.equal(calls, 2, 'asked again after a minute');
  // With Node's own dual-stack connect, which asks for every address.
  const server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, 'localhost', r));
  try {
    const s = net.connect({ host: 'localhost', port: (server.address() as net.AddressInfo).port, lookup: cachedLookup, autoSelectFamily: true });
    await new Promise<void>((ok, fail) => s.once('connect', ok).once('error', fail));
    s.destroy();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('DNS cache: a failed or slow lookup is answered with the last good address, for up to 10 minutes', async () => {
  let clock = 0;
  let mode: 'ok' | 'fail' | 'hang' = 'ok';
  let late: (() => void) | undefined;
  const lookup = dnsCache({
    now: () => clock,
    slowMs: 20,
    resolve: (_h, _o, cb) => {
      if (mode === 'ok') cb(null, [addr('10.0.0.1')]);
      else if (mode === 'fail') cb(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }), []);
      else late = () => cb(null, [addr('10.0.0.2')]);
    },
  });
  const ask = () => new Promise<unknown[]>((ok) => lookup('api.example', {}, (...a) => ok(a)));
  await ask();
  clock = 120_000;
  mode = 'fail';
  assert.deepEqual(await ask(), [null, '10.0.0.1', 4], 'failed: the old answer');
  mode = 'hang';
  assert.deepEqual(await ask(), [null, '10.0.0.1', 4], 'slow: the old answer');
  late!();
  assert.deepEqual(await ask(), [null, '10.0.0.2', 4], 'the slow answer still fills the cache');
  clock += 11 * 60_000;
  mode = 'fail';
  assert.equal(((await ask())[0] as NodeJS.ErrnoException).code, 'EAI_AGAIN', 'older than 10 minutes: the failure');
});

test('fast mode reaches Claude unchanged: speed, output_config and anthropic-* headers', async () => {
  const up = await fakeUpstream(ok);
  const headers = { 'anthropic-beta': 'fast-mode-2026-02-01,context-management-2025-06-27', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  // Cache diagnostics tag Claude requests too; they have their own test.
  setCacheDiagnostics(false);
  try {
    const url = (await proxyUrl(up.url, 'clear'))!;
    // Rewritten (tool clearing added): unknown fields keep their values and order.
    const sent = { model: 'claude-opus-4-6', speed: 'fast', max_tokens: 100, output_config: { effort: 'medium' }, messages: [], context_management: { edits: [] }, stream: true };
    await send(url, '/v1/messages?beta=true', JSON.stringify(sent), headers);
    const got = JSON.parse(up.seen.body!);
    assert.deepEqual(Object.keys(got), Object.keys(sent));
    assert.equal(got.speed, 'fast');
    assert.deepEqual(got.output_config, sent.output_config);
    assert.equal(got.context_management.edits[0].type, 'clear_tool_uses_20250919');
    for (const [k, v] of Object.entries(headers)) assert.equal(up.seen.headers![k], v, k);
    // Nothing to add: the exact bytes go out.
    const side = '{"model":"claude-haiku-4-5",  "speed":"fast","messages":[]}';
    await send(url, '/v1/messages', side, headers);
    assert.equal(up.seen.body, side);
  } finally {
    setCacheDiagnostics(true);
    await stopProxies();
    await up.close();
  }
});

test('a Claude chat\'s DeepSeek helpers go to DeepSeek with its key; the claude.ai sign-in never does', async () => {
  const claude = await fakeUpstream(ok);
  const ds = await fakeUpstream(ok);
  const route = { url: ds.url, key: 'sk-ds', fastModel: 'deepseek-flash' };
  const proxy = await startProxy({ upstream: claude.url, inject: (b) => ({ ...b, injected: true }), divert: (raw, h) => toDeepSeek(raw, h, route) });
  const signIn = { authorization: 'Bearer oauth-secret', 'anthropic-beta': 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14', 'anthropic-version': '2023-06-01' };
  try {
    await send(proxy.url, '/v1/messages?beta=true', JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'find x' }] }), signIn);
    assert.equal(ds.seen.path, '/anthropic/v1/messages?beta=true');
    assert.equal(ds.seen.headers!['x-api-key'], 'sk-ds');
    assert.equal(ds.seen.headers!.authorization, undefined, 'the sign-in stays home');
    assert.equal(ds.seen.headers!['anthropic-beta'], 'fine-grained-tool-streaming-2025-05-14');
    assert.equal(ds.seen.headers!['anthropic-version'], '2023-06-01');
    const sent = JSON.parse(ds.seen.body!);
    assert.deepEqual(sent.thinking, { type: 'disabled' }, 'Flash runs without thinking, as in a DeepSeek chat');
    assert.equal(sent.injected, undefined, 'Anthropic-only fields are not added');

    const pro = JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'design y' }] });
    await send(proxy.url, '/v1/messages', pro, signIn);
    assert.equal(ds.seen.body, pro, 'other DeepSeek models go as they are');

    // The main agent's own requests, even ones that mention DeepSeek, stay on Claude with the sign-in.
    await send(proxy.url, '/v1/messages', JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'read deepseek-flash notes' }] }), signIn);
    assert.equal(claude.seen.headers!.authorization, 'Bearer oauth-secret');
    assert.equal(JSON.parse(claude.seen.body!).injected, true);
  } finally {
    await proxy.stop();
    await claude.close();
    await ds.close();
  }
});

test('without a DeepSeek route nothing is diverted', () => {
  assert.equal(toDeepSeek(Buffer.from('{"model":"deepseek-flash"}'), {}, undefined), undefined);
  assert.equal(toDeepSeek(Buffer.from('{"model":"deepseek-flash"'), {}, { url: 'x', key: 'k', fastModel: 'deepseek-flash' }), undefined, 'unparseable');
});

// --- Remote Control: the proxy as an HTTPS proxy that decrypts one host ---

test('a host certificate is valid for that host only and not a CA', () => {
  const { cert } = makeHostCert('api.anthropic.com');
  const x = new crypto.X509Certificate(cert);
  assert.equal(x.checkHost('api.anthropic.com'), 'api.anthropic.com');
  assert.equal(x.checkHost('claude.ai'), undefined);
  assert.equal(x.ca, false);
  assert.ok(x.verify(x.publicKey), 'self-signed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  const first = hostCert(dir, 'api.anthropic.com');
  assert.equal(hostCert(dir, 'api.anthropic.com').cert, first.cert, 'reused while valid');
  assert.notEqual(hostCert(dir, 'api.anthropic.com', Date.now() + 340 * 86_400_000).cert, first.cert, 'remade near expiry');
  assert.equal(fs.statSync(path.join(dir, 'api.anthropic.com.key')).mode & 0o077, 0, 'the key is private');
});

/** A POST through an HTTPS proxy (CONNECT), trusting only `ca`, like Claude Code with HTTPS_PROXY and NODE_EXTRA_CA_CERTS. */
function viaProxy(proxy: string, ca: string, url: string, body: string, headers: http.OutgoingHttpHeaders = {}) {
  const target = new URL(url);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const connect = http.request(proxy, { method: 'CONNECT', path: `${target.hostname}:${target.port}` });
    connect.on('connect', (_res, socket) => {
      const req = https.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, createConnection: () => tls.connect({ socket, servername: target.hostname, ca }) }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });
    connect.on('error', reject);
    connect.end();
  });
}

test('as an HTTPS proxy it decrypts the upstream host, routes by model, and never sends the sign-in to DeepSeek', async () => {
  const pem = makeHostCert('localhost');
  const claude = await fakeUpstream(ok);
  const ds = await fakeUpstream(ok);
  const port = new URL(claude.url).port;
  const proxy = await startProxy({
    upstream: `http://localhost:${port}`,
    intercept: pem,
    divert: (raw, h) => toDeepSeek(raw, h, { url: ds.url, key: 'sk-ds', fastModel: 'deepseek-flash' }),
  });
  try {
    const call = (model: string) => viaProxy(proxy.url, pem.cert, `https://localhost:${port}/v1/messages`, JSON.stringify({ model, messages: [] }), { authorization: 'Bearer claude-ai-token' });
    assert.equal((await call('claude-sonnet-5-5')).status, 200);
    assert.equal(claude.seen.path, '/v1/messages');
    assert.equal(claude.seen.headers?.authorization, 'Bearer claude-ai-token', 'Claude requests arrive decrypted, sign-in kept');
    assert.equal((await call('deepseek-flash')).status, 200);
    assert.equal(ds.seen.headers?.['x-api-key'], 'sk-ds', 'DeepSeek requests go to DeepSeek with its key');
    assert.equal(ds.seen.headers?.authorization, undefined, 'and never carry the sign-in');
  } finally {
    await proxy.stop();
    await claude.close();
    await ds.close();
  }
});

test('Remote Control: a websocket to the decrypted host is upgraded upstream and its frames pass through untouched', async () => {
  const pem = makeHostCert('localhost');
  let seen: http.IncomingHttpHeaders = {};
  const sockets: net.Socket[] = [];
  const upstream = http.createServer();
  upstream.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    seen = req.headers;
    sockets.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (c: Buffer) => socket.write(c)); // echo
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as net.AddressInfo).port;
  const proxy = await startProxy({ upstream: `http://localhost:${port}`, intercept: pem });
  try {
    const target = new URL(proxy.url);
    const socket = net.connect(Number(target.port), target.hostname);
    socket.write(`CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`);
    await new Promise((r) => socket.once('data', r)); // 200 Connection Established
    const ws = tls.connect({ socket, servername: 'localhost', ca: pem.cert });
    let got = '';
    ws.on('data', (c: Buffer) => (got += c.toString('latin1')));
    ws.write('GET /v1/sessions/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: a2V5\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n');
    const frame = '\x81\x85\x01\x02\x03\x04masked'; // a masked client frame: must arrive byte for byte
    const until = async (s: string) => { while (!got.includes(s)) await new Promise((r) => setTimeout(r, 10)); };
    await until('101 Switching Protocols');
    ws.write(Buffer.from(frame, 'latin1'));
    await until(frame);
    assert.equal(seen.upgrade, 'websocket');
    assert.equal(seen['sec-websocket-key'], 'a2V5');
    assert.equal(seen['sec-websocket-extensions'], 'permessage-deflate', 'the handshake is forwarded as sent');
    ws.destroy();
  } finally {
    await proxy.stop();
    sockets.forEach((s) => s.destroy()); // upgraded sockets aren't closed by the server
    await new Promise((r) => upstream.close(r));
  }
});

test('Remote Control: when Claude answers 429, DeepSeek answers instead, and keeps answering until the reset', async () => {
  const pem = makeHostCert('localhost');
  let claudeCalls = 0;
  const reset = Math.ceil(Date.now() / 1000) + 3600;
  const claude = await fakeUpstream((_q, res) => {
    claudeCalls++;
    res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-reset': String(reset) });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
  });
  const ds = await fakeUpstream(ok);
  routeDeepSeekHelpers({ url: ds.url, key: 'sk-ds', fastModel: 'deepseek-flash', mainModel: 'deepseek-v4-pro' });
  const port = new URL(claude.url).port;
  const proxy = (await proxyUrl(`http://localhost:${port}`, 'claude', pem))!;
  try {
    const call = (model: string) => viaProxy(proxy, pem.cert, `https://localhost:${port}/v1/messages`, JSON.stringify({ model, messages: [] }), { authorization: 'Bearer claude-ai-token' });
    assert.equal((await call('claude-opus-5-5')).status, 200, 'Claude Code never sees the 429');
    assert.equal(JSON.parse(ds.seen.body!).model, 'deepseek-v4-pro', 'the main model answers');
    assert.equal(ds.seen.headers?.authorization, undefined, 'without the sign-in');
    assert.equal((await call('claude-haiku-5-5')).status, 200);
    assert.equal(JSON.parse(ds.seen.body!).model, 'deepseek-flash', 'background calls go to the fast model');
    assert.equal(claudeCalls, 1, 'until the reset, Claude is not asked again');
  } finally {
    routeDeepSeekHelpers(undefined);
    await stopProxies();
    await claude.close();
    await ds.close();
  }
});

test('the quota reset comes from Anthropic\'s header, else Retry-After, else 5 minutes', () => {
  assert.equal(limitResetsAt({ 'anthropic-ratelimit-unified-reset': '2000000000' }, 0), 2_000_000_000_000);
  assert.equal(limitResetsAt({ 'retry-after': '30' }, 1000), 31_000);
  assert.equal(limitResetsAt({}, 1000), 1000 + 300_000);
});

// --- what the proxy keeps about each failure, and about Remote Control replies ---

test('a request\'s model and Claude Code session are found without parsing the body; an error body gives the reason', () => {
  const userId = JSON.stringify({ device_id: 'd', account_uuid: '', session_id: '6e5b5383-13e1-4655-ba0c-4dbed860a30b' });
  const raw = Buffer.from(JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x'.repeat(10_000) }], metadata: { user_id: userId } }));
  assert.deepEqual(requestMeta(raw), { model: 'deepseek-flash', session: '6e5b5383-13e1-4655-ba0c-4dbed860a30b' });
  assert.deepEqual(requestMeta(Buffer.from('{"messages":[]}')), {});
  assert.equal(errorReason('{"error":{"type":"invalid_request_error","message":"The `content[].thinking` must be passed back"}}'), 'The `content[].thinking` must be passed back');
  assert.equal(errorReason('{}'), '');
  assert.equal(errorReason('<html><body>Bad gateway</body></html>'), 'Bad gateway');
});

test('a failed request is logged with the provider\'s reason, the model and the session', async () => {
  resetDiag();
  const up = await fakeUpstream((_q, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"invalid_request_error","message":"The `content[].thinking` in the thinking mode must be passed back to the API."}}');
  });
  try {
    const url = (await proxyUrl(up.url, 'fix'))!;
    const userId = JSON.stringify({ device_id: 'd', session_id: 'sess-1234-abcd' });
    await send(url, '/v1/messages', JSON.stringify({ model: 'deepseek-v4-pro', messages: [], metadata: { user_id: userId } }));
    const row = recentDiag(10_000).find((r) => r.kind === 'proxy');
    assert.match(row?.detail ?? '', /-> 400: The `content\[\]\.thinking` in the thinking mode must be passed back/);
    assert.equal(row!.model, 'deepseek-v4-pro');
    assert.equal(row!.session, 'sess-1234-abcd');
    assert.equal(row!.level, 'error');
  } finally {
    await stopProxies();
    await up.close();
  }
});

test('a compressed error body is unpacked for the log and reaches the client byte for byte', async () => {
  resetDiag();
  const packed = zlib.gzipSync('{"type":"error","error":{"type":"invalid_request_error","message":"Environment is not reconnectable"}}');
  const up = await fakeUpstream((_q, res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(packed);
  });
  try {
    const url = (await proxyUrl(up.url, 'fix'))!;
    const got = await new Promise<Buffer>((resolve, reject) => {
      const req = http.request(`${url}/v1/environments/env_1/bridge/reconnect`, { method: 'POST' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.deepEqual(got, packed);
    assert.match(recentDiag(10_000).find((r) => r.kind === 'proxy')?.detail ?? '', /-> 400: Environment is not reconnectable/);
  } finally {
    await stopProxies();
    await up.close();
  }
});

test('the usage tap reads what a reply cost from the stream, or from a whole JSON body', () => {
  const got: unknown[] = [];
  const tap = usageTap(true, (u) => got.push(u));
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"deepseek-flash","usage":{"input_tokens":120,"cache_read_input_tokens":5888,"output_tokens":1}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":42}}',
  ].join('\n');
  // Split mid-line, as the network does.
  tap.push(Buffer.from(sse.slice(0, 77)));
  tap.push(Buffer.from(sse.slice(77)));
  tap.end();
  assert.deepEqual([...got], [{ model: 'deepseek-flash', usage: { input_tokens: 120, cache_read_input_tokens: 5888, output_tokens: 42 } }]);
  const json = usageTap(false, (u) => got.push(u));
  json.push(Buffer.from('{"model":"claude-haiku-5-5","usage":{"input_tokens":3,"output_tokens":4}}'));
  json.end();
  assert.deepEqual(got[1], { model: 'claude-haiku-5-5', usage: { input_tokens: 3, output_tokens: 4 } });
});

test('Remote Control: each reply\'s usage reaches the hooks, and a request over a cost limit is refused with the reason', async () => {
  const pem = makeHostCert('localhost');
  const claude = await fakeUpstream((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"model":"claude-sonnet-5-5","usage":{"input_tokens":10,"output_tokens":5}}');
  });
  const used: unknown[] = [];
  let over: string | undefined;
  setRemoteHooks({ onUsage: (u) => used.push(u), refuse: () => over });
  const port = new URL(claude.url).port;
  const proxy = (await proxyUrl(`http://localhost:${port}`, 'claude', pem))!;
  try {
    const userId = JSON.stringify({ session_id: 'remote-session-1' });
    const call = () => viaProxy(proxy, pem.cert, `https://localhost:${port}/v1/messages`, JSON.stringify({ model: 'claude-sonnet-5-5', messages: [], metadata: { user_id: userId } }));
    assert.equal((await call()).status, 200);
    await until(() => used.length === 1);
    assert.deepEqual(used[0], { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5 }, session: 'remote-session-1' });
    over = 'Dual Agent cost limit reached for deepseek-v4-pro.';
    const refused = await call();
    assert.equal(refused.status, 400);
    assert.match(refused.body, /cost limit reached/);
  } finally {
    setRemoteHooks({});
    await stopProxies();
    await claude.close();
  }
});

test('proxies in their own process: requests pass, usage, log rows and refusals reach the extension, and a dead process restarts', async () => {
  const pem = makeHostCert('localhost');
  let fail = false;
  const claude = await fakeUpstream((_q, res) => {
    res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
    res.end(fail ? '{"error":{"message":"upstream broke"}}' : '{"model":"claude-sonnet-5-5","usage":{"input_tokens":10,"output_tokens":5}}');
  });
  const used: unknown[] = [];
  const asked: unknown[] = [];
  let over: string | undefined;
  setRemoteHooks({ onUsage: (u) => used.push(u), refuse: (meta) => (asked.push(meta), over) });
  resetDiag();
  runProxiesInChildProcess(true);
  const port = new URL(claude.url).port;
  try {
    const proxy = (await proxyUrl(`http://localhost:${port}`, 'claude', pem))!;
    const call = (url = proxy) => viaProxy(url, pem.cert, `https://localhost:${port}/v1/messages`, JSON.stringify({ model: 'claude-sonnet-5-5', messages: [] }));
    assert.equal((await call()).status, 200);
    await until(() => used.length === 1);
    assert.deepEqual(asked, [{ model: 'claude-sonnet-5-5' }], 'the refusal check gets the model, not the body');
    over = 'Dual Agent cost limit reached for claude-sonnet-5-5.';
    assert.match((await call()).body, /cost limit reached/);
    over = undefined;
    fail = true;
    assert.equal((await call()).status, 500);
    await until(() => recentDiag(10_000).some((r) => r.kind === 'proxy' && /-> 500: upstream broke/.test(r.detail ?? '')));

    const pid = proxyProcessPid()!;
    assert.ok(pid && pid !== process.pid, 'the proxies run in another process');
    process.kill(pid);
    let again = proxy;
    for (const end = Date.now() + 5_000; again === proxy && Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
      again = (await proxyUrl(`http://localhost:${port}`, 'claude', pem))!;
    }
    assert.notEqual(again, proxy, 'once the process is gone, a new one starts on a new port');
    fail = false;
    assert.equal((await call(again)).status, 200);
  } finally {
    runProxiesInChildProcess(false);
    setRemoteHooks({});
    await stopProxies();
    await claude.close();
  }
});

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, 'timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// --- cache diagnostics ---

const claudeBody = (session: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model: 'claude-opus-5-5', metadata: { user_id: JSON.stringify({ session_id: session }) }, messages: [], ...extra });

test('cache diagnostics: each request names the previous reply of its own conversation, and misses are logged with the cause', async () => {
  resetDiag();
  let n = 0;
  const up = await fakeUpstream((_q, res) => {
    n++;
    res.writeHead(200, { 'content-type': 'application/json' });
    // The third reply: the API found the history changed, and the whole conversation was written again.
    const diagnostics = n === 3 ? { cache_miss_reason: { type: 'messages_changed', cache_missed_input_tokens: 95_000 } } : null;
    const usage = n === 3 ? { input_tokens: 2, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 101_000, output_tokens: 300 } : { input_tokens: 2, cache_read_input_tokens: 90_000, output_tokens: 5 };
    res.end(JSON.stringify({ id: `msg_${n}`, model: 'claude-opus-5-5', usage, diagnostics, context_management: n === 3 ? { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_input_tokens: 40_000 }] } : undefined }));
  });
  const proxy = await startProxy({ upstream: up.url, tag: tagRequest });
  try {
    await send(proxy.url, '/v1/messages', claudeBody('sess-diag-1'));
    assert.deepEqual(JSON.parse(up.seen.body!).diagnostics, { previous_message_id: null }, 'the first request opts in');
    await send(proxy.url, '/v1/messages', claudeBody('sess-diag-1'), { 'x-claude-code-agent-id': 'helper-1' });
    assert.deepEqual(JSON.parse(up.seen.body!).diagnostics, { previous_message_id: null }, 'a helper is its own conversation');
    await send(proxy.url, '/v1/messages', claudeBody('sess-diag-1'));
    assert.deepEqual(JSON.parse(up.seen.body!).diagnostics, { previous_message_id: 'msg_1' });
    const miss = recentDiag(60_000).filter((r) => r.kind === 'cache_miss');
    assert.equal(miss.length, 1);
    assert.equal(miss[0].code, 'messages_changed');
    assert.equal(miss[0].level, 'warn', 'a mid-conversation rewrite of 101k is the costly kind');
    assert.match(miss[0].detail ?? '', /wrote 101k, read 10k; ~95k after the divergence; edits applied: clear_tool_uses_20250919 \(cleared 40k\)/);
    assert.equal(miss[0].session, 'sess-diag-1');
    // Requests that aren't a Claude conversation's go out as they came.
    const ds = JSON.stringify({ model: 'deepseek-flash', messages: [] });
    await send(proxy.url, '/v1/messages', ds);
    assert.equal(up.seen.body, ds);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('cache diagnostics: an upstream that refuses the field gets the request again without it, and no more tags', async () => {
  const bodies: string[] = [];
  const up = await fakeUpstream((_q, res, seen) => {
    bodies.push(seen.body!);
    if (seen.body!.includes('"diagnostics"')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"diagnostics: Extra inputs are not permitted"}}');
      return;
    }
    res.end('{"ok":true}');
  });
  const failures: string[] = [];
  const proxy = await startProxy({ upstream: up.url, tag: tagRequest, log: (line, fail) => fail && failures.push(line) });
  try {
    const r = await send(proxy.url, '/v1/messages', claudeBody('sess-diag-2'));
    assert.equal(r.status, 200, 'the client never sees the refusal');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1], claudeBody('sess-diag-2'), 'resent exactly as the client sent it');
    await send(proxy.url, '/v1/messages', claudeBody('sess-diag-2'));
    assert.equal(bodies.length, 3, 'tagging stopped: one request, not two');
    setCacheDiagnostics(true);
    await send(proxy.url, '/v1/messages', claudeBody('sess-diag-2'));
    assert.equal(bodies.length, 4, 'a new launch turning the setting on again does not undo the refusal');
    assert.equal(failures.length, 1, 'the refusal is logged once');
    assert.match(failures[0], /refused the diagnostics field; sent again without it/);
  } finally {
    resetCacheDiagnostics();
    await proxy.stop();
    await up.close();
  }
});

test('cache diagnostics: other 400s still reach the client with their reason', async () => {
  const up = await fakeUpstream((_q, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}');
  });
  const proxy = await startProxy({ upstream: up.url, tag: tagRequest });
  try {
    const r = await send(proxy.url, '/v1/messages', claudeBody('sess-diag-3'));
    assert.equal(r.status, 400);
    assert.match(r.body, /prompt is too long/);
  } finally {
    await proxy.stop();
    await up.close();
  }
});

test('a cache miss is logged only with a cause: a change the API found, or an expired entry', () => {
  const usage = (read: number, write: number) => ({ input_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 1 });
  assert.equal(missRow({ model: 'm', usage: usage(90_000, 500), diagnostics: null }, true, false), undefined, 'a hit');
  assert.equal(missRow({ model: 'm', usage: usage(0, 30_000), diagnostics: null }, false, false), undefined, 'the first request has nothing to compare');
  assert.equal(missRow({ model: 'm', usage: usage(0, 30_000), diagnostics: { cache_miss_reason: { type: 'previous_message_not_found' } } }, true, false), undefined);
  assert.equal(missRow({ model: 'm', usage: usage(0, 30_000), diagnostics: null }, true, false)?.code, 'expired', 'same prefix, no cache: the entry timed out');
  const compacted = missRow({ model: 'm', usage: usage(10_000, 30_000), diagnostics: { cache_miss_reason: { type: 'messages_changed' } } }, true, true);
  assert.equal(compacted?.level, 'info', 'expected after a compaction');
  assert.match(compacted?.detail ?? '', /after compaction/);
  assert.equal(missRow({ model: 'm', usage: usage(10_000, 50_000), diagnostics: { cache_miss_reason: { type: 'system_changed' } } }, true, false)?.level, 'warn');
});

test('the usage tap also reads the reply id, cache diagnostics and applied context edits from the stream', () => {
  const got: any[] = [];
  const tap = usageTap(true, (u) => got.push(u));
  tap.push(Buffer.from([
    'data: {"type":"message_start","message":{"id":"msg_9","model":"claude-opus-5-5","usage":{"input_tokens":2,"output_tokens":1},"diagnostics":{"cache_miss_reason":{"type":"tools_changed"}}}}',
    'data: {"type":"message_delta","usage":{"output_tokens":77},"context_management":{"applied_edits":[{"type":"clear_thinking_20251015"}]}}',
    '',
  ].join('\n')));
  tap.end();
  assert.equal(got[0].id, 'msg_9');
  assert.equal(got[0].usage.output_tokens, 77);
  assert.equal(got[0].diagnostics.cache_miss_reason.type, 'tools_changed');
  assert.deepEqual(got[0].appliedEdits, [{ type: 'clear_thinking_20251015' }]);
});

test('every proxy notes each reply\'s final output count, for calls whose stream the SDK never shows', async () => {
  const up = await fakeUpstream((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"message_start","message":{"id":"ds-final-1","model":"deepseek-flash","usage":{"input_tokens":5,"output_tokens":0}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":321}}\n\n');
  });
  try {
    const url = (await proxyUrl(up.url, 'mask'))!;
    await send(url, '/v1/messages', JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [] }));
    assert.equal(finalOutput('ds-final-1'), 321);
  } finally {
    await stopProxies();
    await up.close();
  }
});

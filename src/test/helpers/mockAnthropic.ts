/**
 * A local server that speaks the Anthropic Messages API (streaming), standing
 * in for DeepSeek's Anthropic-compatible endpoint. It records every request so
 * tests can check what Claude Code actually sent.
 */
import * as http from 'http';
import { AddressInfo } from 'net';

export interface RecordedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export type Reply =
  | { kind: 'text'; text: string; delayMs?: number; inputTokens?: number }
  /** A reply with only a thinking block and no answer (a DeepSeek failure mode). */
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; text?: string }
  | { kind: 'error'; status: number; type: string; message: string };

/** Decides the reply to one request. The default answers every request with text. */
export type Responder = (req: RecordedRequest) => Reply;

export class MockAnthropic {
  readonly requests: RecordedRequest[] = [];
  responder: Responder = () => ({ kind: 'text', text: 'pong from mock' });
  private server?: http.Server;

  /** Only the main conversation requests (those carrying tools), not helper calls. */
  get conversationRequests() {
    return this.requests.filter((r) => r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens') && r.body?.tools?.length);
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  reset() {
    this.requests.length = 0;
    this.responder = () => ({ kind: 'text', text: 'pong from mock' });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // Not JSON.
      }
      const recorded: RecordedRequest = { url: req.url ?? '', headers: req.headers, body };
      this.requests.push(recorded);

      if (!recorded.url.startsWith('/v1/messages') || recorded.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const reply = this.responder(recorded);
      if (reply.kind === 'error') {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: reply.type, message: reply.message } }));
        return;
      }
      const model = body.model ?? 'mock-model';
      if (body.stream !== true) {
        // Non-streaming, e.g. Claude Code checking a model before setModel switches to it.
        const content = reply.kind === 'text' ? [{ type: 'text', text: reply.text }] : [{ type: 'text', text: reply.text ?? 'ok' }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model, content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (reply.kind === 'text') {
        await stream(res, model, [{ type: 'text', text: reply.text }], 'end_turn', reply.delayMs ?? 0, reply.inputTokens);
      } else if (reply.kind === 'thinking') {
        await stream(res, model, [{ type: 'thinking', thinking: reply.text }], 'end_turn', 0);
      } else {
        const blocks: Block[] = [];
        if (reply.text) {
          blocks.push({ type: 'text', text: reply.text });
        }
        blocks.push({ type: 'tool_use', id: `toolu_${this.requests.length}`, name: reply.name, input: reply.input });
        await stream(res, model, blocks, 'tool_use', 0);
      }
    });
  }
}

type Block = { type: 'text'; text: string } | { type: 'thinking'; thinking: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

async function stream(res: http.ServerResponse, model: string, blocks: Block[], stopReason: string, delayMs: number, inputTokens = 12) {
  const send = (event: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };
  send({
    type: 'message_start',
    message: { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
  });
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') {
      send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      // Word by word, so a delay makes a slow stream that can be interrupted.
      for (const word of block.text.split(/(?<= )/)) {
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } });
        if (delayMs) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    } else if (block.type === 'thinking') {
      send({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      send({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'mock-signature' } });
    } else {
      send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send({ type: 'content_block_stop', index });
  }
  send({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 7 } });
  send({ type: 'message_stop' });
  res.end();
}

/** Every text the model was shown in a request's last user turn. */
export function lastUserText(req: RecordedRequest): string {
  const msgs = req.body?.messages ?? [];
  const last = [...msgs].reverse().find((m: any) => m.role === 'user');
  if (!last) {
    return '';
  }
  if (typeof last.content === 'string') {
    return last.content;
  }
  return last.content
    .map((b: any) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? JSON.stringify(b.content) : ''))
    .join('\n');
}

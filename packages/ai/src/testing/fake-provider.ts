import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One answer of a scripted model: text, tool calls, or an HTTP error. */
export interface FakeTurn {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  /** Answers with this status and a JSON error instead of a stream. */
  status?: number;
  usage?: { input: number; output: number; cached?: number };
}

/** A request the fake provider received, for assertions. */
export interface FakeRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface FakeProvider {
  /** Base URL to configure, e.g. `http://127.0.0.1:1234/v1`. */
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

export type FakeProtocol = 'openai' | 'anthropic';

/** Decides the next answer from the conversation so far. */
export type FakeScript = FakeTurn[] | ((request: FakeRequest, index: number) => FakeTurn);

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  // Node yields Buffers for a request without an encoding set.
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? null : JSON.parse(text);
}

function splitText(text: string): string[] {
  // A few chunks, so that clients see a real stream.
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += 12) parts.push(text.slice(index, index + 12));
  return parts;
}

function openAiStream(response: ServerResponse, turn: FakeTurn, model: string): void {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(chunk({ role: 'assistant', content: '' }));
  for (const part of splitText(turn.text ?? '')) response.write(chunk({ content: part }));
  for (const [index, call] of (turn.toolCalls ?? []).entries()) {
    response.write(
      chunk({
        tool_calls: [
          {
            index,
            id: `call_${String(index)}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          },
        ],
      }),
    );
  }
  response.write(chunk({}, (turn.toolCalls ?? []).length > 0 ? 'tool_calls' : 'stop'));
  const usage = turn.usage ?? { input: 100, output: 20 };
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [],
      usage: {
        prompt_tokens: usage.input,
        completion_tokens: usage.output,
        total_tokens: usage.input + usage.output,
        prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
      },
    })}\n\n`,
  );
  response.end('data: [DONE]\n\n');
}

function anthropicStream(response: ServerResponse, turn: FakeTurn, model: string): void {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = turn.usage ?? { input: 100, output: 20 };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    event('message_start', {
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          // Anthropic counts cache reads apart from input_tokens.
          input_tokens: usage.input - (usage.cached ?? 0),
          output_tokens: 1,
          cache_read_input_tokens: usage.cached ?? 0,
          cache_creation_input_tokens: 0,
        },
      },
    }),
  );
  let index = 0;
  if (turn.text !== undefined && turn.text !== '') {
    response.write(
      event('content_block_start', { index, content_block: { type: 'text', text: '' } }),
    );
    for (const part of splitText(turn.text)) {
      response.write(
        event('content_block_delta', { index, delta: { type: 'text_delta', text: part } }),
      );
    }
    response.write(event('content_block_stop', { index }));
    index += 1;
  }
  for (const call of turn.toolCalls ?? []) {
    response.write(
      event('content_block_start', {
        index,
        content_block: {
          type: 'tool_use',
          id: `toolu_${String(index)}`,
          name: call.name,
          input: {},
        },
      }),
    );
    response.write(
      event('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
      }),
    );
    response.write(event('content_block_stop', { index }));
    index += 1;
  }
  response.write(
    event('message_delta', {
      delta: {
        stop_reason: (turn.toolCalls ?? []).length > 0 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: usage.output },
    }),
  );
  response.end(event('message_stop', {}));
}

/**
 * Starts an HTTP server speaking the streaming protocol of OpenAI's chat
 * completions (also Ollama's) or of Anthropic's Messages API, answering from a
 * script. The real SDK adapters talk to it, so tests cover them too.
 */
export async function startFakeProvider(
  protocol: FakeProtocol,
  script: FakeScript,
  host = '127.0.0.1',
): Promise<FakeProvider> {
  const requests: FakeRequest[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const received: FakeRequest = { path: request.url ?? '/', headers: request.headers, body };
      requests.push(received);
      const index = requests.length - 1;
      const turn = typeof script === 'function' ? script(received, index) : script[index];
      if (turn === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'script exhausted' } }));
        return;
      }
      if (turn.status !== undefined) {
        response.writeHead(turn.status, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify(
            protocol === 'anthropic'
              ? {
                  type: 'error',
                  error: { type: 'authentication_error', message: 'invalid x-api-key' },
                }
              : { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } },
          ),
        );
        return;
      }
      const model =
        typeof body === 'object' &&
        body !== null &&
        'model' in body &&
        typeof body.model === 'string'
          ? body.model
          : 'fake';
      if (protocol === 'openai') openAiStream(response, turn, model);
      else anthropicStream(response, turn, model);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  // listen() on a TCP port always yields an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${String(port)}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

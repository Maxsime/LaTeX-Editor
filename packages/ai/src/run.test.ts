import { afterEach, describe, expect, it } from 'vitest';
import { classifyProviderError, loggableProviderError } from './errors.js';
import { capabilitiesOf } from './models.js';
import { createModel } from './providers.js';
import { type AssistantEvent, runAssistant } from './run.js';
import { type FakeProvider, type FakeTurn, startFakeProvider } from './testing/fake-provider.js';
import { ToolError, type ToolHost } from './tools.js';

const SECRET = 'sk-test-very-secret-key-1234';

function host(overrides: Partial<ToolHost> = {}): ToolHost {
  const refuse = () => Promise.reject(new Error('not in this test'));
  return {
    listFiles: () => Promise.resolve([{ path: 'main.tex', kind: 'text' }]),
    readFile: (path) =>
      Promise.resolve({ path, firstLine: 1, lastLine: 1, totalLines: 1, text: 'Bonjour.' }),
    searchProject: refuse,
    getOutline: refuse,
    getCompileLog: () => Promise.resolve(null),
    compileSnippet: refuse,
    proposeChanges: refuse,
    searchLiterature: refuse,
    fetchBibtex: refuse,
    onFailure: () => undefined,
    ...overrides,
  };
}

const fakes: FakeProvider[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function setUp(protocol: 'openai' | 'anthropic', script: FakeTurn[]) {
  const fake = await startFakeProvider(protocol, script);
  fakes.push(fake);
  const provider = protocol === 'openai' ? ('openai-compatible' as const) : ('anthropic' as const);
  const model = protocol === 'openai' ? 'qwen2.5:7b' : 'claude-sonnet-4-5';
  return {
    fake,
    provider,
    model: createModel({ provider, model, apiKey: SECRET, baseUrl: fake.url }),
    capabilities: capabilitiesOf(provider, model),
  };
}

describe.each(['openai', 'anthropic'] as const)('runAssistant over %s', (protocol) => {
  it('streams text, runs tools and adds up usage', async () => {
    const { fake, ...setup } = await setUp(protocol, [
      {
        text: 'Je lis le fichier.',
        toolCalls: [{ name: 'read_file', input: { path: 'main.tex' } }],
        usage: { input: 120, output: 10, cached: 100 },
      },
      { text: 'Le fichier dit bonjour.', usage: { input: 150, output: 8 } },
    ]);
    const events: AssistantEvent[] = [];
    const result = await runAssistant({
      ...setup,
      mode: 'chat',
      context: { stable: '# Project index', variable: '# Current file' },
      messages: [{ role: 'user', text: 'Que dit main.tex ?' }],
      tools: { host: host(), names: ['read_file', 'list_files'] },
      onEvent: (event) => events.push(event),
    });
    expect(result.text).toBe('Le fichier dit bonjour.');
    expect(result.promptId).toBe('chat.v1');
    expect(result.usage).toEqual({ inputTokens: 270, outputTokens: 18, cachedInputTokens: 100 });
    expect(events).toContainEqual({
      type: 'tool',
      name: 'read_file',
      status: 'running',
      detail: 'main.tex',
    });
    expect(events).toContainEqual({ type: 'tool', name: 'read_file', status: 'done' });
    expect(
      events
        .filter((event) => event.type === 'text')
        .map((event) => event.delta)
        .join(''),
    ).toBe('Je lis le fichier.Le fichier dit bonjour.');

    // The second request carries the tool result back to the model.
    expect(JSON.stringify(fake.requests[1]?.body)).toContain('Bonjour.');
    const first = JSON.stringify(fake.requests[0]?.body);
    expect(first).toContain('# Project index');
    expect(first).toContain('read_file');
    expect(first).not.toContain('search_project');
    if (protocol === 'anthropic') expect(first).toContain('"cache_control"');
  });

  it('hands refusals back to the model and reports them', async () => {
    const { fake, ...setup } = await setUp(protocol, [
      { toolCalls: [{ name: 'fetch_bibtex', input: { doi: '10.1/x', isbn: '123' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'absent.tex' } }] },
      { text: 'Désolé.' },
    ]);
    const failures: string[] = [];
    const events: AssistantEvent[] = [];
    await runAssistant({
      ...setup,
      mode: 'chat',
      context: { stable: 'index', variable: '' },
      messages: [{ role: 'user', text: 'Ajoute une référence.' }],
      tools: {
        host: host({
          readFile: () => Promise.reject(new ToolError('No file absent.tex in the project.')),
          onFailure: (name) => failures.push(name),
        }),
        names: ['read_file', 'fetch_bibtex'],
      },
      onEvent: (event) => events.push(event),
    });
    expect(JSON.stringify(fake.requests[1]?.body)).toContain('Give exactly one of doi');
    expect(JSON.stringify(fake.requests[2]?.body)).toContain('No file absent.tex');
    expect(events).toContainEqual({ type: 'tool', name: 'read_file', status: 'error' });
    expect(failures).toEqual([]);
  });

  it('sends an image to a model with vision', async () => {
    const { fake, ...setup } = await setUp(protocol, [{ text: '```latex\nx^2\n```' }]);
    await runAssistant({
      ...setup,
      capabilities: { ...setup.capabilities, vision: true },
      mode: 'image',
      context: { stable: 'index', variable: '' },
      messages: [{ role: 'user', text: 'Convertis.' }],
      image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
      onEvent: () => undefined,
    });
    expect(JSON.stringify(fake.requests[0]?.body)).toContain('iVBORw0KGgo=');
  });

  it('classifies a rejected key without exposing it', async () => {
    const { fake, ...setup } = await setUp(protocol, [{ status: 401 }]);
    const error: unknown = await runAssistant({
      ...setup,
      mode: 'chat',
      context: { stable: 'index', variable: '' },
      messages: [{ role: 'user', text: 'Bonjour' }],
      onEvent: () => undefined,
    }).catch((caught: unknown) => caught);
    expect(classifyProviderError(error)).toBe('AI_AUTH_FAILED');
    expect(JSON.stringify(loggableProviderError(error))).not.toContain(SECRET);
    expect(loggableProviderError(error).statusCode).toBe(401);
    const sent = fake.requests[0]?.headers;
    expect(sent?.authorization ?? sent?.['x-api-key']).toContain(SECRET);
  });
});

describe('classifyProviderError', () => {
  it('maps unreachable providers and odd errors', async () => {
    const model = createModel({
      provider: 'openai-compatible',
      model: 'x',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    const error: unknown = await runAssistant({
      model,
      provider: 'openai-compatible',
      capabilities: capabilitiesOf('openai-compatible', 'x'),
      mode: 'inline',
      context: { stable: '', variable: '' },
      messages: [{ role: 'user', text: 'x' }],
      onEvent: () => undefined,
    }).catch((caught: unknown) => caught);
    expect(classifyProviderError(error)).toBe('AI_UNAVAILABLE');
    expect(classifyProviderError(new Error('weird'))).toBe('AI_BAD_RESPONSE');
  });

  it('refuses a conversation that does not end with the user', async () => {
    await expect(
      runAssistant({
        model: createModel({ provider: 'openai', model: 'gpt-4o', apiKey: 'x' }),
        provider: 'openai',
        capabilities: capabilitiesOf('openai', 'gpt-4o'),
        mode: 'chat',
        context: { stable: '', variable: '' },
        messages: [{ role: 'assistant', text: 'x' }],
        onEvent: () => undefined,
      }),
    ).rejects.toThrow('must end with the user');
  });

  it('needs a base URL for an OpenAI-compatible provider', () => {
    expect(() => createModel({ provider: 'openai-compatible', model: 'x' })).toThrow('base URL');
    expect(
      createModel({ provider: 'mistral', model: 'mistral-small-latest', apiKey: 'k' }),
    ).toBeDefined();
  });
});

describe('provider status codes', () => {
  it.each([
    [429, 'AI_RATE_LIMITED'],
    [503, 'AI_UNAVAILABLE'],
    [400, 'AI_BAD_RESPONSE'],
  ] as const)('maps %i to %s', async (status, code) => {
    const fake = await startFakeProvider('openai', [{ status }]);
    fakes.push(fake);
    const error: unknown = await runAssistant({
      model: createModel({ provider: 'openai-compatible', model: 'm', baseUrl: fake.url }),
      provider: 'openai-compatible',
      capabilities: capabilitiesOf('openai-compatible', 'm'),
      mode: 'chat',
      context: { stable: '', variable: '' },
      messages: [{ role: 'user', text: 'x' }],
      onEvent: () => undefined,
    }).catch((caught: unknown) => caught);
    expect(classifyProviderError(error)).toBe(code);
  });

  it('names a non-error failure', () => {
    expect(loggableProviderError('boom')).toEqual({ name: 'string' });
  });
});

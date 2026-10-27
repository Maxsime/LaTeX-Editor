import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  type FakeProvider,
  type FakeRequest,
  type FakeTurn,
  startFakeProvider,
} from '@galley/ai/testing';
import { createDatabase, type Database, runMigrations, yjsStates } from '@galley/db';
import {
  type AiChangeset,
  type AiStreamEvent,
  aiStreamEvent,
  COMPILE_QUEUE,
  type CompileJob,
  compileOutputKey,
} from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureSetupCode } from '../src/auth/setup.js';
import { createDocumentGateway, type DocumentGateway } from '../src/collab/documents.js';
import { readConfig } from '../src/config.js';
import { createS3Client, ensureBucket } from '../src/storage/s3.js';
import { stateToText } from '../src/yjs/text.js';
import { Client } from './client.js';
import {
  dockerAvailable,
  S3_CREDENTIALS,
  startPostgres,
  startSeaweedfs,
  startValkey,
} from './containers.js';
import { multipart } from './zip.js';

const INSTANCE_KEY = 'sk-instance-SECRET-0f9e8d7c6b5a';
const USER_KEY = 'sk-ant-user-SECRET-1a2b3c4d5e6f';
const MAIN =
  '\\documentclass{article}\n\\begin{document}\nLe chat dort.\nVoir \\cite{knuth1984}.\n\\end{document}\n';
const BIB =
  '@book{knuth1984, title = {Literate Programming}, author = {Knuth, Donald}, year = 1984}\n';

/** Parses the event stream of the chat route. */
function eventsOf(response: LightMyRequestResponse): AiStreamEvent[] {
  return response.body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => aiStreamEvent.parse(JSON.parse(chunk.slice(6))));
}

/** The text of the last tool result the model received, in either protocol. */
function lastToolResult(request: FakeRequest | undefined): string {
  if (request === undefined) throw new Error('no such request');
  const body = JSON.stringify(request.body);
  const matches = [...body.matchAll(/"(?:content|text)":"((?:[^"\\]|\\.)*)"/g)];
  return matches.map((match) => JSON.parse(`"${match[1] ?? ''}"`) as string).join('\n'); // Strings of the request body.
}

describe.skipIf(!dockerAvailable)('AI assistant', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let seaweedfs: StartedTestContainer;
  let database: Database;
  let redis: Redis;
  let s3: S3Client;
  let compileQueue: Queue<CompileJob, unknown>;
  let app: FastifyInstance;
  let documents: DocumentGateway;
  let openai: FakeProvider;
  let anthropic: FakeProvider;
  let crossref: Server;
  let script: (request: FakeRequest, index: number) => FakeTurn;
  const logs: string[] = [];
  const responses: LightMyRequestResponse[] = [];
  const snippetJobs: CompileJob[] = [];
  let ip = 0;

  let alice: Client;
  let bob: Client;
  let projectId: string;
  let mainId: string;
  let bibId: string;

  async function send(
    client: Client,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    json?: unknown,
  ): Promise<LightMyRequestResponse> {
    const response = await client.send(method, url, json === undefined ? {} : { json });
    responses.push(response);
    return response;
  }

  const chat = (client: Client, body: object) =>
    send(client, 'POST', `/api/projects/${projectId}/ai/chat`, body);

  async function textOf(fileId: string): Promise<string> {
    const [row] = await database.db.select().from(yjsStates).where(eq(yjsStates.fileId, fileId));
    return row ? stateToText(row.state) : '';
  }

  beforeAll(async () => {
    [postgres, valkey, seaweedfs] = await Promise.all([
      startPostgres(),
      startValkey(),
      startSeaweedfs(),
    ]);
    const forward = (request: FakeRequest, index: number) => script(request, index);
    [openai, anthropic] = await Promise.all([
      startFakeProvider('openai', forward),
      startFakeProvider('anthropic', forward),
    ]);
    const crossrefBody = readFileSync(
      new URL('./fixtures/lookup/crossref-10.1093_comjnl_27.2.97.json', import.meta.url),
      'utf8',
    );
    crossref = createServer((request, response) => {
      const known = request.url === '/works/10.1093/comjnl/27.2.97';
      response.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
      response.end(known ? crossrefBody : '{}');
    });
    await new Promise<void>((resolve) => crossref.listen(0, '127.0.0.1', resolve));
    const crossrefPort = (crossref.address() as AddressInfo).port; // listen() on TCP gives an AddressInfo.

    const config = readConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      VALKEY_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
      S3_ENDPOINT: `http://${seaweedfs.getHost()}:${String(seaweedfs.getMappedPort(8333))}`,
      S3_ACCESS_KEY_ID: S3_CREDENTIALS.accessKeyId,
      S3_SECRET_ACCESS_KEY: S3_CREDENTIALS.secretAccessKey,
      S3_BUCKET: 'galley-ai',
      REGISTRATION_MODE: 'open',
      GALLEY_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      CROSSREF_URL: `http://127.0.0.1:${String(crossrefPort)}`,
      AI_DEFAULT_PROVIDER: 'openai-compatible',
      AI_DEFAULT_MODEL: 'qwen2.5:7b',
      AI_DEFAULT_BASE_URL: openai.url,
      AI_DEFAULT_API_KEY: INSTANCE_KEY,
      AI_ALLOW_USER_ENDPOINTS: 'true',
      AI_RATE_LIMIT_PER_MINUTE: '100',
    });
    database = createDatabase(config.DATABASE_URL);
    redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
    s3 = createS3Client(config);
    await runMigrations(database);
    await ensureBucket(s3, config.S3_BUCKET);
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString('utf8'));
        done();
      },
    });
    const logger = createLogger({ service: 'api-test', level: 'trace', destination: sink });
    compileQueue = new Queue(COMPILE_QUEUE, { connection: { url: config.VALKEY_URL } });
    documents = createDocumentGateway(config, database, logger);
    app = buildApp({
      logger,
      version: 'test',
      probes: {},
      context: {
        config,
        database,
        redis,
        s3,
        documents,
        compileQueue,
        synctex: () => Promise.reject(new Error('no SyncTeX in these tests')),
        // Stands for a compiler worker: publishes a PDF for any document.
        snippets: async (job) => {
          snippetJobs.push(job);
          await s3.send(
            new PutObjectCommand({
              Bucket: config.S3_BUCKET,
              Key: compileOutputKey(job.compileId, 'main.pdf'),
              Body: '%PDF-1.5 fake',
            }),
          );
          return {
            outcome: 'success',
            durationMs: 10,
            pdf: 'main.pdf',
            pages: 1,
            diagnostics: [],
            truncated: false,
            outputs: [{ name: 'main.pdf', size: 13 }],
            texlive: '2026',
            shellEscapeDowngraded: false,
            lint: [],
            wordCount: null,
          };
        },
      },
    });
    await app.ready();

    const { code } = await ensureSetupCode(redis);
    alice = new Client(app, `10.9.0.${String(++ip)}`);
    const created = await alice.send('POST', '/api/auth/setup', {
      json: {
        email: 'alice@example.org',
        username: 'alice',
        displayName: 'Alice',
        password: 'alice-password-123',
        setupCode: code,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    bob = new Client(app, `10.9.0.${String(++ip)}`);
    const registered = await bob.send('POST', '/api/auth/register', {
      json: {
        email: 'bob@example.org',
        username: 'bob',
        displayName: 'Bob',
        password: 'bob-password-123',
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);

    projectId = (await alice.send('POST', '/api/projects', { json: { name: 'Rapport' } })).json<{
      project: { id: string };
    }>().project.id;
    const upload = await alice.send('POST', `/api/projects/${projectId}/files`, {
      form: multipart([
        { name: 'file', filename: 'main.tex', data: Buffer.from(MAIN) },
        { name: 'file', filename: 'refs.bib', data: Buffer.from(BIB) },
      ]),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const nodes = upload.json<{ nodes: { id: string; name: string }[] }>().nodes;
    mainId = nodes.find((node) => node.name === 'main.tex')?.id ?? '';
    bibId = nodes.find((node) => node.name === 'refs.bib')?.id ?? '';
    await alice.send('PATCH', `/api/projects/${projectId}`, { json: { mainFileId: mainId } });
    const invite = await alice.send('POST', `/api/projects/${projectId}/invites`, {
      json: { identifier: 'bob', role: 'editor' },
    });
    expect(invite.statusCode, invite.body).toBe(201);
    const accepted = await bob.send(
      'POST',
      `/api/invites/${invite.json<{ id: string }>().id}/accept`,
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
  }, 240_000);

  afterAll(async () => {
    await app.close();
    await compileQueue.close();
    await database.sql.end({ timeout: 5 });
    redis.disconnect();
    s3.destroy();
    crossref.close();
    await Promise.all([openai.close(), anthropic.close()]);
    await Promise.all([postgres.stop(), valkey.stop(), seaweedfs.stop()]);
  });

  it('reports the instance default and lets a user bring their own provider', async () => {
    const status = await send(alice, 'GET', `/api/projects/${projectId}/ai/status`);
    expect(status.json()).toMatchObject({
      available: true,
      provider: 'openai-compatible',
      model: 'qwen2.5:7b',
      capabilities: { tools: true, vision: false },
    });

    const saved = await send(bob, 'PUT', '/api/me/ai/provider', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: anthropic.url,
      apiKey: USER_KEY,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      config: { provider: 'anthropic', model: 'claude-sonnet-4-5', keyHint: USER_KEY.slice(-4) },
      instance: { provider: 'openai-compatible' },
    });
    const bobStatus = await send(bob, 'GET', `/api/projects/${projectId}/ai/status`);
    expect(bobStatus.json()).toMatchObject({
      provider: 'anthropic',
      capabilities: { vision: true },
    });

    // Changing the model alone keeps the stored key.
    const renamed = await send(bob, 'PUT', '/api/me/ai/provider', {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      baseUrl: anthropic.url,
    });
    expect(renamed.json()).toMatchObject({ config: { keyHint: USER_KEY.slice(-4) } });
    await send(bob, 'PUT', '/api/me/ai/provider', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: anthropic.url,
    });
  });

  // A1 and A2: the same scenario on both protocols, nothing written before acceptance.
  describe.each([
    ['OpenAI-compatible (Ollama)', () => alice, () => openai],
    ['Anthropic', () => bob, () => anthropic],
  ] as const)('one scenario over %s', (_name, user, provider) => {
    it('reads, proposes, waits for acceptance, then applies', async () => {
      await documents.apply({ replaced: [{ fileId: mainId, content: MAIN }], closed: [] });
      const fake = provider();
      const before = fake.requests.length;
      script = (_request, index) => {
        const step = index - before;
        if (step === 0)
          return {
            text: 'Je lis.',
            toolCalls: [{ name: 'read_file', input: { path: 'main.tex' } }],
          };
        if (step === 1) {
          return {
            toolCalls: [
              {
                name: 'propose_changes',
                input: {
                  edits: [
                    {
                      path: 'main.tex',
                      search: 'Le chat dort.',
                      replace: 'Le chat dort profondément.',
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: 'Voici ma proposition.', usage: { input: 500, output: 30, cached: 200 } };
      };
      const response = await chat(user(), {
        mode: 'chat',
        messages: [{ role: 'user', text: 'Précise que le chat dort profondément.' }],
        context: { fileId: mainId, cursor: 40 },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      const events = eventsOf(response);
      expect(events[0]?.type).toBe('conversation');
      expect(events).toContainEqual({
        type: 'tool',
        name: 'read_file',
        status: 'running',
        detail: 'main.tex',
      });
      expect(events.at(-1)).toEqual({ type: 'done' });
      const text = events.flatMap((event) => (event.type === 'text' ? [event.delta] : [])).join('');
      expect(text).toContain('Voici ma proposition.');
      // Three model calls: the two tool steps count 100 + 20 tokens each.
      const usage = events.find((event) => event.type === 'usage');
      expect(usage).toMatchObject({
        usage: { inputTokens: 700, outputTokens: 70, cachedInputTokens: 200 },
      });

      // The model saw the project index and the file it read.
      expect(lastToolResult(fake.requests[before + 1])).toContain('Le chat dort.');
      expect(JSON.stringify(fake.requests[before]?.body)).toContain('knuth1984');

      const proposal = events.find((event) => event.type === 'changeset');
      if (proposal?.type !== 'changeset') throw new Error('no changeset');
      expect(proposal.changeset.hunks).toMatchObject([
        {
          path: 'main.tex',
          original: 'Le chat dort.',
          replacement: 'Le chat dort profondément.',
          status: 'pending',
        },
      ]);
      expect(await textOf(mainId)).toBe(MAIN);

      const applied = await send(
        user(),
        'POST',
        `/api/projects/${projectId}/ai/changesets/${proposal.changeset.id}/apply`,
        { hunkIds: ['h1'] },
      );
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json<{ changeset: AiChangeset }>().changeset.hunks[0]?.status).toBe('applied');
      expect(await textOf(mainId)).toBe(
        MAIN.replace('Le chat dort.', 'Le chat dort profondément.'),
      );

      // Applying again changes nothing.
      await send(
        user(),
        'POST',
        `/api/projects/${projectId}/ai/changesets/${proposal.changeset.id}/apply`,
        {
          hunkIds: ['h1'],
        },
      );
      expect(await textOf(mainId)).toBe(
        MAIN.replace('Le chat dort.', 'Le chat dort profondément.'),
      );
    });
  });

  it('keeps proposals private to their author', async () => {
    await documents.apply({ replaced: [{ fileId: mainId, content: MAIN }], closed: [] });
    const before = openai.requests.length;
    script = (_request, index) =>
      index === before
        ? {
            toolCalls: [
              {
                name: 'propose_changes',
                input: { edits: [{ path: 'main.tex', search: 'dort', replace: 'ronronne' }] },
              },
            ],
          }
        : { text: 'ok' };
    const events = eventsOf(
      await chat(alice, { mode: 'chat', messages: [{ role: 'user', text: 'x' }] }),
    );
    const proposal = events.find((event) => event.type === 'changeset');
    if (proposal?.type !== 'changeset') throw new Error('no changeset');
    const stolen = await send(
      bob,
      'POST',
      `/api/projects/${projectId}/ai/changesets/${proposal.changeset.id}/apply`,
      { hunkIds: ['h1'] },
    );
    expect(stolen.statusCode).toBe(404);
    const rejected = await send(
      alice,
      'POST',
      `/api/projects/${projectId}/ai/changesets/${proposal.changeset.id}/reject`,
      { hunkIds: ['h1'] },
    );
    expect(rejected.json<{ changeset: AiChangeset }>().changeset.hunks[0]?.status).toBe('rejected');
    expect(await textOf(mainId)).toBe(MAIN);
  });

  describe('citations (A3)', () => {
    it('refuses an invented citation key and tells the model', async () => {
      const before = openai.requests.length;
      script = (_request, index) => {
        if (index === before) {
          return {
            toolCalls: [
              {
                name: 'propose_changes',
                input: {
                  edits: [
                    {
                      path: 'main.tex',
                      search: 'Le chat dort.',
                      replace: 'Le chat dort \\cite{inventee2099}.',
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: 'Je ne peux pas citer cette référence.' };
      };
      const events = eventsOf(
        await chat(alice, {
          mode: 'chat',
          messages: [{ role: 'user', text: 'Ajoute une citation.' }],
        }),
      );
      expect(events.some((event) => event.type === 'changeset')).toBe(false);
      expect(events).toContainEqual({ type: 'tool', name: 'propose_changes', status: 'error' });
      expect(lastToolResult(openai.requests[before + 1])).toContain(
        'Unknown citation key inventee2099',
      );
      expect(await textOf(mainId)).toBe(MAIN);
    });

    it('refuses a bibliography entry written by the model', async () => {
      const before = openai.requests.length;
      script = (_request, index) =>
        index === before
          ? {
              toolCalls: [
                {
                  name: 'propose_changes',
                  input: {
                    edits: [
                      {
                        path: 'refs.bib',
                        search: '',
                        replace: '@article{fake2020, title={Made up}}',
                      },
                    ],
                  },
                },
              ],
            }
          : { text: 'ok' };
      const events = eventsOf(
        await chat(alice, { mode: 'chat', messages: [{ role: 'user', text: 'x' }] }),
      );
      expect(events.some((event) => event.type === 'changeset')).toBe(false);
      expect(lastToolResult(openai.requests[before + 1])).toContain(
        'was not obtained with fetch_bibtex',
      );
    });

    it('accepts a reference fetched from Crossref, cited and added unchanged', async () => {
      const before = openai.requests.length;
      let fetched = { key: '', bibtex: '' };
      script = (request, index) => {
        if (index === before) {
          return {
            toolCalls: [{ name: 'fetch_bibtex', input: { doi: '10.1093/comjnl/27.2.97' } }],
          };
        }
        if (index === before + 1) {
          const result = /\{"key":"[^"]*","bibtex":"(?:[^"\\]|\\.)*"\}/.exec(
            lastToolResult(request),
          );
          fetched = JSON.parse(result?.[0] ?? '{}') as typeof fetched; // Tool result as the API sent it.
          return {
            toolCalls: [
              {
                name: 'propose_changes',
                input: {
                  edits: [
                    { path: 'refs.bib', search: '', replace: fetched.bibtex },
                    {
                      path: 'main.tex',
                      search: 'Le chat dort.',
                      replace: `Le chat dort \\cite{${fetched.key}}.`,
                    },
                  ],
                },
              },
            ],
          };
        }
        return { text: 'Référence ajoutée.' };
      };
      const events = eventsOf(
        await chat(alice, { mode: 'chat', messages: [{ role: 'user', text: 'Cite Knuth.' }] }),
      );
      expect(fetched.key).toMatch(/^knuth1984/);
      expect(fetched.key).not.toBe('knuth1984');
      const proposal = events.find((event) => event.type === 'changeset');
      if (proposal?.type !== 'changeset') throw new Error('no changeset');
      expect(proposal.changeset.hunks.map((hunk) => hunk.path)).toEqual(['refs.bib', 'main.tex']);

      // Deleting the entry before acceptance makes the citation unknown again: refused at apply time.
      const applyBoth = () =>
        send(
          alice,
          'POST',
          `/api/projects/${projectId}/ai/changesets/${proposal.changeset.id}/apply`,
          {
            hunkIds: ['h2'],
          },
        );
      expect((await applyBoth()).statusCode).toBe(200);
      expect(await textOf(mainId)).toContain(`\\cite{${fetched.key}}`);
      expect(await textOf(bibId)).toBe(BIB);
      await send(
        alice,
        'POST',
        `/api/projects/${projectId}/ai/changesets/${proposal.changeset.id}/apply`,
        {
          hunkIds: ['h1'],
        },
      );
      expect(await textOf(bibId)).toContain(fetched.bibtex);
    });

    it('checks citations again when a proposal is accepted', async () => {
      await documents.apply({ replaced: [{ fileId: mainId, content: MAIN }], closed: [] });
      const before = openai.requests.length;
      script = (_request, index) =>
        index === before
          ? {
              toolCalls: [
                {
                  name: 'propose_changes',
                  input: {
                    edits: [
                      {
                        path: 'main.tex',
                        search: 'Le chat dort.',
                        replace: 'Le chat dort \\cite{knuth1984}.',
                      },
                    ],
                  },
                },
              ],
            }
          : { text: 'ok' };
      const events = eventsOf(
        await chat(alice, { mode: 'chat', messages: [{ role: 'user', text: 'x' }] }),
      );
      const proposal = events.find((event) => event.type === 'changeset');
      if (proposal?.type !== 'changeset') throw new Error('no changeset');
      await documents.apply({ replaced: [{ fileId: bibId, content: '' }], closed: [] });
      const refused = await send(
        alice,
        'POST',
        `/api/projects/${projectId}/ai/changesets/${proposal.changeset.id}/apply`,
        { hunkIds: ['h1'] },
      );
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: { code: 'UNKNOWN_CITATION' } });
      expect(await textOf(mainId)).toBe(MAIN);
      await documents.apply({ replaced: [{ fileId: bibId, content: BIB }], closed: [] });
    });
  });

  it('turns an inline instruction into a one-hunk proposal', async () => {
    await documents.apply({ replaced: [{ fileId: mainId, content: MAIN }], closed: [] });
    script = () => ({ text: '```latex\nThe cat is asleep.\n```' });
    const from = MAIN.indexOf('Le chat dort.');
    const events = eventsOf(
      await chat(alice, {
        mode: 'inline',
        messages: [{ role: 'user', text: 'Traduis en anglais.' }],
        context: { fileId: mainId, selection: { from, to: from + 'Le chat dort.'.length } },
      }),
    );
    const proposal = events.find((event) => event.type === 'changeset');
    if (proposal?.type !== 'changeset') throw new Error('no changeset');
    expect(proposal.changeset.hunks).toMatchObject([
      { start: from, original: 'Le chat dort.', replacement: 'The cat is asleep.' },
    ]);
    expect(await textOf(mainId)).toBe(MAIN);
  });

  it('generates code with a compiled preview only its author can open', async () => {
    script = () => ({
      text: '```latex-preamble\n\\usepackage{booktabs}\n```\n```latex\n\\begin{tabular}{ll}\\toprule a & b\\\\\\bottomrule\\end{tabular}\n```',
    });
    const events = eventsOf(
      await chat(alice, {
        mode: 'generate',
        kind: 'table',
        messages: [{ role: 'user', text: 'Un tableau 2x1.' }],
      }),
    );
    const snippet = events.find((event) => event.type === 'snippet');
    if (snippet?.type !== 'snippet') throw new Error('no snippet');
    expect(snippet.snippet).toMatchObject({
      preamble: '\\usepackage{booktabs}',
      outcome: 'success',
    });
    expect(snippetJobs.at(-1)).toMatchObject({
      engine: 'pdflatex',
      mainFile: 'main.tex',
      haltOnError: true,
    });
    const url = `/api/projects/${projectId}/ai/snippets/${snippet.snippet.compileId ?? ''}/pdf`;
    const pdf = await send(alice, 'GET', url);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((await send(bob, 'GET', url)).statusCode).toBe(404);
  });

  it('refuses images for a model without vision', async () => {
    const response = await chat(alice, {
      mode: 'image',
      messages: [{ role: 'user', text: 'Convertis.' }],
      image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'AI_NO_VISION' } });
  });

  it('reports a key the provider rejects without exposing it', async () => {
    script = () => ({ status: 401 });
    const events = eventsOf(
      await chat(bob, { mode: 'chat', messages: [{ role: 'user', text: 'Bonjour' }] }),
    );
    expect(events).toContainEqual({ type: 'error', code: 'AI_AUTH_FAILED' });
    expect(anthropic.requests.at(-1)?.headers['x-api-key']).toBe(USER_KEY);
    expect(openai.requests.at(-1)?.headers.authorization).toBe(`Bearer ${INSTANCE_KEY}`);
  });

  it('records usage and estimates its cost from the price table', async () => {
    const prices = await send(alice, 'PUT', '/api/admin/ai/prices', {
      prices: [
        {
          provider: 'openai-compatible',
          model: 'qwen2.5:7b',
          inputPerMTok: 1,
          outputPerMTok: 2,
          cachedInputPerMTok: null,
          currency: 'EUR',
        },
      ],
    });
    expect(prices.statusCode, prices.body).toBe(200);
    expect((await send(bob, 'PUT', '/api/admin/ai/prices', { prices: [] })).statusCode).toBe(403);
    script = () => ({ text: 'Bonjour.', usage: { input: 1000, output: 100 } });
    const events = eventsOf(
      await chat(alice, { mode: 'chat', messages: [{ role: 'user', text: 'Salut' }] }),
    );
    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 0,
        costMicros: 1200,
        currency: 'EUR',
      },
    });
    const summary = await send(alice, 'GET', '/api/me/ai/usage');
    expect(summary.json()).toMatchObject({ costMicros: 1200 });
    expect(summary.json<{ requests: number }>().requests).toBeGreaterThan(1);
  });

  it('is off for a project whose owner disabled it', async () => {
    const off = await send(alice, 'PATCH', `/api/projects/${projectId}`, { aiEnabled: false });
    expect(off.json()).toMatchObject({ aiEnabled: false });
    expect(
      (await send(bob, 'PATCH', `/api/projects/${projectId}`, { aiEnabled: true })).statusCode,
    ).toBe(403);
    const status = await send(alice, 'GET', `/api/projects/${projectId}/ai/status`);
    expect(status.json()).toMatchObject({ available: false, reason: 'project-disabled' });
    const refused = await chat(alice, { mode: 'chat', messages: [{ role: 'user', text: 'x' }] });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'AI_DISABLED' } });
    await send(alice, 'PATCH', `/api/projects/${projectId}`, { aiEnabled: true });
  });

  it('forbids custom addresses unless the instance allows them', async () => {
    const response = await send(bob, 'PUT', '/api/me/ai/provider', {
      provider: 'openai-compatible',
      model: 'x',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'AI_ENDPOINT_FORBIDDEN' } });
  });

  // A4: runs last, over everything the tests above sent and logged.
  it('never shows an API key in a response or a log', () => {
    expect(responses.length).toBeGreaterThan(20);
    expect(logs.length).toBeGreaterThan(20);
    for (const secret of [USER_KEY, INSTANCE_KEY, USER_KEY.slice(0, -4), 'SECRET']) {
      for (const response of responses) {
        expect(response.body).not.toContain(secret);
        expect(JSON.stringify(response.headers)).not.toContain(secret);
      }
      for (const line of logs) expect(line).not.toContain(secret);
    }
    // Nor the documents.
    for (const line of logs) expect(line).not.toContain('Le chat dort');
  });
});

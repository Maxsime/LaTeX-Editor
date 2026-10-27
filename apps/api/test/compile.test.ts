import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  COMPILE_QUEUE,
  compileCancelKey,
  type CompileJob,
  type CompileResult,
  compileOutputKey,
  type CompileRun,
  compileRun,
  latestCompileResponse,
  projectChannel,
  projectEventMessage,
  type SynctexJob,
  type SynctexResult,
  TEXLIVE_VERSION_KEY,
} from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import {
  compileRuns,
  createDatabase,
  type Database,
  projectMembers,
  runMigrations,
} from '@galley/db';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Queue, QueueEvents, UnrecoverableError, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureSetupCode } from '../src/auth/setup.js';
import { createDocumentGateway } from '../src/collab/documents.js';
import { followCompileEvents } from '../src/compile/service.js';
import { readConfig } from '../src/config.js';
import { createS3Client, ensureBucket } from '../src/storage/s3.js';
import { Client } from './client.js';
import {
  dockerAvailable,
  S3_CREDENTIALS,
  startPostgres,
  startSeaweedfs,
  startValkey,
} from './containers.js';

const PDF = Buffer.from('%PDF-1.5\n%fake\n');
const LOG = Buffer.from('This is pdfTeX\nOutput written on main.pdf (1 page).\n');

/**
 * Stands in for the compiler worker. Behaviour is chosen by the job options,
 * which the API forwards untouched: `draft` holds the job until it is
 * cancelled, `haltOnError` makes the worker reject it.
 */
function startFakeWorker(url: string, s3: S3Client, bucket: string, redis: Redis) {
  return new Worker<CompileJob, CompileResult>(
    COMPILE_QUEUE,
    async (job) => {
      const data = job.data;
      if (data.haltOnError) throw new UnrecoverableError('INVALID_JOB');
      if (data.draft) {
        while ((await redis.exists(compileCancelKey(data.compileId))) === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return {
          outcome: 'cancelled',
          durationMs: 10,
          pdf: null,
          pages: null,
          diagnostics: [],
          truncated: false,
          outputs: [],
          texlive: 'TeX Live 2026',
          shellEscapeDowngraded: false,
          lint: [],
          wordCount: null,
        };
      }
      for (const [name, body] of [
        ['main.pdf', PDF],
        ['main.log', LOG],
      ] as const) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: compileOutputKey(data.compileId, name),
            Body: body,
          }),
        );
      }
      return {
        outcome: 'success',
        durationMs: 42,
        pdf: 'main.pdf',
        pages: 1,
        diagnostics: [
          {
            level: 'warning',
            source: 'tex',
            file: data.mainFile,
            line: 3,
            message: 'Reference `x` undefined',
            context: '',
          },
        ],
        truncated: false,
        outputs: [
          { name: 'main.pdf', size: PDF.length },
          { name: 'main.log', size: LOG.length },
          // Never read here: SyncTeX queries go to a stand-in client.
          { name: 'main.synctex.gz', size: 0 },
        ],
        texlive: 'TeX Live 2026',
        shellEscapeDowngraded: false,
        lint: [],
        wordCount: null,
      };
    },
    { connection: { url, maxRetriesPerRequest: null }, concurrency: 2 },
  );
}

describe.skipIf(!dockerAvailable)('compilation API', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let seaweedfs: StartedTestContainer;
  let database: Database;
  let redis: Redis;
  let subscriber: Redis;
  let s3: S3Client;
  let app: FastifyInstance;
  let queue: Queue<CompileJob, unknown>;
  let events: QueueEvents;
  let worker: Worker<CompileJob, CompileResult>;
  let bucket = '';
  let owner: Client;
  let projectId = '';
  const received: { compileId: string; status: string }[] = [];
  /** Queries the routes sent to the workers, and the answer to give next. */
  const synctexQueries: SynctexJob[] = [];
  let synctexAnswer: SynctexResult = { kind: 'edit', source: null };

  async function compile(options: Record<string, boolean> = {}): Promise<CompileRun> {
    const response = await owner.send('POST', `/api/projects/${projectId}/compile`, {
      json: options,
    });
    expect(response.statusCode).toBe(202);
    return compileRun.parse(response.json());
  }

  async function waitFor(compileId: string, status: string): Promise<CompileRun> {
    let run: CompileRun | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await owner.send('GET', `/api/projects/${projectId}/compiles/${compileId}`);
      run = compileRun.parse(response.json());
      if (run.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const job = await queue.getJob(compileId);
    const jobState = job ? await job.getState() : 'no job';
    const [row] = await database.db.select().from(compileRuns).where(eq(compileRuns.id, compileId));
    throw new Error(
      `compile ${compileId} stayed ${String(run?.status)}, expected ${status} (job ${jobState}, failure ${String(row?.failureCode)})`,
    );
  }

  beforeAll(async () => {
    [postgres, valkey, seaweedfs] = await Promise.all([
      startPostgres(),
      startValkey(),
      startSeaweedfs(),
    ]);
    const config = readConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      VALKEY_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
      S3_ENDPOINT: `http://${seaweedfs.getHost()}:${String(seaweedfs.getMappedPort(8333))}`,
      S3_ACCESS_KEY_ID: S3_CREDENTIALS.accessKeyId,
      S3_SECRET_ACCESS_KEY: S3_CREDENTIALS.secretAccessKey,
      S3_BUCKET: 'galley-compile',
    });
    bucket = config.S3_BUCKET;
    database = createDatabase(config.DATABASE_URL);
    redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
    subscriber = new Redis(config.VALKEY_URL);
    s3 = createS3Client(config);
    await runMigrations(database);
    await ensureBucket(s3, bucket);
    const logger = createLogger({ service: 'api-test', level: 'silent' });
    queue = new Queue(COMPILE_QUEUE, { connection: { url: config.VALKEY_URL } });
    events = new QueueEvents(COMPILE_QUEUE, {
      connection: { url: config.VALKEY_URL, maxRetriesPerRequest: null },
    });
    await events.waitUntilReady();
    const context = {
      config,
      database,
      redis,
      s3,
      documents: createDocumentGateway(config, database, logger),
      compileQueue: queue,
      synctex: (job: SynctexJob) => {
        synctexQueries.push(job);
        return Promise.resolve(synctexAnswer);
      },
    };
    followCompileEvents(context, events, logger);
    app = buildApp({ logger, version: 'test', probes: {}, context });
    await app.ready();

    worker = startFakeWorker(config.VALKEY_URL, s3, bucket, redis);
    await worker.waitUntilReady();

    const { code } = await ensureSetupCode(redis);
    owner = new Client(app, '10.1.0.1');
    await owner.send('POST', '/api/auth/setup', {
      json: {
        email: 'owner@example.org',
        username: 'owner',
        displayName: 'Owner',
        password: 'owner-password-123',
        setupCode: code,
      },
    });
    const created = await owner.send('POST', '/api/projects', {
      json: { name: 'Rapport', template: 'blank' },
    });
    projectId = created.json<{ project: { id: string } }>().project.id;

    await subscriber.subscribe(projectChannel(projectId));
    subscriber.on('message', (_channel: string, message: string) => {
      const event = projectEventMessage.parse(JSON.parse(message));
      if (event.type === 'compile.updated') {
        received.push({ compileId: event.compileId, status: event.status });
      }
    });
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
    await events.close();
    await queue.close();
    subscriber.disconnect();
    redis.disconnect();
    await database.sql.end({ timeout: 5 });
    s3.destroy();
    await Promise.all([postgres.stop(), valkey.stop(), seaweedfs.stop()]);
  });

  it('reports the TeX Live release announced by the workers', async () => {
    await redis.set(TEXLIVE_VERSION_KEY, 'TeX Live 2026');
    const response = await owner.send('GET', '/api/compiler');
    expect(response.json()).toEqual({ texlive: 'TeX Live 2026' });
  });

  it('compiles the project and records the worker result', async () => {
    const queued = await compile();
    expect(queued).toMatchObject({
      status: 'queued',
      mainFile: 'main.tex',
      engine: 'pdflatex',
      options: { draft: false, haltOnError: false, clean: false, shellEscape: 'restricted' },
    });
    const job = await queue.getJob(queued.id);
    expect(job?.data).toMatchObject({ compileId: queued.id, projectId, mainFile: 'main.tex' });
    expect(Object.keys(job?.data.manifest ?? {})).toEqual(['main.tex']);

    const done = await waitFor(queued.id, 'success');
    expect(done).toMatchObject({
      pdf: 'main.pdf',
      pages: 1,
      durationMs: 42,
      texlive: 'TeX Live 2026',
      diagnostics: [{ level: 'warning', file: 'main.tex', line: 3 }],
    });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();

    const latest = latestCompileResponse.parse(
      (await owner.send('GET', `/api/projects/${projectId}/compiles/latest`)).json(),
    );
    expect(latest.latest?.id).toBe(queued.id);
    expect(latest.lastPdf?.id).toBe(queued.id);

    const statuses = received.filter((event) => event.compileId === queued.id).map((e) => e.status);
    expect(statuses).toEqual(['queued', 'running', 'success']);
  });

  it('serves published files, and nothing else', async () => {
    const run = await waitFor((await compile()).id, 'success');
    const base = `/api/projects/${projectId}/compiles/${run.id}/output`;
    const pdf = await owner.send('GET', `${base}/main.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.equals(PDF)).toBe(true);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['cache-control']).toContain('immutable');
    expect((await owner.send('GET', `${base}/main.log`)).body).toContain('Output written');
    expect((await owner.send('GET', `${base}/main.aux`)).statusCode).toBe(404);
    expect((await owner.send('GET', `${base}/..%2Fother%2Fmain.pdf`)).statusCode).toBe(404);
  });

  it('maps a point of the PDF to a project file through SyncTeX', async () => {
    const run = await waitFor((await compile()).id, 'success');
    const base = `/api/projects/${projectId}/compiles/${run.id}/synctex`;
    synctexAnswer = {
      kind: 'edit',
      source: { input: '/project/./main.tex', line: 3, column: null },
    };
    const found = await owner.send('GET', `${base}/edit?page=2&x=100.5&y=200`);
    expect(found.statusCode).toBe(200);
    const tree = await owner.send('GET', `/api/projects/${projectId}/tree`);
    const main = tree
      .json<{ nodes: { id: string; name: string }[] }>()
      .nodes.find((node) => node.name === 'main.tex');
    expect(found.json()).toEqual({
      file: { id: main?.id, path: 'main.tex' },
      externalFile: null,
      line: 3,
      column: null,
    });
    expect(synctexQueries.at(-1)).toEqual({
      kind: 'edit',
      compileId: run.id,
      synctexFile: 'main.synctex.gz',
      page: 2,
      x: 100.5,
      y: 200,
    });

    synctexAnswer = {
      kind: 'edit',
      source: {
        input: '/usr/local/texlive/2026/texmf-dist/tex/latex/base/article.cls',
        line: 9,
        column: null,
      },
    };
    expect((await owner.send('GET', `${base}/edit?page=1&x=1&y=1`)).json()).toMatchObject({
      file: null,
      externalFile: 'article.cls',
    });

    // A file of the compilation that no longer exists in the project.
    synctexAnswer = {
      kind: 'edit',
      source: { input: '/project/./gone.tex', line: 1, column: null },
    };
    expect((await owner.send('GET', `${base}/edit?page=1&x=1&y=1`)).json()).toMatchObject({
      file: null,
      externalFile: null,
      line: 1,
    });

    expect((await owner.send('GET', `${base}/edit?page=0&x=1&y=1`)).statusCode).toBe(400);
  });

  it('maps a source line to boxes of the PDF through SyncTeX', async () => {
    const run = await waitFor((await compile()).id, 'success');
    const tree = await owner.send('GET', `/api/projects/${projectId}/tree`);
    const main = tree
      .json<{ nodes: { id: string; name: string }[] }>()
      .nodes.find((node) => node.name === 'main.tex');
    const boxes = [{ page: 1, x: 72, y: 100, width: 300, height: 10 }];
    synctexAnswer = { kind: 'view', boxes };
    const base = `/api/projects/${projectId}/compiles/${run.id}/synctex`;
    const view = await owner.send('GET', `${base}/view?fileId=${main?.id ?? ''}&line=4`);
    expect(view.json()).toEqual({ boxes });
    expect(synctexQueries.at(-1)).toMatchObject({
      kind: 'view',
      file: 'main.tex',
      line: 4,
      column: 0,
    });
    const unknown = await owner.send(
      'GET',
      `${base}/view?fileId=0193f9f0-4d0a-7c3e-8f5a-1b2c3d4e5f60&line=4`,
    );
    expect(unknown.statusCode).toBe(404);
  });

  it('answers NO_SYNCTEX for a compilation without SyncTeX data', async () => {
    const queued = await compile({ draft: true });
    await owner.send('POST', `/api/projects/${projectId}/compiles/${queued.id}/cancel`);
    await waitFor(queued.id, 'cancelled');
    const response = await owner.send(
      'GET',
      `/api/projects/${projectId}/compiles/${queued.id}/synctex/edit?page=1&x=1&y=1`,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'NO_SYNCTEX' } });
  });

  it('keeps the compilations and their files private to project members', async () => {
    const run = (await compile()).id;
    await waitFor(run, 'success');
    const invite = await owner.send('POST', '/api/admin/invites', { json: {} });
    const stranger = new Client(app, '10.1.0.2');
    await stranger.send('POST', '/api/auth/register', {
      json: {
        email: 'stranger@example.org',
        username: 'stranger',
        displayName: 'Stranger',
        password: 'stranger-password-123',
        inviteToken: invite.json<{ token: string }>().token,
      },
    });
    const urls = [
      `/api/projects/${projectId}/compiles/latest`,
      `/api/projects/${projectId}/compiles/${run}`,
      `/api/projects/${projectId}/compiles/${run}/output/main.pdf`,
      `/api/projects/${projectId}/compiles/${run}/synctex/edit?page=1&x=1&y=1`,
    ];
    for (const url of urls) expect((await stranger.send('GET', url)).statusCode).toBe(404);
    const posted = await stranger.send('POST', `/api/projects/${projectId}/compile`, { json: {} });
    expect(posted.statusCode).toBe(404);

    // A reader may compile: compiling never changes the sources.
    const [user] = await database.sql<
      { id: string }[]
    >`select id from users where username = 'stranger'`;
    await database.db
      .insert(projectMembers)
      .values({ projectId, userId: user?.id ?? '', role: 'reader' });
    const allowed = await stranger.send('POST', `/api/projects/${projectId}/compile`, { json: {} });
    expect(allowed.statusCode).toBe(202);
    await waitFor(compileRun.parse(allowed.json()).id, 'success');
  });

  it('withdraws a waiting compilation when a newer one is requested', async () => {
    await worker.pause();
    const first = await compile();
    const second = await compile();
    expect((await waitFor(first.id, 'superseded')).finishedAt).not.toBeNull();
    expect(await queue.getJob(first.id)).toBeUndefined();
    await worker.resume();
    await waitFor(second.id, 'success');
  });

  it('cancels a waiting compilation by withdrawing its job', async () => {
    await worker.pause();
    const run = await compile();
    const response = await owner.send(
      'POST',
      `/api/projects/${projectId}/compiles/${run.id}/cancel`,
    );
    expect(compileRun.parse(response.json()).status).toBe('cancelled');
    expect(await queue.getJob(run.id)).toBeUndefined();
    await worker.resume();
  });

  it('cancels a running compilation through its worker', async () => {
    const run = await compile({ draft: true });
    await waitFor(run.id, 'running');
    await owner.send('POST', `/api/projects/${projectId}/compiles/${run.id}/cancel`);
    expect(await redis.exists(compileCancelKey(run.id))).toBe(1);
    await waitFor(run.id, 'cancelled');
  });

  it('records a job the worker rejects as an error', async () => {
    const run = await compile({ haltOnError: true });
    await waitFor(run.id, 'error');
  });

  it('marks a compilation whose job vanished as lost', async () => {
    await worker.pause();
    const run = await compile();
    await queue.remove(run.id);
    await waitFor(run.id, 'error');
    const [row] = await database.db.select().from(compileRuns).where(eq(compileRuns.id, run.id));
    expect(row?.failureCode).toBe('LOST');
    await worker.resume();
  });

  it('refuses to compile a project without a main file', async () => {
    await owner.send('PATCH', `/api/projects/${projectId}`, { json: { mainFileId: null } });
    const response = await owner.send('POST', `/api/projects/${projectId}/compile`, { json: {} });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NO_MAIN_FILE');
  });

  it('keeps the three latest finished compilations and the last PDF, with their files', async () => {
    const rows = await database.db
      .select({ id: compileRuns.id })
      .from(compileRuns)
      .where(eq(compileRuns.projectId, projectId));
    expect(rows.length).toBeLessThanOrEqual(4);
    const latest = latestCompileResponse.parse(
      (await owner.send('GET', `/api/projects/${projectId}/compiles/latest`)).json(),
    );
    // The latest runs failed or were cancelled; the last PDF survives them.
    expect(latest.lastPdf?.pdf).toBe('main.pdf');
    const head = (id: string) =>
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: compileOutputKey(id, 'main.pdf') }));
    await expect(head(latest.lastPdf?.id ?? '')).resolves.toBeDefined();
    const kept = new Set(rows.map((row) => row.id));
    const deleted = received.find(
      (event) => event.status === 'success' && !kept.has(event.compileId),
    );
    expect(deleted).toBeDefined();
    await expect(head(deleted?.compileId ?? '')).rejects.toThrow();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { projectRemotes } from '@galley/db';
import { COMPILE_QUEUE, type CompileJob, type PullResponse } from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import { createDatabase, type Database, runMigrations } from '@galley/db';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureSetupCode } from '../src/auth/setup.js';
import { createDocumentGateway } from '../src/collab/documents.js';
import { type ApiConfig, readConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { DEVELOPMENT_MASTER_KEY } from '../src/crypto/secrets.js';
import { createS3Client, ensureBucket } from '../src/storage/s3.js';
import { Client } from './client.js';
import {
  dockerAvailable,
  S3_CREDENTIALS,
  startPostgres,
  startSeaweedfs,
  startValkey,
} from './containers.js';
import { multipart } from './zip.js';

/**
 * The remote is another Galley project, reached through the instance's own Git
 * endpoint: a real smart-HTTP server with tokens, refusals and hooks, standing
 * for GitHub or GitLab without leaving the machine.
 */
describe.skipIf(!dockerAvailable)('GitHub and GitLab synchronisation', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let seaweedfs: StartedTestContainer;
  let database: Database;
  let redis: Redis;
  let s3: S3Client;
  let app: FastifyInstance;
  let config: ApiConfig;
  let compileQueue: Queue<CompileJob, unknown>;
  let scratch: string;
  let base: string;
  let ipCounter = 0;
  const client = (): Client => new Client(app, `10.5.0.${String(++ipCounter)}`);

  let alice: Client;
  let bob: Client;
  let token: string;
  /** The project synchronised, and the one standing for the remote repository. */
  let local: string;
  let upstream: string;

  async function register(admin: Client, name: string): Promise<Client> {
    const invite = await admin.send('POST', '/api/admin/invites', { json: {} });
    const user = client();
    await user.send('POST', '/api/auth/register', {
      json: {
        email: `${name}@example.org`,
        username: name,
        displayName: name,
        password: `${name}-password-123`,
        inviteToken: invite.json<{ token: string }>().token,
      },
    });
    return user;
  }

  async function project(name: string): Promise<string> {
    const created = await alice.send('POST', '/api/projects', { json: { name } });
    expect(created.statusCode, created.body).toBe(201);
    return created.json<{ project: { id: string } }>().project.id;
  }

  const upload = (projectId: string, path: string, data: string) =>
    alice.send('POST', `/api/projects/${projectId}/files`, {
      form: multipart([
        { name: 'path', value: path },
        { name: 'file', filename: path.split('/').at(-1) ?? path, data: Buffer.from(data) },
      ]),
    });

  async function file(projectId: string, path: string): Promise<string> {
    const response = await alice.send(
      'GET',
      `/api/projects/${projectId}/history/current/content?path=${encodeURIComponent(path)}`,
    );
    return response.statusCode === 200 ? response.body : `<${String(response.statusCode)}>`;
  }

  const pull = async (user = alice) => {
    const response = await user.send('POST', `/api/projects/${local}/remote/pull`);
    return {
      status: response.statusCode,
      body: response.json<PullResponse & { error?: { code: string } }>(),
    };
  };
  const push = async (user = alice) => {
    const response = await user.send('POST', `/api/projects/${local}/remote/push`);
    return {
      status: response.statusCode,
      body: response.json<{ outcome?: string; error?: { code: string } }>(),
    };
  };
  const setRemote = (body: Record<string, unknown>, user = alice) =>
    user.send('PUT', `/api/projects/${local}/remote`, { json: body });

  beforeAll(async () => {
    [postgres, valkey, seaweedfs] = await Promise.all([
      startPostgres(),
      startValkey(),
      startSeaweedfs(),
    ]);
    scratch = await mkdtemp(join(tmpdir(), 'galley-remote-'));
    config = readConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      VALKEY_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
      S3_ENDPOINT: `http://${seaweedfs.getHost()}:${String(seaweedfs.getMappedPort(8333))}`,
      S3_ACCESS_KEY_ID: S3_CREDENTIALS.accessKeyId,
      S3_SECRET_ACCESS_KEY: S3_CREDENTIALS.secretAccessKey,
      S3_BUCKET: 'galley-remote',
      GIT_DATA_DIR: join(scratch, 'repositories'),
      GALLEY_MASTER_KEY: DEVELOPMENT_MASTER_KEY,
      GIT_SYNC_ALLOW_HTTP: 'true',
    });
    database = createDatabase(config.DATABASE_URL);
    redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
    s3 = createS3Client(config);
    await runMigrations(database);
    await ensureBucket(s3, config.S3_BUCKET);
    const logger = createLogger({ service: 'api-test', level: 'silent' });
    compileQueue = new Queue(COMPILE_QUEUE, { connection: { url: config.VALKEY_URL } });
    const context: AppContext = {
      config,
      database,
      redis,
      s3,
      documents: createDocumentGateway(config, database, logger),
      compileQueue,
      synctex: () => Promise.reject(new Error('no SyncTeX in these tests')),
    };
    app = buildApp({ logger, version: 'test', probes: {}, context });
    await app.listen({ host: '127.0.0.1', port: 0 });
    // The address only exists once listening; it is a TCP one.
    const host = `127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    base = `http://${host}`;
    // The routes read the allowed hosts at each request; the port is known only now.
    config.GIT_SYNC_HOSTS = ['github.com', host];

    const admin = client();
    const { code } = await ensureSetupCode(redis);
    await admin.send('POST', '/api/auth/setup', {
      json: {
        email: 'admin@example.org',
        username: 'admin',
        displayName: 'Admin',
        password: 'admin-password-123',
        setupCode: code,
      },
    });
    alice = await register(admin, 'alice');
    bob = await register(admin, 'bob');
    const created = await alice.send('POST', '/api/tokens', { json: { name: 'Synchronisation' } });
    token = created.json<{ token: string }>().token;
    upstream = await project('Dépôt distant');
    local = await project('Thèse');
    const invited = await alice.send('POST', `/api/projects/${local}/invites`, {
      json: { identifier: 'bob', role: 'editor' },
    });
    await bob.send('POST', `/api/invites/${invited.json<{ id: string }>().id}/accept`);
  });

  afterAll(async () => {
    await app.close();
    await compileQueue.close();
    await database.sql.end({ timeout: 5 });
    redis.disconnect();
    s3.destroy();
    await rm(scratch, { recursive: true, force: true });
    await Promise.all([postgres.stop(), valkey.stop(), seaweedfs.stop()]);
  });

  it('lets the owner set the repository, branch and token, shown by its hint only', async () => {
    const empty = await bob.send('GET', `/api/projects/${local}/remote`);
    expect(empty.json()).toMatchObject({ remote: null, available: true });
    expect(empty.json<{ allowedHosts: string[] }>().allowedHosts).toContain('github.com');

    expect(
      (await setRemote({ url: `${base}/git/${upstream}`, branch: 'main', token }, bob)).statusCode,
    ).toBe(403);
    const elsewhere = await setRemote({ url: 'https://evil.example/a/b', branch: 'main', token });
    expect(elsewhere.json()).toMatchObject({ error: { code: 'REMOTE_URL_REFUSED' } });
    const option = await setRemote({
      url: `${base}/git/${upstream}`,
      branch: '--upload-pack=x',
      token,
    });
    expect(option.statusCode).toBe(400);
    const noToken = await setRemote({ url: `${base}/git/${upstream}`, branch: 'main' });
    expect(noToken.statusCode).toBe(400);

    const set = await setRemote({ url: `${base}/git/${upstream}/`, branch: 'main', token });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({
      url: `${base}/git/${upstream}`,
      branch: 'main',
      tokenHint: token.slice(-4),
      lastSyncedAt: null,
    });
    const shown = await bob.send('GET', `/api/projects/${local}/remote`);
    expect(shown.body).not.toContain(token);
    const [stored] = await database.db.select().from(projectRemotes);
    expect(Buffer.from(stored?.tokenCiphertext ?? []).toString('latin1')).not.toContain(token);
  });

  it('pulls a repository with files of its own into a new project, then is up to date', async () => {
    expect(
      (await upload(upstream, 'chapitres/intro.tex', 'Introduction distante.\n')).statusCode,
    ).toBe(201);
    const first = await pull(bob);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(['merged', 'updated']).toContain(first.body.outcome);
    expect(await file(local, 'chapitres/intro.tex')).toBe('Introduction distante.\n');
    expect((await pull()).body).toEqual({ outcome: 'upToDate' });
    const status = await alice.send('GET', `/api/projects/${local}/remote`);
    expect(
      status.json<{ remote: { lastSyncedAt: string | null } }>().remote.lastSyncedAt,
    ).not.toBeNull();
  });

  it('pushes the project, then refuses to push over remote changes until pulled', async () => {
    await upload(local, 'notes.tex', 'Notes locales.\n');
    const pushed = await push(bob);
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body.outcome).toBe('pushed');
    expect(await file(upstream, 'notes.tex')).toBe('Notes locales.\n');
    expect((await push()).body.outcome).toBe('upToDate');

    await upload(upstream, 'distant.tex', 'Ajout distant.\n');
    const refused = await push();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: 'REMOTE_AHEAD' } });
    expect((await pull()).body.outcome).toBe('updated');
    expect(await file(local, 'distant.tex')).toBe('Ajout distant.\n');
  });

  it('merges changes made on both sides, and stops on a conflict without touching the project', async () => {
    await upload(local, 'local.tex', 'Ligne locale.\n');
    await upload(upstream, 'autre.tex', 'Ligne distante.\n');
    const merged = await pull();
    expect(merged.body.outcome).toBe('merged');
    expect(await file(local, 'local.tex')).toBe('Ligne locale.\n');
    expect(await file(local, 'autre.tex')).toBe('Ligne distante.\n');
    expect((await push()).body.outcome).toBe('pushed');
    expect(await file(upstream, 'local.tex')).toBe('Ligne locale.\n');

    await upload(local, 'notes.tex', 'Version locale.\n');
    await upload(upstream, 'notes.tex', 'Version distante.\n');
    const conflict = await pull();
    expect(conflict.body).toEqual({ outcome: 'conflict', paths: ['notes.tex'] });
    expect(await file(local, 'notes.tex')).toBe('Version locale.\n');
  });

  it('reports a wrong token, a missing branch and a branch the remote protects', async () => {
    await setRemote({ url: `${base}/git/${upstream}`, branch: 'main', token: 'glp_wrong' });
    expect((await pull()).body).toMatchObject({ error: { code: 'REMOTE_AUTH_FAILED' } });
    await setRemote({ url: `${base}/git/${upstream}`, branch: 'brouillon', token });
    expect((await pull()).body).toMatchObject({ error: { code: 'REMOTE_BRANCH_NOT_FOUND' } });
    // The Galley endpoint accepts main only, as a protected branch would refuse.
    expect((await push()).body).toMatchObject({ error: { code: 'REMOTE_REJECTED' } });
    const removed = await alice.send('DELETE', `/api/projects/${local}/remote`);
    expect(removed.statusCode).toBe(204);
    expect((await pull()).body).toMatchObject({ error: { code: 'REMOTE_NOT_CONFIGURED' } });
  });

  it('never serves the fetched branch to Git clients', async () => {
    const refs = await fetch(`${base}/git/${local}/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${Buffer.from(`alice:${token}`).toString('base64')}` },
    });
    expect(refs.status).toBe(200);
    const advertised = await refs.text();
    expect(advertised).toContain('refs/heads/main');
    expect(advertised).not.toContain('refs/sync');
  });
});

import { randomUUID } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  type AdminUsersResponse,
  COMPILE_QUEUE,
  type CompileJob,
  type InstanceSettingsResponse,
  type QuotaUsage,
  SESSION_COOKIE,
  type SystemStatus,
  type TemporaryPasswordResponse,
} from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import {
  compileRuns,
  createDatabase,
  type Database,
  instanceSettings,
  runMigrations,
  userIdentities,
} from '@galley/db';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { OAuth2Server } from 'oauth2-mock-server';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureSetupCode } from '../src/auth/setup.js';
import { createDocumentGateway } from '../src/collab/documents.js';
import { readConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
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

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const OIDC_CLIENT = { id: 'galley', secret: 'galley-oidc-secret' };

describe.skipIf(!dockerAvailable)('administration, quotas and OIDC', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let seaweedfs: StartedTestContainer;
  let database: Database;
  let redis: Redis;
  let s3: S3Client;
  let app: FastifyInstance;
  let compileQueue: Queue<CompileJob, unknown>;
  let provider: OAuth2Server;
  /** Claims the simulated provider puts in its next ID tokens. */
  let claims: Record<string, unknown> = {};
  let ipCounter = 0;
  const client = (): Client => new Client(app, `10.1.0.${String(++ipCounter)}`);

  let admin: Client;

  async function userIdOf(user: Client): Promise<string> {
    return (await user.send('GET', '/api/auth/session')).json<{ user: { id: string } }>().user.id;
  }

  async function login(user: Client, name: string, password: string) {
    return user.send('POST', '/api/auth/login', { json: { login: name, password } });
  }

  async function createProject(user: Client): Promise<string> {
    const response = await user.send('POST', '/api/projects', {
      json: { name: 'Quota', template: 'article' },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ project: { id: string } }>().project.id;
  }

  function upload(user: Client, projectId: string, bytes: number) {
    return user.send('POST', `/api/projects/${projectId}/files`, {
      form: multipart([
        { name: 'file', filename: `${randomUUID()}.bin`, data: Buffer.alloc(bytes, 1) },
      ]),
    });
  }

  async function patchSettings(body: unknown) {
    const response = await admin.send('PATCH', '/api/admin/settings', { json: body });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<InstanceSettingsResponse>();
  }

  beforeAll(async () => {
    provider = new OAuth2Server();
    await provider.issuer.keys.generate('RS256');
    await provider.start(0, '127.0.0.1');
    provider.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => {
      Object.assign(token.payload, claims);
    });
    const issuer = provider.issuer.url;
    if (issuer === undefined) throw new Error('the simulated provider has no address');

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
      S3_BUCKET: 'galley-admin',
      GALLEY_MASTER_KEY: MASTER_KEY,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: OIDC_CLIENT.id,
      OIDC_CLIENT_SECRET: OIDC_CLIENT.secret,
      OIDC_DISPLAY_NAME: 'Campus',
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
    await app.ready();

    const { code } = await ensureSetupCode(redis);
    admin = client();
    const created = await admin.send('POST', '/api/auth/setup', {
      json: {
        email: 'root@example.org',
        username: 'root',
        displayName: 'Root',
        password: 'root-password-123',
        setupCode: code,
      },
    });
    expect(created.statusCode).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    await compileQueue.close();
    await database.sql.end({ timeout: 5 });
    redis.disconnect();
    s3.destroy();
    await provider.stop();
    await Promise.all([postgres.stop(), valkey.stop(), seaweedfs.stop()]);
  });

  describe('instance settings', () => {
    it('are reserved to administrators', async () => {
      const response = await admin.send('POST', '/api/admin/users', {
        json: { email: 'eve@example.org', username: 'eve', displayName: 'Eve' },
      });
      const { temporaryPassword } = response.json<TemporaryPasswordResponse>();
      const eve = client();
      expect((await login(eve, 'eve', temporaryPassword)).statusCode).toBe(200);
      for (const [method, url] of [
        ['GET', '/api/admin/settings'],
        ['PATCH', '/api/admin/settings'],
        ['GET', '/api/admin/users'],
        ['GET', '/api/admin/system'],
      ] as const) {
        const refused = await eve.send(method, url, method === 'GET' ? {} : { json: {} });
        expect(refused.statusCode, url).toBe(403);
      }
    });

    it('follow the environment until changed in the console', async () => {
      const initial = (
        await admin.send('GET', '/api/admin/settings')
      ).json<InstanceSettingsResponse>();
      expect(initial).toMatchObject({
        registrationMode: 'invite',
        quotas: { storageMb: null, compileMinutes: null },
        aiEnabled: true,
        aiDefault: null,
        overridden: [],
      });

      const changed = await patchSettings({ registrationMode: 'open' });
      expect(changed.registrationMode).toBe('open');
      expect(changed.overridden).toEqual(['registrationMode']);
      const config = await client().send('GET', '/api/auth/config');
      expect(config.json()).toMatchObject({ registrationMode: 'open' });
      const registered = await client().send('POST', '/api/auth/register', {
        json: {
          email: 'open@example.org',
          username: 'open',
          displayName: 'Open',
          password: 'open-password-123',
        },
      });
      expect(registered.statusCode, registered.body).toBe(201);

      await patchSettings({ registrationMode: 'closed' });
      const refused = await client().send('POST', '/api/auth/register', {
        json: {
          email: 'late@example.org',
          username: 'late',
          displayName: 'Late',
          password: 'late-password-123',
        },
      });
      expect(refused.statusCode).toBe(403);
    });

    it('store the default model key sealed, shown by its last characters only', async () => {
      const key = 'sk-instance-secret-WXYZ';
      const saved = await patchSettings({
        aiDefault: {
          provider: 'openai-compatible',
          model: 'llama3.1',
          baseUrl: 'http://ollama:11434/v1',
          apiKey: key,
          vision: false,
          contextTokens: 32_000,
        },
      });
      expect(saved.aiDefault).toEqual({
        provider: 'openai-compatible',
        model: 'llama3.1',
        baseUrl: 'http://ollama:11434/v1',
        keyHint: 'WXYZ',
        vision: false,
        contextTokens: 32_000,
      });
      expect(JSON.stringify(saved)).not.toContain(key);
      const [row] = await database.db
        .select()
        .from(instanceSettings)
        .where(eq(instanceSettings.key, 'aiDefault'));
      expect(JSON.stringify(row?.value)).not.toContain(key);

      const mine = await admin.send('GET', '/api/me/ai/provider');
      expect(mine.json()).toMatchObject({
        instance: { provider: 'openai-compatible', model: 'llama3.1' },
      });

      // Same provider without a key keeps the stored one.
      const kept = await patchSettings({
        aiDefault: {
          provider: 'openai-compatible',
          model: 'qwen2.5',
          baseUrl: 'http://ollama:11434/v1',
          vision: null,
          contextTokens: null,
        },
      });
      expect(kept.aiDefault?.keyHint).toBe('WXYZ');

      const removed = await patchSettings({ aiDefault: null, aiEnabled: false });
      expect(removed.aiDefault).toBeNull();
      expect(removed.overridden).not.toContain('aiDefault');
      expect((await admin.send('GET', '/api/me/ai/provider')).json()).toMatchObject({
        enabled: false,
      });
      await patchSettings({ aiEnabled: true });
    });
  });

  describe('accounts', () => {
    it('are created with a temporary password, listed and searched', async () => {
      const response = await admin.send('POST', '/api/admin/users', {
        json: { email: 'grace@example.org', username: 'grace', displayName: 'Grace Hopper' },
      });
      expect(response.statusCode, response.body).toBe(201);
      const created = response.json<TemporaryPasswordResponse>();
      expect(created.user).toMatchObject({ username: 'grace', isAdmin: false, hasPassword: true });
      expect(created.temporaryPassword.length).toBeGreaterThanOrEqual(15);
      expect((await login(client(), 'grace', created.temporaryPassword)).statusCode).toBe(200);

      const found = (await admin.send('GET', '/api/admin/users?q=hopp')).json<AdminUsersResponse>();
      expect(found.total).toBe(1);
      expect(found.users[0]).toMatchObject({ username: 'grace', disabled: false });
      expect(found.users[0]?.lastSeenAt).not.toBeNull();
      const wildcard = (
        await admin.send('GET', '/api/admin/users?q=%25')
      ).json<AdminUsersResponse>();
      expect(wildcard.total).toBe(0);
    });

    it('are disabled with their sessions, and their password reset', async () => {
      const response = await admin.send('POST', '/api/admin/users', {
        json: { email: 'mallory@example.org', username: 'mallory', displayName: 'Mallory' },
      });
      const { user, temporaryPassword } = response.json<TemporaryPasswordResponse>();
      const mallory = client();
      expect((await login(mallory, 'mallory', temporaryPassword)).statusCode).toBe(200);

      const disabled = await admin.send('PATCH', `/api/admin/users/${user.id}`, {
        json: { disabled: true },
      });
      expect(disabled.json()).toMatchObject({ user: { disabled: true } });
      expect((await mallory.send('GET', '/api/projects')).statusCode).toBe(401);
      expect((await login(client(), 'mallory', temporaryPassword)).statusCode).toBe(401);

      await admin.send('PATCH', `/api/admin/users/${user.id}`, { json: { disabled: false } });
      const reset = await admin.send('POST', `/api/admin/users/${user.id}/password`, { json: {} });
      const next = reset.json<TemporaryPasswordResponse>().temporaryPassword;
      expect((await login(client(), 'mallory', temporaryPassword)).statusCode).toBe(401);
      expect((await login(client(), 'mallory', next)).statusCode).toBe(200);
    });

    it('always keep one active administrator', async () => {
      const rootId = await userIdOf(admin);
      const alone = await admin.send('PATCH', `/api/admin/users/${rootId}`, {
        json: { isAdmin: false },
      });
      expect(alone.statusCode).toBe(409);
      expect(alone.json()).toMatchObject({ error: { code: 'LAST_ADMIN' } });
      expect(
        (await admin.send('PATCH', `/api/admin/users/${rootId}`, { json: { disabled: true } }))
          .statusCode,
      ).toBe(409);

      const second = await admin.send('POST', '/api/admin/users', {
        json: { email: 'ada@example.org', username: 'ada', displayName: 'Ada', isAdmin: true },
      });
      expect(second.json<TemporaryPasswordResponse>().user.isAdmin).toBe(true);
      const demoted = await admin.send('PATCH', `/api/admin/users/${rootId}`, {
        json: { isAdmin: false },
      });
      expect(demoted.statusCode).toBe(200);
      // Rights are read from the account on each request: back through the other admin.
      const ada = client();
      await login(ada, 'ada', second.json<TemporaryPasswordResponse>().temporaryPassword);
      await ada.send('PATCH', `/api/admin/users/${rootId}`, { json: { isAdmin: true } });
      expect((await admin.send('GET', '/api/admin/settings')).statusCode).toBe(200);
    });

    it('reports the state of the services', async () => {
      const status = (await admin.send('GET', '/api/admin/system')).json<SystemStatus>();
      expect(status).toMatchObject({ version: 'test', oidc: { issuer: provider.issuer.url } });
      expect(Object.keys(status.compileQueue).sort()).toEqual([
        'active',
        'delayed',
        'failed',
        'waiting',
      ]);
      expect(status.users.total).toBeGreaterThanOrEqual(5);
    });
  });

  describe('quotas', () => {
    it('refuse an upload beyond the owner storage, unless lifted for them', async () => {
      const owner = client();
      const created = await admin.send('POST', '/api/admin/users', {
        json: { email: 'owner@example.org', username: 'owner', displayName: 'Owner' },
      });
      const { user, temporaryPassword } = created.json<TemporaryPasswordResponse>();
      await login(owner, 'owner', temporaryPassword);
      const projectId = await createProject(owner);

      await patchSettings({ quotas: { storageMb: 1, compileMinutes: null } });
      expect((await upload(owner, projectId, 300_000)).statusCode).toBe(201);
      const refused = await upload(owner, projectId, 900_000);
      expect(refused.statusCode).toBe(413);
      expect(refused.json()).toMatchObject({ error: { code: 'QUOTA_STORAGE_EXCEEDED' } });

      const usage = (await owner.send('GET', '/api/me/quotas')).json<QuotaUsage>();
      expect(usage.storage.limitBytes).toBe(1024 * 1024);
      expect(usage.storage.usedBytes).toBeGreaterThanOrEqual(300_000);
      expect(usage.storage.usedBytes).toBeLessThan(1024 * 1024);

      await admin.send('PATCH', `/api/admin/users/${user.id}`, {
        json: { quotas: { storageMb: -1, compileMinutes: null } },
      });
      expect((await upload(owner, projectId, 900_000)).statusCode).toBe(201);
      expect(
        (await owner.send('GET', '/api/me/quotas')).json<QuotaUsage>().storage.limitBytes,
      ).toBeNull();
      await patchSettings({ quotas: { storageMb: null, compileMinutes: null } });
    });

    it('refuse to start a compilation once the month is used up', async () => {
      const compiler = client();
      const created = await admin.send('POST', '/api/admin/users', {
        json: { email: 'busy@example.org', username: 'busy', displayName: 'Busy' },
      });
      const { user, temporaryPassword } = created.json<TemporaryPasswordResponse>();
      await login(compiler, 'busy', temporaryPassword);
      const projectId = await createProject(compiler);
      const finished = new Date();
      await database.db.insert(compileRuns).values({
        id: randomUUID(),
        projectId,
        userId: user.id,
        status: 'success',
        engine: 'pdflatex',
        mainFile: 'main.tex',
        options: {
          draft: false,
          haltOnError: false,
          clean: false,
          bibTool: 'biber',
          shellEscape: 'restricted',
        },
        manifestDigest: 'x',
        startedAt: new Date(finished.getTime() - 90_000),
        finishedAt: finished,
      });

      await admin.send('PATCH', `/api/admin/users/${user.id}`, {
        json: { quotas: { storageMb: null, compileMinutes: 1 } },
      });
      const refused = await compiler.send('POST', `/api/projects/${projectId}/compile`, {
        json: {},
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ error: { code: 'QUOTA_COMPILE_EXCEEDED' } });
      const usage = (await compiler.send('GET', '/api/me/quotas')).json<QuotaUsage>();
      expect(usage.compile).toMatchObject({ usedSeconds: 90, limitSeconds: 60 });

      const listed = (
        await admin.send('GET', '/api/admin/users?q=busy')
      ).json<AdminUsersResponse>();
      expect(listed.users[0]).toMatchObject({
        compileSecondsThisMonth: 90,
        quotas: { storageMb: null, compileMinutes: 1 },
      });
    });
  });

  describe('identity provider', () => {
    /** Runs a sign-in through the simulated provider; returns the browser and the final redirect. */
    async function signIn(redirect?: string) {
      const browser = client();
      const query = redirect === undefined ? '' : `?redirect=${encodeURIComponent(redirect)}`;
      const start = await browser.send('GET', `/api/auth/oidc/start${query}`);
      expect(start.statusCode, start.body).toBe(302);
      const state = start.cookies.find((cookie) => cookie.name === 'galley_oidc_state');
      expect(state).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
      const authorize = await fetch(start.headers.location ?? '', { redirect: 'manual' });
      const back = new URL(authorize.headers.get('location') ?? '');
      expect(back.pathname).toBe('/api/auth/oidc/callback');
      const callback = await browser.send('GET', `${back.pathname}${back.search}`, {
        headers: { cookie: `galley_oidc_state=${state?.value ?? ''}` },
      });
      expect(callback.statusCode).toBe(302);
      return { browser, location: callback.headers.location, start, back };
    }

    it('is announced on the sign-in page', async () => {
      const config = await client().send('GET', '/api/auth/config');
      expect(config.json()).toMatchObject({ oidc: { displayName: 'Campus' } });
    });

    it('links a verified address to the existing account', async () => {
      claims = { sub: 'grace-at-campus', email: 'Grace@Example.org', email_verified: true };
      const { browser, location } = await signIn('/project/abc');
      expect(location).toBe('/project/abc');
      const session = await browser.send('GET', '/api/auth/session');
      expect(session.json()).toMatchObject({ user: { username: 'grace' } });
      const links = await database.db
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.subject, 'grace-at-campus'));
      expect(links).toHaveLength(1);
    });

    it('refuses an unverified address and an unknown person while registration is closed', async () => {
      claims = { sub: 'stranger-1', email: 'grace@example.org', email_verified: false };
      expect((await signIn()).location).toBe('/login?error=OIDC_EMAIL_UNVERIFIED');
      claims = { sub: 'stranger-2', email: 'new@example.org', email_verified: true };
      expect((await signIn()).location).toBe('/login?error=OIDC_SIGNUP_CLOSED');
    });

    it('creates an account without password when registration is open', async () => {
      await patchSettings({ registrationMode: 'open' });
      claims = {
        sub: 'linus-1',
        email: 'linus@example.org',
        email_verified: true,
        preferred_username: 'grace',
        name: 'Linus',
      };
      const { browser, location } = await signIn('//evil.example.org/');
      expect(location).toBe('/');
      const session = await browser.send('GET', '/api/auth/session');
      // The preferred name was taken: a suffix makes it unique.
      expect(session.json()).toMatchObject({ user: { username: 'grace-2', displayName: 'Linus' } });
      const listed = (
        await admin.send('GET', '/api/admin/users?q=linus')
      ).json<AdminUsersResponse>();
      expect(listed.users[0]).toMatchObject({ hasPassword: false, oidc: true });
      // No password to guess: the account signs in at the provider only.
      expect((await login(client(), 'linus@example.org', '')).statusCode).toBe(400);
      expect((await login(client(), 'linus@example.org', 'anything-long-enough')).statusCode).toBe(
        401,
      );
      await patchSettings({ registrationMode: 'closed' });
    });

    it('refuses a callback whose state is not bound to the browser', async () => {
      claims = { sub: 'grace-at-campus', email: 'grace@example.org', email_verified: true };
      const browser = client();
      const start = await browser.send('GET', '/api/auth/oidc/start');
      const authorize = await fetch(start.headers.location ?? '', { redirect: 'manual' });
      const back = new URL(authorize.headers.get('location') ?? '');
      const forged = await client().send('GET', `${back.pathname}${back.search}`);
      expect(forged.headers.location).toBe('/login?error=OIDC_FAILED');
      expect(forged.cookies.find((cookie) => cookie.name === SESSION_COOKIE)).toBeUndefined();
    });
  });
});

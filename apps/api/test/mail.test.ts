import type { S3Client } from '@aws-sdk/client-s3';
import { passwordResets, users } from '@galley/db';
import {
  COMPILE_QUEUE,
  type CompileJob,
  type ProjectSummary,
  type ProjectTree,
} from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import { createDatabase, type Database, runMigrations } from '@galley/db';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDocumentGateway } from '../src/collab/documents.js';
import { readConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { startMailer } from '../src/mail/mailer.js';
import { createS3Client } from '../src/storage/s3.js';
import { Client } from './client.js';
import { dockerAvailable, startPostgres, startValkey } from './containers.js';
import { bodyOf, TestSmtpServer } from './smtp.js';

describe.skipIf(!dockerAvailable)('e-mail', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let database: Database;
  let redis: Redis;
  let queueRedis: Redis;
  let s3: S3Client;
  let app: FastifyInstance;
  let silentApp: FastifyInstance;
  let compileQueue: Queue<CompileJob, unknown>;
  let smtp: TestSmtpServer;
  let closeMailer: () => Promise<void>;
  let ipCounter = 0;

  async function register(target: FastifyInstance, name: string): Promise<Client> {
    const user = new Client(target, `10.4.0.${String(++ipCounter)}`);
    const response = await user.send('POST', '/api/auth/register', {
      json: {
        email: `${name}@example.org`,
        username: name,
        displayName: name.charAt(0).toUpperCase() + name.slice(1),
        password: `${name}-password-123`,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return user;
  }

  /** Token of the reset link in the latest message to `to`. */
  async function resetToken(to: string, after: number): Promise<string> {
    const mail = await smtp.waitFor(to, (message) => smtp.messages.indexOf(message) >= after);
    const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(bodyOf(mail))?.[1];
    if (token === undefined) throw new Error('no reset link');
    return token;
  }

  beforeAll(async () => {
    smtp = new TestSmtpServer();
    const smtpUrl = await smtp.start();
    [postgres, valkey] = await Promise.all([startPostgres(), startValkey()]);
    const env = {
      DATABASE_URL: postgres.getConnectionUri(),
      VALKEY_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
      // Never reached: no route under test touches object storage.
      S3_ENDPOINT: 'http://127.0.0.1:9',
      S3_ACCESS_KEY_ID: 'unused',
      S3_SECRET_ACCESS_KEY: 'unused-secret',
      S3_BUCKET: 'galley-mail',
      REGISTRATION_MODE: 'open',
      GALLEY_HOST: 'galley.test',
    };
    const config = readConfig({
      ...env,
      SMTP_URL: smtpUrl,
      SMTP_FROM: 'Galley <galley@galley.test>',
    });
    database = createDatabase(config.DATABASE_URL);
    redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
    queueRedis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: null });
    s3 = createS3Client(config);
    await runMigrations(database);
    const logger = createLogger({ service: 'api-test', level: 'silent' });
    compileQueue = new Queue(COMPILE_QUEUE, { connection: { url: config.VALKEY_URL } });
    const mail = startMailer(config, queueRedis, logger);
    if (mail === null) throw new Error('mailer not started');
    closeMailer = mail.close;
    const context: AppContext = {
      config,
      database,
      redis,
      s3,
      documents: createDocumentGateway(config, database, logger),
      compileQueue,
      synctex: () => Promise.reject(new Error('no SyncTeX in these tests')),
      mailer: mail.mailer,
    };
    app = buildApp({ logger, version: 'test', probes: {}, context });
    await app.ready();
    // The same instance without SMTP: nothing changes but the reset route.
    const silentConfig = readConfig(env);
    expect(startMailer(silentConfig, queueRedis, logger)).toBeNull();
    const withoutMail: AppContext = { ...context };
    delete withoutMail.mailer;
    silentApp = buildApp({
      logger,
      version: 'test',
      probes: {},
      context: { ...withoutMail, config: silentConfig },
    });
    await silentApp.ready();
  });

  afterAll(async () => {
    await app.close();
    await silentApp.close();
    await closeMailer();
    await compileQueue.close();
    await database.sql.end({ timeout: 5 });
    redis.disconnect();
    queueRedis.disconnect();
    s3.destroy();
    await smtp.stop();
    await Promise.all([postgres.stop(), valkey.stop()]);
  });

  it('tells the client whether e-mail is configured', async () => {
    const withMail = await new Client(app, '10.4.1.1').send('GET', '/api/auth/config');
    expect(withMail.json()).toMatchObject({ mail: true });
    const without = await new Client(silentApp, '10.4.1.2').send('GET', '/api/auth/config');
    expect(without.json()).toMatchObject({ mail: false });
    const refused = await new Client(silentApp, '10.4.1.2').send(
      'POST',
      '/api/auth/password-reset',
      { json: { email: 'someone@example.org' } },
    );
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: { code: 'MAIL_DISABLED' } });
  });

  it('resets a password through a single-use link and signs every session out', async () => {
    const ada = await register(app, 'ada');
    const visitor = new Client(app, '10.4.2.1');

    // Same answer for an unknown address: nothing tells whether an account exists.
    const unknown = await visitor.send('POST', '/api/auth/password-reset', {
      json: { email: 'nobody@example.org' },
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.body).toBe('');

    let before = smtp.messages.length;
    const first = await visitor.send('POST', '/api/auth/password-reset', {
      json: { email: 'ADA@example.org' },
    });
    expect(first.statusCode).toBe(202);
    expect(first.body).toBe('');
    const firstToken = await resetToken('ada@example.org', before);
    const mail = smtp.messages.at(-1);
    expect(mail?.from).toBe('galley@galley.test');
    expect(bodyOf(mail ?? { from: '', to: [], data: '' })).toContain(
      'https://galley.test/reset-password?token=',
    );
    expect(smtp.messages.some((message) => message.to.includes('nobody@example.org'))).toBe(false);

    // A second request replaces the first link.
    before = smtp.messages.length;
    await visitor.send('POST', '/api/auth/password-reset', { json: { email: 'ada@example.org' } });
    const token = await resetToken('ada@example.org', before);
    expect(token).not.toBe(firstToken);
    const stale = await visitor.send('POST', '/api/auth/password-reset/confirm', {
      json: { token: firstToken, password: 'new-password-456' },
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.json()).toMatchObject({ error: { code: 'RESET_TOKEN_INVALID' } });

    const [stored] = await database.db
      .select({ tokenHash: passwordResets.tokenHash })
      .from(passwordResets)
      .innerJoin(users, eq(users.id, passwordResets.userId))
      .where(eq(users.username, 'ada'));
    expect(stored?.tokenHash).not.toBe(token);

    const tooShort = await visitor.send('POST', '/api/auth/password-reset/confirm', {
      json: { token, password: 'short' },
    });
    expect(tooShort.statusCode).toBe(400);

    const done = await visitor.send('POST', '/api/auth/password-reset/confirm', {
      json: { token, password: 'new-password-456' },
    });
    expect(done.statusCode, done.body).toBe(204);

    // The old session is closed, the old password refused, the new one accepted.
    const session = await ada.send('GET', '/api/auth/session');
    expect(session.json()).toMatchObject({ user: null });
    const old = await new Client(app, '10.4.2.2').send('POST', '/api/auth/login', {
      json: { login: 'ada', password: 'ada-password-123' },
    });
    expect(old.statusCode).toBe(401);
    const login = await new Client(app, '10.4.2.3').send('POST', '/api/auth/login', {
      json: { login: 'ada', password: 'new-password-456' },
    });
    expect(login.statusCode).toBe(200);

    const reused = await visitor.send('POST', '/api/auth/password-reset/confirm', {
      json: { token, password: 'another-password-789' },
    });
    expect(reused.json()).toMatchObject({ error: { code: 'RESET_TOKEN_INVALID' } });
  });

  it('refuses an expired link', async () => {
    await register(app, 'eve');
    const before = smtp.messages.length;
    const visitor = new Client(app, '10.4.3.1');
    await visitor.send('POST', '/api/auth/password-reset', { json: { email: 'eve@example.org' } });
    const token = await resetToken('eve@example.org', before);
    await database.db.update(passwordResets).set({ expiresAt: new Date(Date.now() - 1_000) });
    const expired = await visitor.send('POST', '/api/auth/password-reset/confirm', {
      json: { token, password: 'new-password-456' },
    });
    expect(expired.json()).toMatchObject({ error: { code: 'RESET_TOKEN_INVALID' } });
  });

  it('notifies invitations and mentions, unless the person opted out of mentions', async () => {
    const owner = await register(app, 'olga');
    const reviewer = await register(app, 'remi');
    const created = await owner.send('POST', '/api/projects', { json: { name: 'Thèse' } });
    expect(created.statusCode, created.body).toBe(201);
    const projectId = created.json<{ project: ProjectSummary }>().project.id;

    const invited = await owner.send('POST', `/api/projects/${projectId}/invites`, {
      json: { identifier: 'remi', role: 'reviewer' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const invitation = await smtp.waitFor('remi@example.org');
    expect(bodyOf(invitation)).toContain('Olga vous invite à rejoindre le projet « Thèse »');
    expect(bodyOf(invitation)).toContain('https://galley.test/projects');
    const inviteId = invited.json<{ id: string }>().id;
    const accepted = await reviewer.send('POST', `/api/invites/${inviteId}/accept`);
    expect(accepted.statusCode, accepted.body).toBeLessThan(300);

    const tree = await owner.send('GET', `/api/projects/${projectId}/tree`);
    const fileId = tree.json<ProjectTree>().mainFileId;
    const thread = await owner.send('POST', `/api/projects/${projectId}/threads`, {
      json: { fileId, quote: 'Introduction', body: '@remi peux-tu relire ?' },
    });
    expect(thread.statusCode, thread.body).toBe(201);
    const mention = await smtp.waitFor('remi@example.org', (mail) =>
      bodyOf(mail).includes('mentionné'),
    );
    expect(bodyOf(mention)).toContain('@remi peux-tu relire ?');
    expect(bodyOf(mention)).toContain(`https://galley.test/projects/${projectId}`);
    const mentions = () =>
      smtp.messages.filter(
        (mail) => mail.to.includes('remi@example.org') && bodyOf(mail).includes('mentionné'),
      ).length;

    const settings = await reviewer.send('GET', '/api/me/notifications');
    expect(settings.json()).toEqual({ emailMentions: true });
    const off = await reviewer.send('PATCH', '/api/me/notifications', {
      json: { emailMentions: false },
    });
    expect(off.json()).toEqual({ emailMentions: false });

    const threadId = thread.json<{ id: string }>().id;
    const reply = await owner.send(
      'POST',
      `/api/projects/${projectId}/threads/${threadId}/comments`,
      {
        json: { body: '@remi encore une chose' },
      },
    );
    expect(reply.statusCode).toBe(201);
    // A later message to someone else proves the queue went past the reply.
    await register(app, 'zoe');
    await owner.send('POST', `/api/projects/${projectId}/invites`, {
      json: { identifier: 'zoe', role: 'reader' },
    });
    await smtp.waitFor('zoe@example.org');
    expect(mentions()).toBe(1);
    // The in-app mention is still recorded.
    const inbox = await reviewer.send('GET', '/api/mentions');
    expect(inbox.json<{ mentions: unknown[] }>().mentions).toHaveLength(2);
  });
});

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import { SESSION_COOKIE } from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_ARCHIVE_LIMITS } from '../src/archive/limits.js';
import { ensureSetupCode } from '../src/auth/setup.js';
import { readConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { projects } from '../src/db/schema.js';
import { purgeTrash } from '../src/projects/purge.js';
import { createS3Client, ensureBucket } from '../src/storage/s3.js';
import {
  dockerAvailable,
  S3_CREDENTIALS,
  startPostgres,
  startSeaweedfs,
  startValkey,
} from './containers.js';
import { buildZip, multipart, readZip } from './zip.js';

const REFERENCE_ARCHIVE = new URL(
  '../../../fixtures/archives/reference-report.zip',
  import.meta.url,
);

type Body = Record<string, unknown>;

/** A browser-like session: keeps the cookie and sends the CSRF token. */
class Client {
  private cookie: string | undefined;
  csrf: string | undefined;

  constructor(
    private readonly app: FastifyInstance,
    private readonly ip: string,
  ) {}

  async send(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    options: {
      json?: unknown;
      form?: ReturnType<typeof multipart>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...options.form?.headers, ...options.headers };
    if (this.cookie !== undefined) headers.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    if (this.csrf !== undefined && method !== 'GET') headers['x-csrf-token'] ??= this.csrf;
    const response = await this.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(options.json === undefined ? {} : { payload: options.json as Body }),
      ...(options.form === undefined ? {} : { payload: options.form.payload }),
    });
    const set = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE);
    if (set) {
      this.cookie = set.value === '' ? undefined : set.value;
      const session = await this.app.inject({
        method: 'GET',
        url: '/api/auth/session',
        headers: this.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${this.cookie}` },
      });
      this.csrf = session.json<{ csrfToken: string | null }>().csrfToken ?? undefined;
    }
    return response;
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe.skipIf(!dockerAvailable)('accounts, projects and files', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let seaweedfs: StartedTestContainer;
  let database: Database;
  let redis: Redis;
  let s3: S3Client;
  let app: FastifyInstance;
  let ipCounter = 0;
  const client = (): Client => new Client(app, `10.0.0.${String(++ipCounter)}`);

  let admin: Client;
  let alice: Client;
  let bob: Client;

  async function register(name: string): Promise<Client> {
    const invite = await admin.send('POST', '/api/admin/invites', { json: {} });
    const user = client();
    const response = await user.send('POST', '/api/auth/register', {
      json: {
        email: `${name}@example.org`,
        username: name,
        displayName: name,
        password: `${name}-password-123`,
        inviteToken: invite.json<{ token: string }>().token,
      },
    });
    expect(response.statusCode).toBe(201);
    return user;
  }

  async function importArchive(user: Client, data: Buffer, filename = 'projet.zip') {
    return user.send('POST', '/api/projects/import', {
      form: multipart([{ name: 'archive', filename, data }]),
    });
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
      S3_BUCKET: 'galley-features',
    });
    database = createDatabase(config.DATABASE_URL);
    redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
    s3 = createS3Client(config);
    await runMigrations(database);
    await ensureBucket(s3, config.S3_BUCKET);
    app = buildApp({
      logger: createLogger({ service: 'api-test', level: 'silent' }),
      version: 'test',
      probes: {},
      context: { config, database, redis, s3 },
      archiveLimits: {
        ...DEFAULT_ARCHIVE_LIMITS,
        maxEntries: 100,
        maxTotalBytes: 20 * 1024 * 1024,
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.sql.end({ timeout: 5 });
    redis.disconnect();
    s3.destroy();
    await Promise.all([postgres.stop(), valkey.stop(), seaweedfs.stop()]);
  });

  describe('first administrator', () => {
    it('requires the setup code, once', async () => {
      const config = await app.inject({ method: 'GET', url: '/api/auth/config' });
      expect(config.json()).toEqual({ registrationMode: 'invite', setupRequired: true });

      const { code } = await ensureSetupCode(redis);
      admin = client();
      const account = {
        email: 'admin@example.org',
        username: 'admin',
        displayName: 'Admin',
        password: 'admin-password-123',
      };
      const wrong = await admin.send('POST', '/api/auth/setup', {
        json: { ...account, setupCode: 'nope' },
      });
      expect(wrong.statusCode).toBe(403);

      const created = await admin.send('POST', '/api/auth/setup', {
        json: { ...account, setupCode: code },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json<{ user: { isAdmin: boolean } }>().user.isAdmin).toBe(true);
      const cookie = created.cookies.find((item) => item.name === SESSION_COOKIE);
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

      const again = await client().send('POST', '/api/auth/setup', {
        json: { ...account, email: 'x@example.org', username: 'xx', setupCode: code },
      });
      expect(again.statusCode).toBe(403);
    });
  });

  describe('registration and sessions', () => {
    it('needs a valid, unused invite', async () => {
      const body = {
        email: 'carol@example.org',
        username: 'carol',
        displayName: 'Carol',
        password: 'carol-password-123',
      };
      expect((await client().send('POST', '/api/auth/register', { json: body })).statusCode).toBe(
        403,
      );
      const invite = await admin.send('POST', '/api/admin/invites', { json: { expiresInDays: 1 } });
      expect(invite.statusCode).toBe(201);
      const inviteToken = invite.json<{ token: string }>().token;
      const first = await client().send('POST', '/api/auth/register', {
        json: { ...body, inviteToken },
      });
      expect(first.statusCode).toBe(201);
      const reuse = await client().send('POST', '/api/auth/register', {
        json: { ...body, email: 'c2@example.org', username: 'carol2', inviteToken },
      });
      expect(reuse.statusCode).toBe(403);
    });

    it('reports duplicate identities as field errors', async () => {
      const invite = await admin.send('POST', '/api/admin/invites', { json: {} });
      const response = await client().send('POST', '/api/auth/register', {
        json: {
          email: 'CAROL@example.org',
          username: 'other',
          displayName: 'Other',
          password: 'other-password-123',
          inviteToken: invite.json<{ token: string }>().token,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED', fields: [{ path: 'email' }] },
      });
    });

    it('keeps invites for administrators', async () => {
      alice = await register('alice');
      expect((await alice.send('GET', '/api/admin/invites')).statusCode).toBe(403);
    });

    it('signs in by username or e-mail and out again', async () => {
      const session = client();
      const bad = await session.send('POST', '/api/auth/login', {
        json: { login: 'alice', password: 'wrong-password' },
      });
      expect(bad.statusCode).toBe(401);
      const unknown = await session.send('POST', '/api/auth/login', {
        json: { login: 'nobody', password: 'wrong-password' },
      });
      expect(unknown.statusCode).toBe(401);
      // Same answer for an unknown account and a wrong password.
      expect(unknown.json<{ error: Body }>().error.code).toBe(
        bad.json<{ error: Body }>().error.code,
      );

      const ok = await session.send('POST', '/api/auth/login', {
        json: { login: 'ALICE@example.org', password: 'alice-password-123' },
      });
      expect(ok.statusCode).toBe(200);
      expect((await session.send('GET', '/api/projects')).statusCode).toBe(200);
      expect((await session.send('POST', '/api/auth/logout')).statusCode).toBe(204);
      expect((await session.send('GET', '/api/projects')).statusCode).toBe(401);
    });

    it('refuses state changes without the CSRF token or from another origin', async () => {
      const json = { name: 'CSRF' };
      const noToken = await alice.send('POST', '/api/projects', {
        json,
        headers: { 'x-csrf-token': 'forged' },
      });
      expect(noToken.statusCode).toBe(403);
      const foreign = await alice.send('POST', '/api/projects', {
        json,
        headers: { origin: 'https://evil.example', host: 'galley.example' },
      });
      expect(foreign.statusCode).toBe(403);
    });

    it('rate-limits sign-in attempts per address and account', async () => {
      const attacker = client();
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 11; attempt++) {
        const response = await attacker.send('POST', '/api/auth/login', {
          json: { login: 'alice', password: `guess-${String(attempt)}` },
        });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
      // Another account from the same address is still served.
      const other = await attacker.send('POST', '/api/auth/login', {
        json: { login: 'bob', password: 'guess' },
      });
      expect(other.statusCode).toBe(401);
    });
  });

  describe('projects', () => {
    it('creates, lists, archives, trashes and restores', async () => {
      const created = await alice.send('POST', '/api/projects', {
        json: { name: 'Article', template: 'article' },
      });
      expect(created.statusCode).toBe(201);
      const { id } = created.json<{ project: { id: string } }>().project;

      const tree = await alice.send('GET', `/api/projects/${id}/tree`);
      const nodes = tree.json<{ mainFileId: string; nodes: { id: string; name: string }[] }>();
      expect(nodes.nodes.map((node) => node.name).sort()).toEqual(['main.tex', 'references.bib']);
      expect(nodes.nodes.find((node) => node.id === nodes.mainFileId)?.name).toBe('main.tex');

      const names = async (state: string): Promise<string[]> =>
        (await alice.send('GET', `/api/projects?state=${state}`))
          .json<{ projects: { name: string }[] }>()
          .projects.map((project) => project.name);
      expect(await names('active')).toContain('Article');
      await alice.send('POST', `/api/projects/${id}/archive`);
      expect(await names('archived')).toEqual(['Article']);
      await alice.send('POST', `/api/projects/${id}/unarchive`);
      await alice.send('DELETE', `/api/projects/${id}`);
      expect(await names('trashed')).toEqual(['Article']);
      expect((await alice.send('GET', `/api/projects/${id}/tree`)).statusCode).toBe(404);
      await alice.send('POST', `/api/projects/${id}/restore`);
      expect(await names('active')).toContain('Article');
    });

    it('searches and filters by personal tags', async () => {
      const make = async (name: string): Promise<string> =>
        (await alice.send('POST', '/api/projects', { json: { name } })).json<{
          project: { id: string };
        }>().project.id;
      const thesis = await make('Thèse 100% finale');
      await make('Notes');
      const tag = await alice.send('POST', '/api/tags', {
        json: { name: 'Stage', color: '#336699' },
      });
      const tagId = tag.json<{ tag: { id: string } }>().tag.id;
      expect((await alice.send('PUT', `/api/projects/${thesis}/tags/${tagId}`)).statusCode).toBe(
        204,
      );

      const search = await alice.send('GET', `/api/projects?search=${encodeURIComponent('100%')}`);
      expect(search.json<{ projects: { name: string }[] }>().projects.map((p) => p.name)).toEqual([
        'Thèse 100% finale',
      ]);
      const tagged = await alice.send('GET', `/api/projects?tagId=${tagId}`);
      expect(tagged.json<{ projects: { id: string; tagIds: string[] }[] }>().projects).toEqual([
        expect.objectContaining({ id: thesis, tagIds: [tagId] }),
      ]);
      const duplicate = await alice.send('POST', '/api/tags', {
        json: { name: 'Stage', color: '#000000' },
      });
      expect(duplicate.statusCode).toBe(409);
    });

    it('purges projects trashed more than 30 days ago', async () => {
      const id = (await alice.send('POST', '/api/projects', { json: { name: 'Old' } })).json<{
        project: { id: string };
      }>().project.id;
      const recent = (
        await alice.send('POST', '/api/projects', { json: { name: 'Recent' } })
      ).json<{ project: { id: string } }>().project.id;
      await database.db
        .update(projects)
        .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
        .where(eq(projects.id, id));
      await alice.send('DELETE', `/api/projects/${recent}`);
      expect(await purgeTrash(database.db, new Date())).toBe(1);
      const left = await database.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, recent));
      expect(left).toHaveLength(1);
    });
  });

  describe('file tree', () => {
    let projectId: string;

    beforeAll(async () => {
      projectId = (await alice.send('POST', '/api/projects', { json: { name: 'Arbre' } })).json<{
        project: { id: string };
      }>().project.id;
    });

    const tree = async () =>
      (await alice.send('GET', `/api/projects/${projectId}/tree`)).json<{
        nodes: { id: string; name: string; parentId: string | null; kind: string }[];
      }>().nodes;

    it('uploads files and dropped folders', async () => {
      const response = await alice.send('POST', `/api/projects/${projectId}/files`, {
        form: multipart([
          { name: 'path', value: 'figures/plot.png' },
          { name: 'file', filename: 'plot.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]) },
          { name: 'file', filename: 'notes.txt', data: Buffer.from('hello\r\n') },
          { name: 'file', filename: 'legacy.tex', data: Buffer.from([0x63, 0xe9]) },
        ]),
      });
      expect(response.statusCode).toBe(201);
      const body = response.json<{
        nodes: { name: string; kind: string }[];
        warnings: unknown[];
      }>();
      expect(body.nodes.map((node) => `${node.name}:${node.kind}`).sort()).toEqual([
        'figures:folder',
        'legacy.tex:binary',
        'notes.txt:text',
        'plot.png:binary',
      ]);
      expect(body.warnings).toEqual([{ code: 'NOT_UTF8_TEXT', path: 'legacy.tex' }]);
    });

    it('serves content with safe headers', async () => {
      const nodes = await tree();
      const notes = nodes.find((node) => node.name === 'notes.txt');
      const text = await alice.send(
        'GET',
        `/api/projects/${projectId}/files/${notes?.id ?? ''}/content`,
      );
      expect(text.rawPayload.toString()).toBe('hello\r\n');
      expect(text.headers['content-security-policy']).toContain('sandbox');
      expect(text.headers['x-content-type-options']).toBe('nosniff');

      const plot = nodes.find((node) => node.name === 'plot.png');
      const image = await alice.send(
        'GET',
        `/api/projects/${projectId}/files/${plot?.id ?? ''}/content`,
      );
      expect(image.headers['content-type']).toBe('image/png');
      expect([...image.rawPayload]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1]);
    });

    it('renames, moves, refuses cycles and deletes', async () => {
      const folder = await alice.send('POST', `/api/projects/${projectId}/folders`, {
        json: { parentId: null, name: 'docs' },
      });
      const docsId = folder.json<{ node: { id: string } }>().node.id;
      const sub = await alice.send('POST', `/api/projects/${projectId}/folders`, {
        json: { parentId: docsId, name: 'sub' },
      });
      const subId = sub.json<{ node: { id: string } }>().node.id;
      const notes = (await tree()).find((node) => node.name === 'notes.txt');
      const notesUrl = `/api/projects/${projectId}/files/${notes?.id ?? ''}`;

      const moved = await alice.send('PATCH', notesUrl, {
        json: { parentId: subId, name: 'lisez-moi.txt' },
      });
      expect(moved.json<{ node: { parentId: string; name: string } }>().node).toMatchObject({
        parentId: subId,
        name: 'lisez-moi.txt',
      });
      const cycle = await alice.send('PATCH', `/api/projects/${projectId}/files/${docsId}`, {
        json: { parentId: subId },
      });
      expect(cycle.statusCode).toBe(400);
      const clash = await alice.send('POST', `/api/projects/${projectId}/folders`, {
        json: { parentId: null, name: 'docs' },
      });
      expect(clash.statusCode).toBe(409);
      const invalid = await alice.send('POST', `/api/projects/${projectId}/folders`, {
        json: { parentId: null, name: '..' },
      });
      expect(invalid.statusCode).toBe(400);

      expect(
        (await alice.send('DELETE', `/api/projects/${projectId}/files/${docsId}`)).statusCode,
      ).toBe(204);
      const names = (await tree()).map((node) => node.name);
      expect(names).not.toContain('sub');
      expect(names).not.toContain('lisez-moi.txt');
    });
  });

  describe('zip import and export', () => {
    let reference: Buffer;
    let projectId: string;

    beforeAll(async () => {
      reference = await readFile(REFERENCE_ARCHIVE);
    });

    it('A1: restores the tree of a real project export', async () => {
      const response = await importArchive(alice, reference, 'Rapport de projet.zip');
      expect(response.statusCode).toBe(201);
      const body = response.json<{
        project: { id: string; name: string };
        warnings: { code: string; path: string }[];
      }>();
      projectId = body.project.id;
      expect(body.project.name).toBe('Rapport de projet');
      expect(body.warnings).toEqual([
        { code: 'NOT_UTF8_TEXT', path: 'chapitres/ancien-latin1.tex' },
      ]);

      const tree = (await alice.send('GET', `/api/projects/${projectId}/tree`)).json<{
        mainFileId: string;
        nodes: { id: string; parentId: string | null; name: string; kind: string }[];
      }>();
      const byId = new Map(tree.nodes.map((node) => [node.id, node]));
      const pathOf = (node: { parentId: string | null; name: string }): string => {
        const parent = node.parentId === null ? undefined : byId.get(node.parentId);
        return parent ? `${pathOf(parent)}/${node.name}` : node.name;
      };
      const original = await readZip(reference);
      const expected = [...original.keys()].map((key) => key.replace(/\/$/, '')).sort();
      expect(tree.nodes.map(pathOf).sort()).toEqual(expected);
      expect(byId.get(tree.mainFileId)?.name).toBe('main.tex');
      const kinds = Object.fromEntries(tree.nodes.map((node) => [pathOf(node), node.kind]));
      expect(kinds).toMatchObject({
        'main.tex': 'text',
        'rapport-local.cls': 'text',
        'chapitres/ancien-latin1.tex': 'binary',
        'logos/entete.pdf': 'binary',
        annexes: 'folder',
      });
    });

    it('A2: exports the same paths and the same digests', async () => {
      const response = await alice.send('GET', `/api/projects/${projectId}/export`);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/zip');
      const exported = await readZip(response.rawPayload);
      const original = await readZip(reference);
      const digests = (entries: Map<string, Buffer | null>) =>
        Object.fromEntries([...entries].map(([path, data]) => [path, data && sha256(data)]));
      expect(digests(exported)).toEqual(digests(original));
    });

    it('A2: also holds for a private reference archive when one is provided', async () => {
      const path = process.env.GALLEY_PRIVATE_ARCHIVE;
      if (path === undefined) return;
      const archive = await readFile(path);
      const imported = await importArchive(alice, archive);
      expect(imported.statusCode).toBe(201);
      const id = imported.json<{ project: { id: string } }>().project.id;
      const exported = await alice.send('GET', `/api/projects/${id}/export`);
      const digests = (entries: Map<string, Buffer | null>) =>
        Object.fromEntries([...entries].map(([key, data]) => [key, data && sha256(data)]));
      expect(digests(await readZip(exported.rawPayload))).toEqual(digests(await readZip(archive)));
    });

    it('strips a single wrapping folder', async () => {
      const zip = buildZip([
        { name: 'mon-projet/' },
        { name: 'mon-projet/these.tex', data: Buffer.from('\\documentclass{book}\n') },
      ]);
      const response = await importArchive(alice, zip);
      const id = response.json<{ project: { id: string } }>().project.id;
      const tree = (await alice.send('GET', `/api/projects/${id}/tree`)).json<{
        mainFileId: string;
        nodes: { id: string; name: string; parentId: string | null }[];
      }>();
      expect(tree.nodes).toEqual([expect.objectContaining({ name: 'these.tex', parentId: null })]);
      expect(tree.mainFileId).toBe(tree.nodes[0]?.id);
    });

    const zeros = Buffer.alloc(8 * 1024 * 1024);
    it.each([
      ['parent traversal', [{ name: '../evil.tex', data: Buffer.from('x') }], 'UNSAFE_PATH'],
      ['nested traversal', [{ name: 'a/../../evil.tex', data: Buffer.from('x') }], 'UNSAFE_PATH'],
      ['absolute path', [{ name: '/etc/cron.d/evil', data: Buffer.from('x') }], 'UNSAFE_PATH'],
      ['drive letter', [{ name: 'C:/evil.tex', data: Buffer.from('x') }], 'UNSAFE_PATH'],
      ['backslashes', [{ name: '..\\evil.tex', data: Buffer.from('x') }], 'UNSAFE_PATH'],
      [
        'symbolic link',
        [{ name: 'link.tex', data: Buffer.from('/etc/passwd'), unixMode: 0o120777 }],
        'SYMLINK',
      ],
      [
        'zip bomb by ratio',
        [{ name: 'bomb.tex', data: zeros, deflate: true }],
        'COMPRESSION_RATIO',
      ],
      [
        'zip bomb with lying sizes',
        [{ name: 'bomb.tex', data: zeros, deflate: true, declaredSize: 10 }],
        // Refused as soon as the real bytes outgrow the announced size.
        'CORRUPT',
      ],
      [
        'zip bomb by entry count',
        Array.from({ length: 101 }, (_, index) => ({
          name: `f${String(index)}.tex`,
          data: Buffer.from('x'),
        })),
        'TOO_MANY_ENTRIES',
      ],
      [
        'duplicate paths',
        [
          { name: 'a.tex', data: Buffer.from('1') },
          { name: 'a.tex', data: Buffer.from('2') },
        ],
        'DUPLICATE_PATH',
      ],
      ['not a zip', null, 'CORRUPT'],
    ] as const)('A3: refuses %s, leaving no project behind', async (_label, entries, reason) => {
      const before = await database.db.select({ id: projects.id }).from(projects);
      const data = entries === null ? Buffer.from('not a zip at all') : buildZip(entries);
      const response = await importArchive(alice, data);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          fields: [{ path: 'archive', messageKey: `archive.${reason}` }],
        },
      });
      const after = await database.db.select({ id: projects.id }).from(projects);
      expect(after).toHaveLength(before.length);
    });
  });

  describe('isolation between users', () => {
    it("answers 404 on every route of someone else's project", async () => {
      bob = await register('bob');
      const project = await alice.send('POST', '/api/projects', { json: { name: 'Privé' } });
      const id = project.json<{ project: { id: string } }>().project.id;
      const fileId =
        (await alice.send('GET', `/api/projects/${id}/tree`)).json<{
          nodes: { id: string }[];
        }>().nodes[0]?.id ?? '';
      const tag = await bob.send('POST', '/api/tags', { json: { name: 'Bob', color: '#000000' } });
      const tagId = tag.json<{ tag: { id: string } }>().tag.id;

      const attempts: [Parameters<Client['send']>[0], string, unknown?][] = [
        ['GET', `/api/projects/${id}`],
        ['PATCH', `/api/projects/${id}`, { name: 'Volé' }],
        ['POST', `/api/projects/${id}/archive`],
        ['POST', `/api/projects/${id}/unarchive`],
        ['DELETE', `/api/projects/${id}`],
        ['POST', `/api/projects/${id}/restore`],
        ['DELETE', `/api/projects/${id}/permanent`],
        ['GET', `/api/projects/${id}/export`],
        ['GET', `/api/projects/${id}/tree`],
        ['POST', `/api/projects/${id}/folders`, { parentId: null, name: 'x' }],
        ['PATCH', `/api/projects/${id}/files/${fileId}`, { name: 'x.tex' }],
        ['DELETE', `/api/projects/${id}/files/${fileId}`],
        ['GET', `/api/projects/${id}/files/${fileId}/content`],
        ['PUT', `/api/projects/${id}/tags/${tagId}`],
        ['DELETE', `/api/projects/${id}/tags/${tagId}`],
      ];
      for (const [method, url, json] of attempts) {
        const response = await bob.send(method, url, json === undefined ? {} : { json });
        expect(`${method} ${url} → ${String(response.statusCode)}`).toBe(`${method} ${url} → 404`);
      }
      const upload = await bob.send('POST', `/api/projects/${id}/files`, {
        form: multipart([{ name: 'file', filename: 'x.tex', data: Buffer.from('x') }]),
      });
      expect(upload.statusCode).toBe(404);
      const list = await bob.send('GET', '/api/projects');
      expect(list.json<{ projects: unknown[] }>().projects).toEqual([]);
      expect((await alice.send('GET', `/api/projects/${id}`)).statusCode).toBe(200);
    });
  });
});

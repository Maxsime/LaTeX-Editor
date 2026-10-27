import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { S3Client } from '@aws-sdk/client-s3';
import { COMPILE_QUEUE, type CompileJob } from '@galley/shared';
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

const exec = promisify(execFile);

describe.skipIf(!dockerAvailable)('Git bridge', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let seaweedfs: StartedTestContainer;
  let database: Database;
  let redis: Redis;
  let s3: S3Client;
  let app: FastifyInstance;
  let compileQueue: Queue<CompileJob, unknown>;
  let scratch: string;
  let base: string;
  let ipCounter = 0;
  const client = (): Client => new Client(app, `10.1.0.${String(++ipCounter)}`);

  let alice: Client;
  let bob: Client;
  let aliceToken: string;
  let bobToken: string;
  let projectId: string;

  /** Runs the Git client with no user configuration and no prompts. */
  async function gitClient(cwd: string, ...args: string[]) {
    try {
      const { stdout, stderr } = await exec('git', args, {
        cwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: scratch,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_NAME: 'Local',
          GIT_AUTHOR_EMAIL: 'local@example.org',
          GIT_COMMITTER_NAME: 'Local',
          GIT_COMMITTER_EMAIL: 'local@example.org',
          NO_PROXY: '*',
          no_proxy: '*',
        },
      });
      return { ok: true, stdout, stderr };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      return { ok: false, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  }

  const remote = (token: string, id = projectId) =>
    `${base.replace('://', `://user:${token}@`)}/git/${id}`;

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

  async function newToken(user: Client, name: string): Promise<string> {
    const created = await user.send('POST', '/api/tokens', { json: { name } });
    expect(created.statusCode).toBe(201);
    return created.json<{ token: string }>().token;
  }

  async function currentFile(path: string): Promise<string> {
    const response = await alice.send(
      'GET',
      `/api/projects/${projectId}/history/current/content?path=${encodeURIComponent(path)}`,
    );
    return response.statusCode === 200 ? response.body : `<${String(response.statusCode)}>`;
  }

  const upload = (path: string, data: Buffer | string) =>
    alice.send('POST', `/api/projects/${projectId}/files`, {
      form: multipart([
        { name: 'path', value: path },
        { name: 'file', filename: path.split('/').at(-1) ?? path, data: Buffer.from(data) },
      ]),
    });

  beforeAll(async () => {
    [postgres, valkey, seaweedfs] = await Promise.all([
      startPostgres(),
      startValkey(),
      startSeaweedfs(),
    ]);
    scratch = await mkdtemp(join(tmpdir(), 'galley-git-'));
    const config = readConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      VALKEY_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
      S3_ENDPOINT: `http://${seaweedfs.getHost()}:${String(seaweedfs.getMappedPort(8333))}`,
      S3_ACCESS_KEY_ID: S3_CREDENTIALS.accessKeyId,
      S3_SECRET_ACCESS_KEY: S3_CREDENTIALS.secretAccessKey,
      S3_BUCKET: 'galley-git',
      GIT_DATA_DIR: join(scratch, 'repositories'),
      GIT_MAX_PUSH_MB: '1',
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
    base = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;

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
    projectId = (await alice.send('POST', '/api/projects', { json: { name: 'Dépôt' } })).json<{
      project: { id: string };
    }>().project.id;
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

  it('manages personal access tokens, shown once', async () => {
    aliceToken = await newToken(alice, 'Portable');
    expect(aliceToken).toMatch(/^glp_[A-Za-z0-9_-]{43}$/);
    const listed = (await alice.send('GET', '/api/tokens')).json<{
      tokens: { id: string; name: string; hint: string }[];
    }>().tokens;
    expect(listed).toEqual([
      expect.objectContaining({ name: 'Portable', hint: aliceToken.slice(-4) }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(aliceToken);
    const [first] = listed;
    expect((await bob.send('DELETE', `/api/tokens/${first?.id ?? ''}`)).statusCode).toBe(404);
    const spare = await newToken(alice, 'À révoquer');
    const spareId = (await alice.send('GET', '/api/tokens'))
      .json<{ tokens: { id: string; name: string }[] }>()
      .tokens.find((token) => token.name === 'À révoquer')?.id;
    expect((await alice.send('DELETE', `/api/tokens/${spareId ?? ''}`)).statusCode).toBe(204);
    const refused = await gitClient(scratch, 'ls-remote', remote(spare));
    expect(refused.ok).toBe(false);
    bobToken = await newToken(bob, 'Bob');
  });

  it('refuses clients without a valid token or membership', async () => {
    expect((await gitClient(scratch, 'ls-remote', `${base}/git/${projectId}`)).ok).toBe(false);
    expect((await gitClient(scratch, 'ls-remote', remote('glp_nope'))).ok).toBe(false);
    const stranger = await gitClient(scratch, 'ls-remote', remote(bobToken));
    expect(stranger.ok).toBe(false);
    expect(stranger.stderr).toMatch(/not found|404/i);
  });

  it('clones the current state of the project', async () => {
    await upload('main.tex', '\\documentclass{article}\nv1\n');
    await upload('figures/plot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 7]));
    await alice.send('POST', `/api/projects/${projectId}/folders`, {
      json: { parentId: null, name: 'vide' },
    });
    const clone = await gitClient(scratch, 'clone', remote(aliceToken), 'alice');
    expect(clone.ok, clone.stderr).toBe(true);
    const work = join(scratch, 'alice');
    expect(await readFile(join(work, 'main.tex'), 'utf8')).toContain('v1');
    expect(await readFile(join(work, 'figures/plot.png'))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 7]),
    );
    const log = await gitClient(work, 'log', '--format=%an|%s');
    expect(log.stdout.trim()).toBe('alice|Update from Galley');
    // No change, no new commit.
    await gitClient(work, 'pull', '--ff-only');
    expect((await gitClient(work, 'rev-list', '--count', 'HEAD')).stdout.trim()).toBe('1');
  });

  it('applies a push to the project, keeping empty folders', async () => {
    const work = join(scratch, 'alice');
    await writeFile(join(work, 'main.tex'), '\\documentclass{article}\nfrom git\n');
    await mkdir(join(work, 'chapters'));
    await writeFile(join(work, 'chapters/one.tex'), 'One\n');
    await rm(join(work, 'figures/plot.png'));
    await gitClient(work, 'add', '-A');
    await gitClient(work, 'commit', '-m', 'Local work');
    const push = await gitClient(work, 'push', 'origin', 'main');
    expect(push.ok, push.stderr).toBe(true);

    expect(await currentFile('main.tex')).toContain('from git');
    expect(await currentFile('chapters/one.tex')).toBe('One\n');
    expect(await currentFile('figures/plot.png')).toBe('<404>');
    const files = (
      await alice.send('GET', `/api/projects/${projectId}/history/current/files`)
    ).json<{ files: { path: string }[]; folders: string[] }>();
    expect(files.files.map((file) => file.path)).toEqual(['chapters/one.tex', 'main.tex']);
    expect(files.folders).toContain('vide');
    const history = (await alice.send('GET', `/api/projects/${projectId}/history`)).json<{
      snapshots: { kind: string; authors: { displayName: string }[] }[];
    }>().snapshots;
    expect(history[0]).toMatchObject({ kind: 'git', authors: [{ displayName: 'alice' }] });

    // The pushed commit is what the server now serves: nothing new to pull.
    const pull = await gitClient(work, 'pull', '--ff-only');
    expect(pull.stdout).toMatch(/up to date/i);
  });

  it('serves changes made in Galley to git pull', async () => {
    await upload('main.tex', '\\documentclass{article}\nfrom the editor\n');
    const work = join(scratch, 'alice');
    const pull = await gitClient(work, 'pull', '--ff-only');
    expect(pull.ok, pull.stderr).toBe(true);
    expect(await readFile(join(work, 'main.tex'), 'utf8')).toContain('from the editor');
  });

  it('refuses a push that is not up to date', async () => {
    const work = join(scratch, 'alice');
    await upload('main.tex', '\\documentclass{article}\nchanged meanwhile\n');
    await writeFile(join(work, 'notes.tex'), 'late\n');
    await gitClient(work, 'add', '-A');
    await gitClient(work, 'commit', '-m', 'Late');
    const push = await gitClient(work, 'push', 'origin', 'main');
    expect(push.ok).toBe(false);
    expect(push.stderr).toMatch(/fetch first|rejected/);
    expect(await currentFile('notes.tex')).toBe('<404>');
    expect(await currentFile('main.tex')).toContain('changed meanwhile');
    // After a pull, Git merges locally and the push goes through.
    expect((await gitClient(work, 'pull', '--no-rebase', '--no-edit')).ok).toBe(true);
    const again = await gitClient(work, 'push', 'origin', 'main');
    expect(again.ok, again.stderr).toBe(true);
    expect(await currentFile('notes.tex')).toBe('late\n');
  });

  it('refuses other branches, symbolic links and pushes from readers', async () => {
    const work = join(scratch, 'alice');
    await gitClient(work, 'pull', '--ff-only');
    const branch = await gitClient(work, 'push', 'origin', 'main:other');
    expect(branch.ok).toBe(false);
    expect(branch.stderr).toContain('Seule la branche main');

    await symlink('/etc/passwd', join(work, 'link'));
    await gitClient(work, 'add', '-A');
    await gitClient(work, 'commit', '-m', 'Link');
    const linked = await gitClient(work, 'push', 'origin', 'main');
    expect(linked.ok).toBe(false);
    expect(linked.stderr).toContain('Les liens symboliques ne sont pas acceptés : link');
    expect(await currentFile('link')).toBe('<404>');
    await gitClient(work, 'reset', '--hard', 'HEAD~1');

    const link = await alice.send('POST', `/api/projects/${projectId}/links`, {
      json: { role: 'reader' },
    });
    await bob.send('POST', `/api/links/${link.json<{ token: string }>().token}/join`);
    const clone = await gitClient(scratch, 'clone', remote(bobToken), 'bob');
    expect(clone.ok, clone.stderr).toBe(true);
    const bobWork = join(scratch, 'bob');
    await writeFile(join(bobWork, 'bob.tex'), 'nope\n');
    await gitClient(bobWork, 'add', '-A');
    await gitClient(bobWork, 'commit', '-m', 'Reader');
    const push = await gitClient(bobWork, 'push', 'origin', 'main');
    expect(push.ok).toBe(false);
    expect(push.stderr).toMatch(/403/);
  });

  it('refuses pushes over the size limit', async () => {
    const work = join(scratch, 'alice');
    await gitClient(work, 'pull', '--ff-only');
    // Random bytes do not compress: the pack exceeds the 1 MiB limit of these tests.
    const { randomBytes } = await import('node:crypto');
    await writeFile(join(work, 'big.bin'), randomBytes(2 * 1024 * 1024));
    await gitClient(work, 'add', '-A');
    await gitClient(work, 'commit', '-m', 'Big');
    const push = await gitClient(work, 'push', 'origin', 'main');
    expect(push.ok).toBe(false);
    expect(await currentFile('big.bin')).toBe('<404>');
  });
});

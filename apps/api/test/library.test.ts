import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  COMPILE_QUEUE,
  type CompileJob,
  type ProjectSummary,
  type ProjectTree,
  type TemplateSummary,
  type TreeNode,
} from '@galley/shared';
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
import { createLinkFetcher } from '../src/links/fetch.js';
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

describe.skipIf(!dockerAvailable)('duplication, templates, texmf and linked files', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let seaweedfs: StartedTestContainer;
  let database: Database;
  let redis: Redis;
  let s3: S3Client;
  let app: FastifyInstance;
  let compileQueue: Queue<CompileJob, unknown>;
  let server: Server;
  let origin: string;
  /** What the local web server answers for `/source.bib`. */
  let served = '@misc{first, title={First}}';

  let admin: Client;
  let alice: Client;
  let bob: Client;
  let ipCounter = 0;

  async function register(name: string): Promise<Client> {
    const user = new Client(app, `10.2.0.${String(++ipCounter)}`);
    const response = await user.send('POST', '/api/auth/register', {
      json: {
        email: `${name}@example.org`,
        username: name,
        displayName: name,
        password: `${name}-password-123`,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return user;
  }

  async function createProject(user: Client, body: Record<string, unknown>): Promise<string> {
    const response = await user.send('POST', '/api/projects', { json: body });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ project: ProjectSummary }>().project.id;
  }

  async function tree(user: Client, projectId: string): Promise<ProjectTree> {
    const response = await user.send('GET', `/api/projects/${projectId}/tree`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ProjectTree>();
  }

  function nodeNamed(state: ProjectTree, name: string): TreeNode {
    const node = state.nodes.find((entry) => entry.name === name);
    if (!node) throw new Error(`no ${name}`);
    return node;
  }

  async function content(user: Client, projectId: string, fileId: string): Promise<string> {
    const response = await user.send('GET', `/api/projects/${projectId}/files/${fileId}/content`);
    expect(response.statusCode, response.body).toBe(200);
    return response.body;
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/source.bib') response.end(served);
      else if (request.url === '/logo.png') response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
      else {
        response.writeHead(404);
        response.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

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
      S3_BUCKET: 'galley-library',
      REGISTRATION_MODE: 'open',
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
      // The local test server stands for the web; the address policy is tested on its own.
      linkFetcher: createLinkFetcher((address) => address === '127.0.0.1'),
    };
    app = buildApp({ logger, version: 'test', probes: {}, context });
    await app.ready();

    const { code } = await ensureSetupCode(redis);
    admin = new Client(app, '10.2.1.1');
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
    alice = await register('alice');
    bob = await register('bob');
  });

  afterAll(async () => {
    await app.close();
    await compileQueue.close();
    await database.sql.end({ timeout: 5 });
    redis.disconnect();
    s3.destroy();
    server.close();
    await Promise.all([postgres.stop(), valkey.stop(), seaweedfs.stop()]);
  });

  describe('duplication and copies', () => {
    it('duplicates a project with its files, main file and settings', async () => {
      const source = await createProject(alice, { name: 'Thèse', template: 'report' });
      await alice.send('PATCH', `/api/projects/${source}`, { json: { engine: 'xelatex' } });
      const response = await alice.send('POST', `/api/projects/${source}/duplicate`, {
        json: { name: 'Thèse (copie)' },
      });
      expect(response.statusCode, response.body).toBe(201);
      const copy = response.json<{ project: ProjectSummary }>().project;
      expect(copy).toMatchObject({ name: 'Thèse (copie)', role: 'owner' });

      const original = await tree(alice, source);
      const duplicated = await tree(alice, copy.id);
      const shape = (state: ProjectTree) =>
        state.nodes.map((node) => `${node.kind}:${node.name}:${String(node.size)}`).sort();
      expect(shape(duplicated)).toEqual(shape(original));
      expect(duplicated.mainFileId).toBe(nodeNamed(duplicated, 'main.tex').id);
      const details = await alice.send('GET', `/api/projects/${copy.id}`);
      expect(details.json()).toMatchObject({ engine: 'xelatex' });
      expect(await content(alice, copy.id, nodeNamed(duplicated, 'introduction.tex').id)).toContain(
        '\\chapter{Introduction}',
      );
    });

    it('hides the source from people who cannot read it', async () => {
      const source = await createProject(alice, { name: 'Privé' });
      const refused = await bob.send('POST', `/api/projects/${source}/duplicate`, {
        json: { name: 'Vol' },
      });
      expect(refused.statusCode).toBe(404);
    });

    it('copies files and folders from another project, never over an existing name', async () => {
      const source = await createProject(alice, { name: 'Source', template: 'report' });
      const target = await createProject(alice, { name: 'Cible', template: 'article' });
      const chapters = nodeNamed(await tree(alice, source), 'chapters');
      const copy = () =>
        alice.send('POST', `/api/projects/${target}/files/copy`, {
          json: { sourceProjectId: source, fileIds: [chapters.id], targetFolderId: null },
        });
      expect((await copy()).statusCode).toBe(204);
      const copied = await tree(alice, target);
      const introduction = nodeNamed(copied, 'introduction.tex');
      expect(introduction.parentId).toBe(nodeNamed(copied, 'chapters').id);
      expect(await content(alice, target, introduction.id)).toContain('Introduction');
      expect((await copy()).statusCode).toBe(409);

      const bobsTarget = await createProject(bob, { name: 'Bob' });
      const refused = await bob.send('POST', `/api/projects/${bobsTarget}/files/copy`, {
        json: { sourceProjectId: source, fileIds: [chapters.id], targetFolderId: null },
      });
      expect(refused.statusCode).toBe(404);
    });
  });

  describe('templates', () => {
    it('saves a project as a personal template and creates projects from it', async () => {
      const source = await createProject(alice, { name: 'Modèle', template: 'article' });
      const saved = await alice.send('POST', `/api/projects/${source}/template`, {
        json: { name: 'Article du labo', description: 'Gabarit commun' },
      });
      expect(saved.statusCode, saved.body).toBe(201);
      const templateId = saved.json<{ id: string }>().id;

      const listed = (await alice.send('GET', '/api/templates')).json<{
        templates: TemplateSummary[];
      }>();
      expect(listed.templates).toContainEqual(
        expect.objectContaining({ id: templateId, mine: true, files: 2, visibility: 'private' }),
      );
      const created = await createProject(alice, { name: 'Nouveau', templateId });
      const state = await tree(alice, created);
      expect(state.nodes.map((node) => node.name).sort()).toEqual(['main.tex', 'references.bib']);
      expect(state.mainFileId).toBe(nodeNamed(state, 'main.tex').id);

      // Private to Alice: Bob neither lists nor uses it.
      const bobsList = (await bob.send('GET', '/api/templates')).json<{
        templates: TemplateSummary[];
      }>();
      expect(bobsList.templates.map((template) => template.id)).not.toContain(templateId);
      const refused = await bob.send('POST', '/api/projects', {
        json: { name: 'Copie', templateId },
      });
      expect(refused.statusCode).toBe(404);
    });

    it('lets administrators only publish templates for the whole instance', async () => {
      const source = await createProject(alice, { name: 'Public' });
      const refused = await alice.send('POST', `/api/projects/${source}/template`, {
        json: { name: 'Pour tous', visibility: 'instance' },
      });
      expect(refused.statusCode).toBe(403);

      const adminProject = await createProject(admin, { name: 'Charte', template: 'beamer' });
      const published = await admin.send('POST', `/api/projects/${adminProject}/template`, {
        json: { name: 'Charte graphique', visibility: 'instance' },
      });
      const templateId = published.json<{ id: string }>().id;
      const bobsList = (await bob.send('GET', '/api/templates')).json<{
        templates: TemplateSummary[];
      }>();
      expect(bobsList.templates).toContainEqual(
        expect.objectContaining({ id: templateId, mine: false, ownerName: 'Root' }),
      );
      await createProject(bob, { name: 'Soutenance', templateId });
      expect((await bob.send('DELETE', `/api/templates/${templateId}`)).statusCode).toBe(403);
      expect((await admin.send('DELETE', `/api/templates/${templateId}`)).statusCode).toBe(204);
    });
  });

  describe('personal texmf', () => {
    it('is one project per person, outside the dashboard, compiled with every project', async () => {
      const first = (await alice.send('GET', '/api/me/texmf')).json<{ projectId: string }>();
      const again = (await alice.send('GET', '/api/me/texmf')).json<{ projectId: string }>();
      expect(again.projectId).toBe(first.projectId);
      const texmf = first.projectId;

      const listed = (await alice.send('GET', '/api/projects')).json<{
        projects: ProjectSummary[];
      }>();
      expect(listed.projects.map((project) => project.id)).not.toContain(texmf);

      const uploaded = await alice.send('POST', `/api/projects/${texmf}/files`, {
        form: multipart([
          { name: 'path', value: 'tex/latex/lab/lab.sty' },
          { name: 'file', filename: 'lab.sty', data: Buffer.from('\\ProvidesPackage{lab}\n') },
        ]),
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);

      const compiled = await alice.send('POST', `/api/projects/${texmf}/compile`, { json: {} });
      expect(compiled.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
      const invite = await alice.send('POST', `/api/projects/${texmf}/invites`, {
        json: { identifier: 'bob', role: 'editor' },
      });
      expect(invite.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });

      // Bob compiles Alice's project: the owner's tree counts.
      const project = await createProject(alice, { name: 'Avec texmf' });
      const link = await alice.send('POST', `/api/projects/${project}/links`, {
        json: { role: 'editor' },
      });
      const token = link.json<{ token: string }>().token;
      expect((await bob.send('POST', `/api/links/${token}/join`)).statusCode).toBe(200);
      const queued = await bob.send('POST', `/api/projects/${project}/compile`, { json: {} });
      expect(queued.statusCode, queued.body).toBe(202);
      const job = await compileQueue.getJob(queued.json<{ id: string }>().id);
      expect(Object.keys(job?.data.texmfManifest ?? {})).toEqual(['tex/latex/lab/lab.sty']);
    });
  });

  describe('linked files', () => {
    it('links a file to a URL, refreshes it on request and keeps it read-only', async () => {
      const project = await createProject(alice, { name: 'Liens' });
      const created = await alice.send('POST', `/api/projects/${project}/files/link`, {
        json: {
          parentId: null,
          name: 'shared.bib',
          link: { kind: 'url', url: `${origin}/source.bib` },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const node = created.json<{ node: TreeNode }>().node;
      expect(node).toMatchObject({
        kind: 'text',
        link: { source: { kind: 'url' }, label: `${origin}/source.bib` },
      });
      expect(await content(alice, project, node.id)).toBe(served);

      served = '@misc{second, title={Second}}';
      const refreshed = await alice.send(
        'POST',
        `/api/projects/${project}/files/${node.id}/refresh`,
      );
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(await content(alice, project, node.id)).toBe(served);

      const binary = await alice.send('POST', `/api/projects/${project}/files/link`, {
        json: {
          parentId: null,
          name: 'logo.png',
          link: { kind: 'url', url: `${origin}/logo.png` },
        },
      });
      expect(binary.json<{ node: TreeNode }>().node.kind).toBe('binary');

      const taken = await alice.send('POST', `/api/projects/${project}/files/link`, {
        json: {
          parentId: null,
          name: 'shared.bib',
          link: { kind: 'url', url: `${origin}/source.bib` },
        },
      });
      expect(taken.statusCode).toBe(409);
      const missing = await alice.send('POST', `/api/projects/${project}/files/link`, {
        json: { parentId: null, name: 'gone.bib', link: { kind: 'url', url: `${origin}/gone` } },
      });
      expect(missing.json()).toMatchObject({ error: { code: 'LINK_FETCH_FAILED' } });

      const unlinked = await alice.send('POST', `/api/projects/${project}/files/${node.id}/unlink`);
      expect(unlinked.json<{ node: TreeNode }>().node.link).toBeUndefined();
    });

    it('refuses addresses outside the public network', async () => {
      const project = await createProject(alice, { name: 'Interne' });
      const response = await alice.send('POST', `/api/projects/${project}/files/link`, {
        json: {
          parentId: null,
          name: 'meta.txt',
          link: { kind: 'url', url: 'http://169.254.169.254/latest/meta-data' },
        },
      });
      expect(response.json()).toMatchObject({ error: { code: 'LINK_ADDRESS_REFUSED' } });
    });

    it('links a file of another project, with the reader’s rights checked at each refresh', async () => {
      const source = await createProject(alice, { name: 'Bibliothèque', template: 'article' });
      const bib = nodeNamed(await tree(alice, source), 'references.bib');
      const target = await createProject(bob, { name: 'Article de Bob' });
      const link = { kind: 'project', projectId: source, fileId: bib.id };
      const refused = await bob.send('POST', `/api/projects/${target}/files/link`, {
        json: { parentId: null, name: 'refs.bib', link },
      });
      expect(refused.statusCode).toBe(404);

      const share = await alice.send('POST', `/api/projects/${source}/links`, {
        json: { role: 'reader' },
      });
      await bob.send('POST', `/api/links/${share.json<{ token: string }>().token}/join`);
      const created = await bob.send('POST', `/api/projects/${target}/files/link`, {
        json: { parentId: null, name: 'refs.bib', link },
      });
      expect(created.statusCode, created.body).toBe(201);
      const node = created.json<{ node: TreeNode }>().node;
      expect(node.link?.label).toBe('Bibliothèque › references.bib');
      expect(await content(bob, target, node.id)).toContain('knuth1984');
    });
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { relative } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { createDatabase, type Database, runMigrations, zoteroAccounts } from '@galley/db';
import { detectLanguage, proseRanges, splitParagraphs, toAnnotation } from '@galley/latex-index';
import {
  COMPILE_QUEUE,
  type CompileJob,
  type LookupResponse,
  type SpellingResponse,
} from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDocumentGateway } from '../src/collab/documents.js';
import { readConfig } from '../src/config.js';
import { createS3Client, ensureBucket } from '../src/storage/s3.js';
import { Client } from './client.js';
import {
  dockerAvailable,
  S3_CREDENTIALS,
  startLanguageTool,
  startPostgres,
  startSeaweedfs,
  startValkey,
} from './containers.js';
import { multipart } from './zip.js';

const FIXTURES = new URL('./fixtures/lookup/', import.meta.url);
const CORPUS = new URL('../../../fixtures/projects/', import.meta.url);
const ZOTERO_KEY = 'Zk3pQ9rT5vX7yA1bC2dE4fG6';
const ZOTERO_USER = '475425';

const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');

/** Plays Crossref, arXiv, Open Library and Zotero from the recorded answers. */
function startServices(): Promise<{ server: Server; base: string; zoteroKeys: string[] }> {
  const zoteroKeys: string[] = [];
  const send = (
    response: ServerResponse,
    status: number,
    body: string,
    type = 'application/json',
  ) => {
    response.writeHead(status, { 'content-type': type });
    response.end(body);
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    const path = url.pathname;
    if (path === '/crossref/works/10.1093/comjnl/27.2.97') {
      send(response, 200, fixture('crossref-10.1093_comjnl_27.2.97.json'));
    } else if (path.startsWith('/crossref/works/')) {
      send(response, 404, 'Resource not found.', 'text/plain');
    } else if (path === '/arxiv/api/query') {
      const known = url.searchParams.get('id_list') === '1706.03762';
      send(
        response,
        200,
        fixture(known ? 'arxiv-1706.03762.xml' : 'arxiv-missing.xml'),
        'application/atom+xml',
      );
    } else if (path === '/openlibrary/api/books') {
      const known = url.searchParams.get('bibkeys') === 'ISBN:9780201134476';
      send(response, 200, known ? fixture('openlibrary-9780201134476.json') : '{}');
    } else if (path.startsWith('/zotero/')) {
      const key = request.headers['zotero-api-key'];
      zoteroKeys.push(typeof key === 'string' ? key : '');
      if (key !== ZOTERO_KEY) {
        send(response, 403, 'Forbidden', 'text/plain');
      } else if (path === '/zotero/keys/current') {
        send(
          response,
          200,
          JSON.stringify({ key: ZOTERO_KEY, userID: Number(ZOTERO_USER), username: 'maxime' }),
        );
      } else if (path === `/zotero/users/${ZOTERO_USER}/items/top`) {
        send(
          response,
          200,
          JSON.stringify([
            {
              key: 'ABCD2345',
              data: {
                itemType: 'journalArticle',
                title: 'Literate Programming',
                creators: [{ creatorType: 'author', firstName: 'Donald E.', lastName: 'Knuth' }],
                date: '1984',
              },
            },
          ]),
        );
      } else if (path === `/zotero/users/${ZOTERO_USER}/items`) {
        expect(url.searchParams.get('format')).toBe('biblatex');
        send(
          response,
          200,
          '\n@article{knuthLiterateProgramming1984,\n\ttitle = {Literate {Programming}},\n\tvolume = {27},\n\tjournaltitle = {The Computer Journal},\n\tauthor = {Knuth, Donald E.},\n\tdate = {1984},\n}\n',
          'text/plain',
        );
      } else {
        send(response, 404, 'Not found', 'text/plain');
      }
    } else {
      send(response, 404, 'Not found', 'text/plain');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo; // listen() on a TCP port always gives an AddressInfo.
      resolve({ server, base: `http://127.0.0.1:${String(port)}`, zoteroKeys });
    });
  });
}

/** Every `.tex` file of the compilation corpus. */
function corpusFiles(dir: URL = CORPUS): URL[] {
  return readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) return corpusFiles(new URL(`${name}/`, dir));
    return name.endsWith('.tex') ? [url] : [];
  });
}

describe.skipIf(!dockerAvailable)('bibliography and writing quality', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let seaweedfs: StartedTestContainer;
  let languagetool: StartedTestContainer;
  let services: Awaited<ReturnType<typeof startServices>>;
  let database: Database;
  let redis: Redis;
  let s3: S3Client;
  let compileQueue: Queue<CompileJob, unknown>;
  let app: FastifyInstance;
  let ip = 0;
  let projectId: string;

  async function register(name: string): Promise<Client> {
    const user = new Client(app, `10.1.0.${String(++ip)}`);
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

  let alice: Client;

  beforeAll(async () => {
    [postgres, valkey, seaweedfs, languagetool, services] = await Promise.all([
      startPostgres(),
      startValkey(),
      startSeaweedfs(),
      startLanguageTool(),
      startServices(),
    ]);
    const config = readConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      VALKEY_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
      S3_ENDPOINT: `http://${seaweedfs.getHost()}:${String(seaweedfs.getMappedPort(8333))}`,
      S3_ACCESS_KEY_ID: S3_CREDENTIALS.accessKeyId,
      S3_SECRET_ACCESS_KEY: S3_CREDENTIALS.secretAccessKey,
      S3_BUCKET: 'galley-writing',
      REGISTRATION_MODE: 'open',
      GALLEY_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
      LANGUAGETOOL_URL: `http://${languagetool.getHost()}:${String(languagetool.getMappedPort(8010))}`,
      CROSSREF_URL: `${services.base}/crossref`,
      ARXIV_URL: `${services.base}/arxiv`,
      OPENLIBRARY_URL: `${services.base}/openlibrary`,
      ZOTERO_URL: `${services.base}/zotero`,
    });
    database = createDatabase(config.DATABASE_URL);
    redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
    s3 = createS3Client(config);
    await runMigrations(database);
    await ensureBucket(s3, config.S3_BUCKET);
    const logger = createLogger({ service: 'api-test', level: 'silent' });
    compileQueue = new Queue(COMPILE_QUEUE, { connection: { url: config.VALKEY_URL } });
    app = buildApp({
      logger,
      version: 'test',
      probes: {},
      context: {
        config,
        database,
        redis,
        s3,
        documents: createDocumentGateway(config, database, logger),
        compileQueue,
        synctex: () => Promise.reject(new Error('no SyncTeX in these tests')),
      },
    });
    await app.ready();

    alice = await register('alice');
    projectId = (await alice.send('POST', '/api/projects', { json: { name: 'Mémoire' } })).json<{
      project: { id: string };
    }>().project.id;
    const upload = await alice.send('POST', `/api/projects/${projectId}/files`, {
      form: multipart([
        {
          name: 'file',
          filename: 'main.tex',
          data: Buffer.from(
            '\\documentclass{article}\n\\usepackage[french]{babel}\n\\begin{document}\nTexte.\n\\end{document}\n',
          ),
        },
        {
          name: 'file',
          filename: 'refs.bib',
          data: Buffer.from('@book{knuth1984literate, title = {Déjà là}, year = 1984}\n'),
        },
      ]),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const main = upload
      .json<{ nodes: { id: string; name: string }[] }>()
      .nodes.find((node) => node.name === 'main.tex');
    await alice.send('PATCH', `/api/projects/${projectId}`, { json: { mainFileId: main?.id } });
  }, 240_000);

  afterAll(async () => {
    await app.close();
    await compileQueue.close();
    await database.sql.end({ timeout: 5 });
    redis.disconnect();
    s3.destroy();
    services.server.close();
    await Promise.all([postgres.stop(), valkey.stop(), seaweedfs.stop(), languagetool.stop()]);
  });

  const lookup = (client: Client, source: string, query: string, keepKeys = false) =>
    client.send('POST', `/api/projects/${projectId}/bibliography/lookup`, {
      json: { source, query, keepKeys },
    });

  it('announces the services this instance offers', async () => {
    const response = await alice.send('GET', '/api/writing/features');
    expect(response.json()).toEqual({ spelling: true, zotero: true });
  });

  describe('import', () => {
    it('imports a DOI under a key free in the project', async () => {
      const response = await lookup(alice, 'doi', 'https://doi.org/10.1093/comjnl/27.2.97');
      expect(response.statusCode, response.body).toBe(200);
      const [entry] = response.json<LookupResponse>().entries;
      // knuth1984literate is taken by refs.bib.
      expect(entry?.key).toBe('knuth1984literatea');
      expect(entry?.bibtex).toContain('journal = {The Computer Journal}');
    });

    it('imports arXiv identifiers and ISBNs', async () => {
      const arxiv = (await lookup(alice, 'arxiv', 'arXiv:1706.03762')).json<LookupResponse>();
      expect(arxiv.entries[0]?.key).toBe('vaswani2017attention');
      const isbn = (await lookup(alice, 'isbn', '978-0-201-13447-6')).json<LookupResponse>();
      expect(isbn.entries[0]?.key).toBe('knuth1984texbook');
    });

    it('re-keys pasted BibTeX after the project motif', async () => {
      await alice.send('PATCH', `/api/projects/${projectId}`, {
        json: { citeKeyPattern: '[auth]_[year]' },
      });
      const response = await lookup(
        alice,
        'bibtex',
        '@misc{x, author = {Ada Lovelace}, year = 1843}',
      );
      expect(response.json<LookupResponse>().entries[0]?.key).toBe('Lovelace_1843');
      const bad = await alice.send('PATCH', `/api/projects/${projectId}`, {
        json: { citeKeyPattern: '[journal]' },
      });
      expect(bad.statusCode).toBe(400);
      await alice.send('PATCH', `/api/projects/${projectId}`, {
        json: { citeKeyPattern: '[auth:lower][year][shorttitle:lower]' },
      });
    });

    it('reports unknown and malformed identifiers', async () => {
      const unknown = await lookup(alice, 'doi', '10.9999/nothing');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json<{ error: { code: string } }>().error.code).toBe('REFERENCE_NOT_FOUND');
      expect((await lookup(alice, 'arxiv', '9999.99999')).statusCode).toBe(404);
      const malformed = await lookup(alice, 'isbn', '1234');
      expect(malformed.json<{ error: { code: string } }>().error.code).toBe('IDENTIFIER_INVALID');
    });

    it('is reserved to the project members', async () => {
      const mallory = await register('mallory');
      expect((await lookup(mallory, 'doi', '10.1093/comjnl/27.2.97')).statusCode).toBe(404);
    });
  });

  describe('Zotero', () => {
    it('refuses a key Zotero does not know', async () => {
      const response = await alice.send('PUT', '/api/zotero', { json: { apiKey: 'A'.repeat(24) } });
      expect(response.json<{ error: { code: string } }>().error.code).toBe('IDENTIFIER_INVALID');
    });

    it('stores the key encrypted and never returns it', async () => {
      const connected = await alice.send('PUT', '/api/zotero', { json: { apiKey: ZOTERO_KEY } });
      expect(connected.statusCode, connected.body).toBe(200);
      expect(connected.json()).toEqual({ connected: true, username: 'maxime', keyHint: '4fG6' });
      const account = await alice.send('GET', '/api/zotero');
      expect(account.body).not.toContain(ZOTERO_KEY);
      const [row] = await database.db.select().from(zoteroAccounts);
      expect(Buffer.from(row?.apiKeyCiphertext ?? []).includes(Buffer.from(ZOTERO_KEY))).toBe(
        false,
      );
    });

    it('searches the library and imports items under project keys', async () => {
      const items = await alice.send('GET', '/api/zotero/items?q=literate');
      expect(items.json<{ items: { key: string; title: string }[] }>().items).toEqual([
        expect.objectContaining({ key: 'ABCD2345', title: 'Literate Programming', year: '1984' }),
      ]);
      const imported = await alice.send('POST', `/api/projects/${projectId}/zotero/import`, {
        json: { itemKeys: ['ABCD2345'] },
      });
      const [entry] = imported.json<LookupResponse>().entries;
      expect(entry?.key).toBe('knuth1984literatea');
      expect(entry?.bibtex).toMatch(
        /^@article\{knuth1984literatea,\n\ttitle = \{Literate \{Programming\}\}/,
      );
      expect(services.zoteroKeys.at(-1)).toBe(ZOTERO_KEY);
    });

    it('forgets the account on request', async () => {
      await alice.send('DELETE', '/api/zotero');
      expect((await alice.send('GET', '/api/zotero')).json()).toEqual({
        connected: false,
        username: null,
        keyHint: null,
      });
      expect((await alice.send('GET', '/api/zotero/items')).statusCode).toBe(404);
    });
  });

  describe('LanguageTool', () => {
    const check = (client: Client, source: string, language?: string) =>
      client.send('POST', `/api/projects/${projectId}/spelling`, {
        json: { annotation: toAnnotation(source), ...(language === undefined ? {} : { language }) },
      });

    it('detects a deliberate French mistake, in the language of the document', async () => {
      const source = '\\section{Vacances}\nJe suis allé à la plage hier et il fesait très beau.\n';
      const response = await check(alice, source);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<SpellingResponse>();
      expect(body.language).toBe('fr');
      const words = body.matches.map((match) =>
        source.slice(match.offset, match.offset + match.length),
      );
      expect(words).toContain('fesait');
    });

    it('leaves out the words of the personal dictionary', async () => {
      await alice.send('POST', '/api/me/dictionary', { json: { word: 'fesait' } });
      const source = 'Il fesait beau.';
      const words = (await check(alice, source))
        .json<SpellingResponse>()
        .matches.map((match) => source.slice(match.offset, match.offset + match.length));
      expect(words).not.toContain('fesait');
      const removed = await alice.send('DELETE', '/api/me/dictionary?word=fesait');
      expect(removed.json()).toEqual({ words: [] });
    });

    it('reports nothing on the LaTeX markup of the corpus', async () => {
      const checker = await register('corpus');
      // Its own project: the corpus check is the reader's request, in each file's language.
      const id = (await checker.send('POST', '/api/projects', { json: { name: 'Corpus' } })).json<{
        project: { id: string };
      }>().project.id;
      const files = corpusFiles();
      expect(files.length).toBeGreaterThan(20);
      const onMarkup: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        const segments = toAnnotation(source);
        if (splitParagraphs(segments).length === 0) continue;
        const prose = proseRanges(segments);
        const inProse = (offset: number) =>
          prose.some(([from, to]) => offset >= from && offset < to);
        const response = await checker.send('POST', `/api/projects/${id}/spelling`, {
          json: { annotation: segments, language: detectLanguage(source) ?? 'en-US' },
        });
        expect(response.statusCode, `${file.pathname}: ${response.body}`).toBe(200);
        for (const match of response.json<SpellingResponse>().matches) {
          const last = match.offset + Math.max(match.length, 1) - 1;
          if (inProse(match.offset) && inProse(last)) continue;
          const flagged = source.slice(match.offset, match.offset + match.length);
          onMarkup.push(`${relative(CORPUS.pathname, file.pathname)} ${match.ruleId} «${flagged}»`);
        }
      }
      expect(onMarkup).toEqual([]);
    }, 180_000);
  });
});

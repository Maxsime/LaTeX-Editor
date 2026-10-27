import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  createDatabase,
  type Database,
  files,
  projectActivity,
  projectMembers,
  projects,
  runMigrations,
  sessions,
  tokenDigest,
  users,
  yjsStates,
} from '@galley/db';
import {
  COLLAB_TOKEN_HEADER,
  fileDocumentName,
  healthResponse,
  projectChannel,
  presenceUserOf,
  projectDocumentName,
  type ProjectRole,
  SESSION_COOKIE,
  TEXT_KEY,
} from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { type Collab, createCollab, MAX_MESSAGE_BYTES } from '../src/collab.js';
import { readConfig } from '../src/config.js';

// Keep in sync with compose.yaml.
const POSTGRES_IMAGE = 'postgres:16.15-alpine';
const VALKEY_IMAGE = 'valkey/valkey:8.1.10-alpine';
const dockerAvailable =
  Boolean(process.env.DOCKER_HOST) || existsSync('/var/run/docker.sock') || Boolean(process.env.CI);

const INTERNAL_TOKEN = 'internal-token-for-tests-0123456789abcdef';

function stateOf(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText(TEXT_KEY).insert(0, content);
  return Y.encodeStateAsUpdate(doc);
}

function textOf(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText(TEXT_KEY).toJSON();
}

/** Polls until `check` stops throwing, for effects that land after a debounce. */
async function eventually(check: () => Promise<void> | void, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe.skipIf(!dockerAvailable)('collab server', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let database: Database;
  let redis: Redis;
  let collab: Collab;
  let host = '';
  const providers: HocuspocusProvider[] = [];
  const sockets: HocuspocusProviderWebsocket[] = [];

  /** Creates a user with a live session and returns the cookie token. */
  async function signedInUser(): Promise<{ id: string; token: string; displayName: string }> {
    const suffix = randomUUID().slice(0, 8);
    const [user] = await database.db
      .insert(users)
      .values({
        email: `${suffix}@example.test`,
        username: `user-${suffix}`,
        displayName: suffix,
        passwordHash: 'unused',
      })
      .returning({ id: users.id });
    if (!user) throw new Error('user not created');
    const token = randomBytes(32).toString('base64url');
    await database.db.insert(sessions).values({
      userId: user.id,
      tokenHash: tokenDigest(token),
      csrfToken: 'csrf',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { id: user.id, token, displayName: suffix };
  }

  /** A project owned by a fresh user, with one text file and optional extra members. */
  async function projectWithFile(
    content: string,
    members: ProjectRole[] = [],
  ): Promise<{
    projectId: string;
    fileId: string;
    owner: { id: string; token: string; displayName: string };
    others: { id: string; token: string; displayName: string }[];
  }> {
    const owner = await signedInUser();
    const [project] = await database.db
      .insert(projects)
      .values({ ownerId: owner.id, name: 'p' })
      .returning({ id: projects.id });
    if (!project) throw new Error('project not created');
    await database.db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: owner.id, role: 'owner' });
    const others = [];
    for (const role of members) {
      const member = await signedInUser();
      await database.db
        .insert(projectMembers)
        .values({ projectId: project.id, userId: member.id, role });
      others.push(member);
    }
    const [file] = await database.db
      .insert(files)
      .values({ projectId: project.id, name: 'main.tex', kind: 'text', size: content.length })
      .returning({ id: files.id });
    if (!file) throw new Error('file not created');
    await database.db.insert(yjsStates).values({ fileId: file.id, state: stateOf(content) });
    return { projectId: project.id, fileId: file.id, owner, others };
  }

  /** A WebSocket class sending the headers a browser would: Origin and the session cookie. */
  function socketClass(headers: Record<string, string>): unknown {
    return class extends WebSocket {
      constructor(address: string | URL) {
        super(address, { headers });
      }
    };
  }

  function connect(
    name: string,
    token: string | null,
    callbacks: Partial<ConstructorParameters<typeof HocuspocusProvider>[0]> = {},
  ): HocuspocusProvider {
    const headers: Record<string, string> = { origin: `http://${host}` };
    if (token !== null) headers.cookie = `${SESSION_COOKIE}=${token}`;
    const websocketProvider = new HocuspocusProviderWebsocket({
      url: `ws://${host}`,
      WebSocketPolyfill: socketClass(headers),
      // Refusals must surface once, not loop through reconnection attempts.
      maxAttempts: 1,
    });
    sockets.push(websocketProvider);
    const provider = new HocuspocusProvider({
      ...callbacks,
      name,
      document: new Y.Doc(),
      websocketProvider,
    });
    // An explicit websocket provider needs an explicit attach.
    provider.attach();
    providers.push(provider);
    return provider;
  }

  function synced(name: string, token: string): Promise<HocuspocusProvider> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no sync for ${name}`));
      }, 10_000);
      const provider = connect(name, token, {
        onSynced: () => {
          clearTimeout(timer);
          resolve(provider);
        },
        onAuthenticationFailed: ({ reason }) => {
          clearTimeout(timer);
          reject(new Error(`refused: ${reason}`));
        },
      });
    });
  }

  function refusal(name: string, token: string | null): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('no authentication response'));
      }, 10_000);
      const provider = connect(name, token, {
        onAuthenticationFailed: ({ reason }) => {
          clearTimeout(timer);
          provider.destroy();
          resolve(reason);
        },
        onSynced: () => {
          clearTimeout(timer);
          reject(new Error('document synced without access'));
        },
      });
    });
  }

  async function storedText(fileId: string): Promise<string | undefined> {
    const [row] = await database.db
      .select({ state: yjsStates.state })
      .from(yjsStates)
      .where(eq(yjsStates.fileId, fileId));
    return row ? textOf(row.state) : undefined;
  }

  function internal(path: string, body?: object, token = INTERNAL_TOKEN): Promise<Response> {
    const headers: Record<string, string> = { [COLLAB_TOKEN_HEADER]: token };
    const init: RequestInit = { method: 'POST', headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    return fetch(`http://${host}/internal/${path}`, init);
  }

  beforeAll(async () => {
    [postgres, valkey] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new GenericContainer(VALKEY_IMAGE)
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
    ]);
    const config = readConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      VALKEY_URL: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
      COLLAB_INTERNAL_TOKEN: INTERNAL_TOKEN,
      COLLAB_PERSIST_DEBOUNCE_MS: '100',
      COLLAB_PERSIST_MAX_DEBOUNCE_MS: '300',
    });
    database = createDatabase(config.DATABASE_URL);
    await runMigrations(database);
    redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
    collab = createCollab({
      config,
      logger: createLogger({ service: 'collab', level: 'silent' }),
      version: 'test',
      database,
      redis,
    });
    // listen(0) is ignored by Hocuspocus, so request an ephemeral port through the configuration.
    collab.server.configuration.port = 0;
    await collab.listen();
    host = `127.0.0.1:${collab.server.address.port}`;
  });

  afterAll(async () => {
    for (const provider of providers) provider.destroy();
    for (const socket of sockets) socket.destroy();
    await collab.destroy();
    await database.sql.end({ timeout: 5 });
    redis.disconnect();
    await Promise.all([postgres.stop(), valkey.stop()]);
  });

  it('serves liveness and readiness', async () => {
    const live = await fetch(`http://${host}/health/live`);
    expect(live.status).toBe(200);
    expect(healthResponse.parse(await live.json()).service).toBe('collab');

    const ready = await fetch(`http://${host}/health/ready`);
    expect(ready.status).toBe(200);
    const checks = healthResponse.parse(await ready.json()).checks;
    expect(checks?.valkey?.status).toBe('ok');
    expect(checks?.postgres?.status).toBe('ok');
  });

  it('exposes metrics and answers 404 elsewhere', async () => {
    const metrics = await (await fetch(`http://${host}/metrics`)).text();
    expect(metrics).toContain('galley_collab_connections');
    expect((await fetch(`http://${host}/`)).status).toBe(404);
  });

  it('refuses WebSocket upgrades from another origin', async () => {
    for (const headers of [{}, { origin: 'https://evil.example' }]) {
      const message = await new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://${host}`, { headers });
        socket.on('error', (error) => {
          resolve(error.message);
        });
        socket.on('open', () => {
          socket.close();
          resolve('opened');
        });
      });
      expect(message).toContain('403');
    }
  });

  it('refuses connections without a valid session or membership', async () => {
    const { fileId, projectId } = await projectWithFile('secret');
    const stranger = await signedInUser();
    expect(await refusal(fileDocumentName(fileId), null)).toBe('unauthenticated');
    expect(await refusal(fileDocumentName(fileId), 'forged')).toBe('unauthenticated');
    expect(await refusal(fileDocumentName(fileId), stranger.token)).toBe('forbidden');
    expect(await refusal(projectDocumentName(projectId), stranger.token)).toBe('forbidden');
    expect(await refusal('file:not-a-uuid', stranger.token)).toBe('forbidden');
    expect(await refusal(fileDocumentName(randomUUID()), stranger.token)).toBe('forbidden');
  });

  it('loads the stored text, persists edits and survives a reload', async () => {
    const { fileId, owner } = await projectWithFile('\\documentclass{article}\n');
    const first = await synced(fileDocumentName(fileId), owner.token);
    const text = first.document.getText(TEXT_KEY);
    expect(text.toJSON()).toBe('\\documentclass{article}\n');
    text.insert(text.length, '\\begin{document}é\\end{document}\n');
    const expected = '\\documentclass{article}\n\\begin{document}é\\end{document}\n';

    await eventually(async () => {
      expect(await storedText(fileId)).toBe(expected);
    });
    const [file] = await database.db
      .select({ size: files.size })
      .from(files)
      .where(eq(files.id, fileId));
    expect(file?.size).toBe(Buffer.byteLength(expected));

    first.destroy();
    await eventually(() => {
      expect(collab.server.hocuspocus.documents.has(fileDocumentName(fileId))).toBe(false);
    });
    const second = await synced(fileDocumentName(fileId), owner.token);
    expect(second.document.getText(TEXT_KEY).toJSON()).toBe(expected);
  });

  it('records who edited a project, for the authors of its next snapshot', async () => {
    const { fileId, projectId, owner } = await projectWithFile('text');
    const provider = await synced(fileDocumentName(fileId), owner.token);
    provider.document.getText(TEXT_KEY).insert(0, 'more ');
    await eventually(async () => {
      const rows = await database.db
        .select({ userId: projectActivity.userId })
        .from(projectActivity)
        .where(eq(projectActivity.projectId, projectId));
      expect(rows).toEqual([{ userId: owner.id }]);
    });
  });

  it('gives readers and reviewers a read-only connection', async () => {
    const { fileId, others } = await projectWithFile('original', ['reader', 'reviewer']);
    for (const member of others) {
      const scope = await new Promise<string>((resolve) => {
        connect(fileDocumentName(fileId), member.token, {
          onAuthenticated: ({ scope: granted }) => {
            resolve(granted);
          },
        });
      });
      expect(scope).toBe('readonly');
    }
    const reader = await synced(fileDocumentName(fileId), others[0]?.token ?? '');
    reader.document.getText(TEXT_KEY).insert(0, 'tampered ');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const live = collab.server.hocuspocus.documents.get(fileDocumentName(fileId));
    expect(live?.getText(TEXT_KEY).toJSON()).toBe('original');
    expect(await storedText(fileId)).toBe('original');
  });

  it('guards the internal routes with the shared token', async () => {
    const { projectId } = await projectWithFile('x');
    expect((await internal(`projects/${projectId}/flush`, undefined, 'wrong')).status).toBe(401);
    expect((await internal(`projects/${projectId}/nope`)).status).toBe(404);
    expect((await internal(`projects/${projectId}/flush`)).status).toBe(204);
  });

  it('replaces text for open editors and in the database', async () => {
    const { fileId, owner } = await projectWithFile('alpha beta gamma');
    const editor = await synced(fileDocumentName(fileId), owner.token);
    const response = await internal(`documents/${fileId}/replace`, {
      content: 'alpha BETA gamma',
    });
    expect(response.status).toBe(204);
    expect(await storedText(fileId)).toBe('alpha BETA gamma');
    await eventually(() => {
      expect(editor.document.getText(TEXT_KEY).toJSON()).toBe('alpha BETA gamma');
    });

    const { fileId: closedFile } = await projectWithFile('cold');
    expect((await internal(`documents/${closedFile}/replace`, { content: 'warm' })).status).toBe(
      204,
    );
    expect(await storedText(closedFile)).toBe('warm');

    expect((await internal(`documents/${randomUUID()}/replace`, { content: '' })).status).toBe(404);
    expect((await internal(`documents/${fileId}/replace`, { wrong: true })).status).toBe(400);
  });

  it('flushes a project before the debounce elapses', async () => {
    const { fileId, projectId, owner } = await projectWithFile('');
    const editor = await synced(fileDocumentName(fileId), owner.token);
    // Typing continuously keeps the debounce pending; flush must not wait for it.
    collab.server.configuration.debounce = 60_000;
    collab.server.configuration.maxDebounce = 60_000;
    try {
      editor.document.getText(TEXT_KEY).insert(0, 'typed');
      await eventually(() => {
        const live = collab.server.hocuspocus.documents.get(fileDocumentName(fileId));
        expect(live?.getText(TEXT_KEY).toJSON()).toBe('typed');
      });
      expect(await storedText(fileId)).toBe('');
      expect((await internal(`projects/${projectId}/flush`)).status).toBe(204);
      expect(await storedText(fileId)).toBe('typed');
    } finally {
      collab.server.configuration.debounce = 100;
      collab.server.configuration.maxDebounce = 300;
    }
  });

  it('closes a deleted file without writing it back', async () => {
    const { fileId, owner } = await projectWithFile('doomed');
    await collab.operations.flushProject(randomUUID());
    const closed = new Promise<void>((resolve, reject) => {
      connect(fileDocumentName(fileId), owner.token, {
        onClose: () => {
          resolve();
        },
        onSynced: () => {
          void (async () => {
            await database.db.delete(files).where(eq(files.id, fileId));
            expect((await internal(`documents/${fileId}/close`)).status).toBe(204);
          })().catch(reject);
        },
      });
    });
    await closed;
    await eventually(() => {
      expect(collab.server.hocuspocus.documents.has(fileDocumentName(fileId))).toBe(false);
    });
    expect(await storedText(fileId)).toBeUndefined();
  });

  it('relays project events from Valkey to the project channel', async () => {
    const { projectId, owner } = await projectWithFile('');
    const received = new Promise<string>((resolve) => {
      connect(projectDocumentName(projectId), owner.token, {
        onStateless: ({ payload }) => {
          resolve(payload);
        },
        onSynced: () => {
          void redis.publish(projectChannel(projectId), 'not json');
          void redis.publish(
            projectChannel(projectId),
            JSON.stringify({ type: 'tree.changed', projectId }),
          );
        },
      });
    });
    expect(JSON.parse(await received)).toEqual({ type: 'tree.changed', projectId });
  });

  it('shows every participant under their own account, whatever they announce', async () => {
    const { fileId, owner, others } = await projectWithFile('', ['editor']);
    const [editor] = others;
    if (!editor) throw new Error('missing member');
    const impostor = await synced(fileDocumentName(fileId), editor.token);
    const watcher = await synced(fileDocumentName(fileId), owner.token);
    impostor.setAwarenessField('user', { id: owner.id, name: 'Not me', color: '#000000' });
    impostor.setAwarenessField('cursor', { anchor: 1 });

    await eventually(() => {
      const states = [...(watcher.awareness?.getStates().values() ?? [])];
      const announced = states.find((state) => state.cursor !== undefined);
      expect(announced?.user).toEqual(presenceUserOf(editor.id, editor.displayName));
    });
  });

  it('disconnects a member whose access changed, who comes back with the new rights', async () => {
    const { fileId, projectId, owner, others } = await projectWithFile('text', ['editor']);
    const [editor] = others;
    if (!editor) throw new Error('missing member');
    const ownerProvider = await synced(fileDocumentName(fileId), owner.token);
    let closed = false;
    const editorProvider = await synced(fileDocumentName(fileId), editor.token);
    editorProvider.on('close', () => {
      closed = true;
    });

    await database.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, editor.id)));
    await redis.publish(
      projectChannel(projectId),
      JSON.stringify({ type: 'members.changed', projectId, userId: editor.id }),
    );

    await eventually(() => {
      expect(closed).toBe(true);
    });
    expect(await refusal(fileDocumentName(fileId), editor.token)).toBe('forbidden');
    // Other members stay connected and keep editing.
    ownerProvider.document.getText(TEXT_KEY).insert(0, 'still ');
    await eventually(async () => {
      expect(await storedText(fileId)).toBe('still text');
    });
  });

  it('closes connections that send oversized frames', async () => {
    const code = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}`, { headers: { origin: `http://${host}` } });
      const timer = setTimeout(() => {
        reject(new Error('connection stayed open'));
      }, 10_000);
      socket.on('open', () => {
        socket.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
      });
      socket.on('close', (closeCode) => {
        clearTimeout(timer);
        resolve(closeCode);
      });
    });
    // 1009: message too big.
    expect(code).toBe(1009);
  });
});

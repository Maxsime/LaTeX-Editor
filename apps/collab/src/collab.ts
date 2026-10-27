import type { Database } from '@galley/db';
import {
  fileDocumentName,
  hasRole,
  parseDocumentName,
  type ProjectEventMessage,
  presenceUserOf,
  runHealthChecks,
  TEXT_KEY,
} from '@galley/shared';
import { createProbeHandler, type Logger } from '@galley/shared/node';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { type Document, Server } from '@hocuspocus/server';
import type { Redis } from 'ioredis';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';
import * as Y from 'yjs';
import { AccessDenied, authorize, type CollabContext, originAllowed } from './access.js';
import { type CollabConfig, parseRedisUrl } from './config.js';
import { relayProjectEvents } from './events.js';
import { handleInternalRequest, type InternalOperations } from './internal.js';
import { loadFileState, storeFileState } from './persistence.js';
import { checkReviewerUpdate, InvalidUpdate } from './review.js';
import { replaceText } from './text.js';

/** Upper bound for a single WebSocket frame (CLAUDE.md: WebSocket messages are size-limited). */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export interface CollabDependencies {
  config: CollabConfig;
  logger: Logger;
  version: string;
  database: Database;
  /** Client used for readiness probes and, duplicated, for the project event relay. */
  redis: Redis;
  /** Disables the Valkey fan-out, for tests that run a single instance. */
  withoutRedisExtension?: boolean;
}

export interface Collab {
  server: Server;
  operations: InternalOperations;
  /** Starts the event relay, then listens. */
  listen(): Promise<void>;
  /** Persists pending documents, closes connections and stops the relay. */
  destroy(): Promise<void>;
}

/** Close code after which Hocuspocus clients reconnect at once (`ResetConnection`). */
const RESET_CONNECTION = 4205;

/**
 * Builds the collaboration server: Hocuspocus with session authentication,
 * read-only connections below the editor role, debounced persistence to
 * PostgreSQL, the project event relay and the internal routes used by the API.
 */
export function createCollab({
  config,
  logger,
  version,
  database,
  redis,
  withoutRedisExtension = false,
}: CollabDependencies): Collab {
  const { db } = database;
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'collab' });
  collectDefaultMetrics({ register: registry });
  const stores = new Counter({
    name: 'galley_collab_document_stores_total',
    help: 'Document writes to PostgreSQL, by outcome.',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const refusals = new Counter({
    name: 'galley_collab_refused_connections_total',
    help: 'WebSocket upgrades and document connections refused, by reason.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  const handleProbe = createProbeHandler({
    live: () => ({ status: 'ok', service: 'collab', version }),
    ready: async () => {
      const { status, checks } = await runHealthChecks({
        postgres: async () => {
          await database.sql`select 1`;
        },
        valkey: () => redis.ping(),
      });
      return { status, service: 'collab', version, checks };
    },
    metrics: async () => [registry.contentType, await registry.metrics()],
  });

  /** Project of each loaded document, to flush or close a project's documents. */
  const projectOf = new Map<string, string>();
  /** Users who changed each document since its last write: the authors of the next snapshot. */
  const editorsOf = new Map<string, Set<string>>();
  /** Documents being dropped: their pending writes must not reach the database. */
  const dropped = new Set<string>();

  const redisUrl = parseRedisUrl(config.VALKEY_URL);
  const server = new Server({
    port: config.COLLAB_PORT,
    quiet: true,
    // Shutdown is coordinated by destroy() so that pending writes land first.
    stopOnSignals: false,
    debounce: config.COLLAB_PERSIST_DEBOUNCE_MS,
    maxDebounce: config.COLLAB_PERSIST_MAX_DEBOUNCE_MS,
    websocketOptions: { maxPayload: MAX_MESSAGE_BYTES },
    extensions: withoutRedisExtension
      ? []
      : [
          new RedisExtension({
            host: redisUrl.host,
            port: redisUrl.port,
            options: redisUrl.options,
            prefix: 'galley:collab',
          }),
        ],

    async onRequest({ request, response }) {
      const handled =
        (await handleProbe(request, response)) ||
        (await handleInternalRequest(request, response, config.COLLAB_INTERNAL_TOKEN, operations));
      if (!handled) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { code: 'NOT_FOUND', messageKey: 'errors.NOT_FOUND' } }),
        );
      }
      // Hocuspocus treats an empty rejection as "handled, skip the default response".
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- protocol of the onRequest hook
      return Promise.reject();
    },

    async onUpgrade({ request, socket }) {
      if (originAllowed(request.headers.origin, request.headers.host)) return;
      refusals.inc({ reason: 'origin' });
      // The socket is a net.Socket before the upgrade completes.
      const raw = socket as { end(data: string): void };
      raw.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- same protocol as onRequest
      return Promise.reject();
    },

    async onAuthenticate({ documentName, requestHeaders, connectionConfig }) {
      try {
        const { context, readOnly } = await authorize(
          db,
          requestHeaders.get('cookie'),
          documentName,
        );
        connectionConfig.readOnly = readOnly;
        return context;
      } catch (error) {
        if (error instanceof AccessDenied) {
          refusals.inc({ reason: error.reason });
          throw error;
        }
        logger.error({ err: error }, 'websocket authorisation failed');
        throw new AccessDenied('forbidden');
      }
    },

    /**
     * Presence names the connection's own account: whatever identity a client
     * announces is replaced, so nobody can show a cursor under another name.
     */
    beforeHandleAwareness({ context, states }) {
      // Hocuspocus types the context as any; onAuthenticate returns a CollabContext.
      const identity = context as CollabContext | undefined;
      if (identity === undefined) return Promise.resolve();
      const user = presenceUserOf(identity.userId, identity.displayName);
      for (const state of states.values()) state.user = user;
      return Promise.resolve();
    },

    async onLoadDocument({ documentName, document }) {
      const target = parseDocumentName(documentName);
      if (target === null) throw new AccessDenied('forbidden');
      if (target.kind === 'project') {
        projectOf.set(documentName, target.id);
        return;
      }
      const stored = await loadFileState(db, target.id);
      if (stored === null) throw new AccessDenied('forbidden');
      projectOf.set(documentName, stored.projectId);
      if (stored.state !== null) Y.applyUpdate(document, stored.state);
    },

    /**
     * Reviewers write only suggestions and comment anchors. Sync step 1
     * carries no change; steps 2 and updates are checked before Hocuspocus
     * applies them, and a refused one closes the connection.
     */
    beforeSync({ context, document, type, payload }) {
      // Same context as in beforeHandleAwareness.
      const identity = context as CollabContext | undefined;
      if (identity === undefined || type === 0 || hasRole(identity.role, 'editor')) {
        return Promise.resolve();
      }
      if (identity.role !== 'reviewer') return Promise.resolve();
      try {
        checkReviewerUpdate(document, payload, identity.userId);
      } catch (error) {
        if (!(error instanceof InvalidUpdate)) {
          logger.error(
            { err: error, projectId: identity.projectId },
            'reviewer update check failed',
          );
          throw new InvalidUpdate('check-failed');
        }
        refusals.inc({ reason: error.reason });
        logger.warn(
          { userId: identity.userId, projectId: identity.projectId, check: error.detail },
          'reviewer update refused',
        );
        throw error;
      }
      return Promise.resolve();
    },

    onChange({ documentName, context }) {
      // Same context as in beforeHandleAwareness; server-side changes carry an empty one.
      const identity = context as Partial<CollabContext> | undefined;
      if (typeof identity?.userId !== 'string') return Promise.resolve();
      const editors = editorsOf.get(documentName) ?? new Set<string>();
      editors.add(identity.userId);
      editorsOf.set(documentName, editors);
      return Promise.resolve();
    },

    async onStoreDocument({ documentName, document }) {
      const target = parseDocumentName(documentName);
      if (target?.kind !== 'file' || dropped.has(documentName)) return;
      const content = document.getText(TEXT_KEY).toJSON();
      const authors = [...(editorsOf.get(documentName) ?? [])];
      editorsOf.delete(documentName);
      try {
        const written = await storeFileState(
          db,
          target.id,
          Y.encodeStateAsUpdate(document),
          Buffer.byteLength(content, 'utf8'),
          authors,
        );
        stores.inc({ result: written ? 'written' : 'gone' });
        if (!written) {
          // Deleted or turned binary while open: nobody may keep editing it.
          dropped.add(documentName);
          server.hocuspocus.closeConnections(documentName);
        }
      } catch (error) {
        stores.inc({ result: 'failed' });
        logger.error({ err: error, fileId: target.id }, 'document store failed');
        const editors = editorsOf.get(documentName) ?? new Set<string>();
        for (const author of authors) editors.add(author);
        editorsOf.set(documentName, editors);
        // Rethrown so that Hocuspocus keeps the document in memory and retries later.
        throw error;
      }
    },

    afterUnloadDocument({ documentName }) {
      projectOf.delete(documentName);
      editorsOf.delete(documentName);
      dropped.delete(documentName);
      return Promise.resolve();
    },
  });

  function documentsOf(projectId: string): Document[] {
    const found: Document[] = [];
    for (const [name, document] of server.hocuspocus.documents) {
      if (projectOf.get(name) === projectId) found.push(document);
    }
    return found;
  }

  const operations: InternalOperations = {
    async flushProject(projectId) {
      await Promise.all(
        documentsOf(projectId).map((document) =>
          server.hocuspocus.storeDocumentHooks(
            document,
            {
              clientsCount: document.getConnectionsCount(),
              document,
              documentName: document.name,
              instance: server.hocuspocus,
              lastContext: {},
              lastTransactionOrigin: undefined,
            },
            true,
          ),
        ),
      );
    },

    async replaceDocument(fileId, content) {
      const name = fileDocumentName(fileId);
      let connection;
      try {
        connection = await server.hocuspocus.openDirectConnection(name);
      } catch (error) {
        if (error instanceof AccessDenied) return false;
        throw error;
      }
      try {
        await connection.transact((document) => {
          replaceText(document.getText(TEXT_KEY), content);
        });
      } finally {
        // Disconnecting writes the document now, so the API reads it back consistent.
        await connection.disconnect();
      }
      return !dropped.has(name);
    },

    closeDocument(fileId) {
      const name = fileDocumentName(fileId);
      if (server.hocuspocus.documents.has(name)) {
        dropped.add(name);
        server.hocuspocus.closeConnections(name);
      }
      return Promise.resolve();
    },
  };

  function deliver(documentName: string, message: ProjectEventMessage): void {
    server.hocuspocus.documents.get(documentName)?.relayStateless(JSON.stringify(message));
    if (message.type === 'project.deleted') {
      for (const document of documentsOf(message.projectId)) {
        server.hocuspocus.closeConnections(document.name);
      }
    }
    if (message.type === 'members.changed' && message.userId !== null) {
      // Closing the whole socket, not only the document, makes the client reconnect
      // and authenticate every document again: with the new role, or refused.
      for (const document of documentsOf(message.projectId)) {
        for (const connection of document.getConnections()) {
          // Same context as above, typed any by Hocuspocus.
          const context = connection.context as CollabContext | undefined;
          if (context?.userId === message.userId) {
            connection.webSocket.close(RESET_CONNECTION, 'Reset Connection');
          }
        }
      }
    }
  }

  new Gauge({
    name: 'galley_collab_connections',
    help: 'Open WebSocket connections.',
    registers: [registry],
    collect() {
      this.set(server.hocuspocus.getConnectionsCount());
    },
  });
  new Gauge({
    name: 'galley_collab_documents',
    help: 'Documents loaded in memory.',
    registers: [registry],
    collect() {
      this.set(server.hocuspocus.getDocumentsCount());
    },
  });

  const subscriber = redis.duplicate();
  let stopRelay: (() => Promise<void>) | null = null;

  return {
    server,
    operations,
    async listen() {
      stopRelay = await relayProjectEvents(subscriber, logger, deliver);
      await server.listen();
    },
    async destroy() {
      server.hocuspocus.flushPendingStores();
      await server.destroy();
      await stopRelay?.();
      subscriber.disconnect();
    },
  };
}

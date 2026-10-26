import { runHealthChecks } from '@galley/shared';
import { createProbeHandler, type Logger } from '@galley/shared/node';
import { Redis as RedisExtension } from '@hocuspocus/extension-redis';
import { Server } from '@hocuspocus/server';
import type { Redis } from 'ioredis';
import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { type CollabConfig, parseRedisUrl } from './config.js';

/** Upper bound for a single WebSocket frame (CLAUDE.md: WebSocket messages are size-limited). */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export interface CollabDependencies {
  config: CollabConfig;
  logger: Logger;
  version: string;
  /** Client used for readiness probes; the Redis extension opens its own connections. */
  redis: Redis;
  /** Disables the Valkey fan-out, for tests that run a single instance without Valkey. */
  withoutRedisExtension?: boolean;
}

/**
 * Builds the Hocuspocus server. Access control lands in J5; until then every
 * WebSocket authentication is refused, so the server fails closed.
 */
export function createCollabServer({
  config,
  logger,
  version,
  redis,
  withoutRedisExtension = false,
}: CollabDependencies): Server {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'collab' });
  collectDefaultMetrics({ register: registry });

  const handleProbe = createProbeHandler({
    live: () => ({ status: 'ok', service: 'collab', version }),
    ready: async () => {
      const { status, checks } = await runHealthChecks({ valkey: () => redis.ping() });
      return { status, service: 'collab', version, checks };
    },
    metrics: async () => [registry.contentType, await registry.metrics()],
  });

  const redisUrl = parseRedisUrl(config.VALKEY_URL);
  const server = new Server({
    port: config.COLLAB_PORT,
    quiet: true,
    // Shutdown is coordinated by server.ts so that Valkey connections close last.
    stopOnSignals: false,
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
      if (await handleProbe(request, response)) {
        // Hocuspocus treats an empty rejection as "handled, skip the default response".
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- protocol of the onRequest hook
        return Promise.reject();
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { code: 'NOT_FOUND', messageKey: 'errors.NOT_FOUND' } }),
      );
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
      return Promise.reject();
    },

    onAuthenticate({ documentName }) {
      logger.warn(
        { documentName },
        'websocket authentication refused: access control not implemented',
      );
      return Promise.reject(new Error('FORBIDDEN'));
    },
  });

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

  return server;
}

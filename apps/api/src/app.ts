import { randomUUID } from 'node:crypto';
import type { HealthProbe } from '@galley/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './errors.js';
import { createMetrics } from './metrics.js';
import { healthRoutes } from './routes/health.js';

export interface AppDependencies {
  logger: FastifyBaseLogger;
  version: string;
  /** Readiness probes keyed by dependency name. */
  probes: Record<string, HealthProbe>;
}

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Builds the Fastify application without binding a port, so tests can use `inject`. */
export function buildApp({ logger, version, probes }: AppDependencies): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    // Caddy is the only client that reaches the API directly.
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    requestIdHeader: false,
    // Reuse the proxy's request id when it is well formed, so logs line up across services.
    genReqId: (request) => {
      const incoming = request.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  const metrics = createMetrics();
  app.addHook('onRequest', (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    metrics.httpDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
    done();
  });

  registerErrorHandling(app);
  healthRoutes(app, { version, probes });

  // Not proxied by Caddy: scraped on the internal network only.
  app.get('/metrics', async (_request, reply) => {
    void reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  return app;
}

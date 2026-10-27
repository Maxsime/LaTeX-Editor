import { randomUUID } from 'node:crypto';
import type { HealthProbe } from '@galley/shared';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { type ArchiveLimits, DEFAULT_ARCHIVE_LIMITS } from './archive/limits.js';
import { registerAuth } from './auth/plugin.js';
import type { AppContext } from './context.js';
import { registerErrorHandling } from './errors.js';
import { createMetrics } from './metrics.js';
import { adminRoutes } from './routes/admin.js';
import { archiveRoutes } from './routes/archive.js';
import { authRoutes } from './routes/auth.js';
import { compileRoutes } from './routes/compile.js';
import { editorRoutes } from './routes/editor.js';
import { fileRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { historyRoutes } from './routes/history.js';
import { reviewRoutes } from './routes/review.js';
import { tokenRoutes } from './routes/tokens.js';
import { gitRoutes } from './routes/git.js';
import { projectRoutes } from './routes/projects.js';
import { sharingRoutes } from './routes/sharing.js';
import { tagRoutes } from './routes/tags.js';

export interface AppDependencies {
  logger: FastifyBaseLogger;
  version: string;
  /** Readiness probes keyed by dependency name. */
  probes: Record<string, HealthProbe>;
  /** Dependencies of the feature routes; without them only health and metrics are served. */
  context?: AppContext;
  /** Overrides the archive limits, so tests can exercise them with small archives. */
  archiveLimits?: ArchiveLimits;
}

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Builds the Fastify application without binding a port, so tests can use `inject`. */
export function buildApp({
  logger,
  version,
  probes,
  context,
  archiveLimits,
}: AppDependencies): FastifyInstance {
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
  if (context) {
    // Encapsulated so that session and CSRF hooks only run for feature routes.
    void app.register(async (api) => {
      await api.register(rateLimit, {
        global: false,
        redis: context.redis,
        nameSpace: 'galley:rate-limit:',
      });
      await api.register(multipart);
      await registerAuth(api, context);
      authRoutes(api, context);
      adminRoutes(api, context);
      projectRoutes(api, context);
      sharingRoutes(api, context);
      tagRoutes(api, context);
      fileRoutes(api, context);
      editorRoutes(api, context);
      archiveRoutes(api, context, archiveLimits);
      compileRoutes(api, context);
      historyRoutes(api, context);
      tokenRoutes(api, context);
      reviewRoutes(api, context);
    });
    // Git clients authenticate with access tokens, never with the session cookie.
    void app.register((gitApp, _options, done) => {
      gitRoutes(gitApp, context, {
        maxEntries: (archiveLimits ?? DEFAULT_ARCHIVE_LIMITS).maxEntries,
      });
      done();
    });
  }

  // Not proxied by Caddy: scraped on the internal network only.
  app.get('/metrics', async (_request, reply) => {
    void reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  return app;
}

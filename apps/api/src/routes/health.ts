import { type HealthProbe, type HealthResponse, runHealthChecks } from '@galley/shared';
import type { FastifyInstance } from 'fastify';

export interface HealthRouteOptions {
  version: string;
  probes: Record<string, HealthProbe>;
}

/**
 * `live` answers as long as the process serves requests; `ready` also checks
 * PostgreSQL, Valkey and object storage, and drives the container health check.
 */
export function healthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/api/health/live', (_request, reply): HealthResponse => {
    void reply.header('cache-control', 'no-store');
    return { status: 'ok', service: 'api', version: options.version };
  });

  app.get('/api/health/ready', async (_request, reply): Promise<HealthResponse> => {
    const { status, checks } = await runHealthChecks(options.probes);
    void reply.header('cache-control', 'no-store').status(status === 'ok' ? 200 : 503);
    return { status, service: 'api', version: options.version, checks };
  });
}

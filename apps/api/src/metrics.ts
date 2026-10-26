import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
}

/** Prometheus registry for the API process. One per app instance, to keep tests isolated. */
export function createMetrics(): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'api' });
  collectDefaultMetrics({ register: registry });
  const httpDuration = new Histogram({
    name: 'galley_http_request_duration_seconds',
    help: 'HTTP request duration, labelled by route template rather than raw URL.',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  return { registry, httpDuration };
}

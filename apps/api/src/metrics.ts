import type { Queue } from 'bullmq';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
}

/**
 * Assistant counters, shared by the code that runs requests. Registered in
 * each app's registry by {@link createMetrics}.
 */
export const aiRequests = new Counter({
  name: 'galley_ai_requests_total',
  help: 'Assistant requests, by mode and outcome (ok, error, cancelled).',
  labelNames: ['mode', 'outcome'] as const,
  registers: [],
});

export const aiTokens = new Counter({
  name: 'galley_ai_tokens_total',
  help: 'Tokens exchanged with AI providers, by provider and direction (input, output).',
  labelNames: ['provider', 'direction'] as const,
  registers: [],
});

/** Prometheus registry for the API process. One per app instance, to keep tests isolated. */
export function createMetrics(compileQueue?: Pick<Queue, 'getJobCounts'>): Metrics {
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
  registry.registerMetric(aiRequests);
  registry.registerMetric(aiTokens);
  if (compileQueue) {
    new Gauge({
      name: 'galley_compile_queue_jobs',
      help: 'Compilations in the queue, by state (waiting, active, delayed, failed).',
      labelNames: ['state'] as const,
      registers: [registry],
      // Read at scrape time: the queue lives in Valkey, shared by every API replica.
      async collect() {
        const counts = await compileQueue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, count] of Object.entries(counts)) this.set({ state }, count);
      },
    });
  }
  return { registry, httpDuration };
}

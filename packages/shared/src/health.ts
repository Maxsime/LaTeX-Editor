import { z } from 'zod';

export const healthStatus = z.enum(['ok', 'error']);
export type HealthStatus = z.infer<typeof healthStatus>;

export const dependencyCheck = z.object({
  status: healthStatus,
  latencyMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheck>;

/** Body returned by every service's liveness and readiness endpoints. */
export const healthResponse = z.object({
  status: healthStatus,
  service: z.string(),
  version: z.string(),
  checks: z.record(z.string(), dependencyCheck).optional(),
});
export type HealthResponse = z.infer<typeof healthResponse>;

export type HealthProbe = () => Promise<unknown>;

/**
 * Runs dependency probes concurrently, each bounded by `timeoutMs`.
 * A probe that throws or exceeds its budget is reported as failed; the overall
 * status is `ok` only when every probe succeeds.
 *
 * Error details are reduced to the error name so that connection strings or
 * credentials embedded in driver messages never reach a health response.
 */
export async function runHealthChecks(
  probes: Record<string, HealthProbe>,
  timeoutMs = 2_000,
): Promise<{ status: HealthStatus; checks: Record<string, DependencyCheck> }> {
  const entries = await Promise.all(
    Object.entries(probes).map(async ([name, probe]): Promise<[string, DependencyCheck]> => {
      const started = performance.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          probe(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new HealthTimeoutError(timeoutMs));
            }, timeoutMs);
          }),
        ]);
        return [name, { status: 'ok', latencyMs: elapsed(started) }];
      } catch (error) {
        return [name, { status: 'error', latencyMs: elapsed(started), error: describe(error) }];
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const checks = Object.fromEntries(entries);
  const status = entries.every(([, check]) => check.status === 'ok') ? 'ok' : 'error';
  return { status, checks };
}

export class HealthTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Probe exceeded ${timeoutMs} ms`);
    this.name = 'HealthTimeoutError';
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function describe(error: unknown): string {
  if (error instanceof HealthTimeoutError) {
    return 'timeout';
  }
  if (error instanceof Error) {
    return error.name;
  }
  return 'unknown';
}

import { type HealthResponse, healthResponse } from '@galley/shared';

export type ServiceState =
  | { kind: 'ok'; health: HealthResponse }
  | { kind: 'degraded'; health: HealthResponse }
  | { kind: 'unreachable' };

/**
 * Fetches API readiness. A 503 still carries a valid body describing which
 * dependency is down, so it is reported as degraded rather than as an error.
 */
export async function fetchApiHealth(signal?: AbortSignal): Promise<ServiceState> {
  let response: Response;
  try {
    response = await fetch('/api/health/ready', { signal: signal ?? null, cache: 'no-store' });
  } catch {
    return { kind: 'unreachable' };
  }
  const parsed = healthResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { kind: 'unreachable' };
  }
  return parsed.data.status === 'ok'
    ? { kind: 'ok', health: parsed.data }
    : { kind: 'degraded', health: parsed.data };
}

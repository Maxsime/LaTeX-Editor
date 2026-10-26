import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchApiHealth } from './health.js';

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchApiHealth', () => {
  it('reports a healthy API', async () => {
    respond(200, { status: 'ok', service: 'api', version: '1.0.0', checks: {} });
    expect((await fetchApiHealth()).kind).toBe('ok');
  });

  it('reports a degraded API from a 503 body', async () => {
    respond(503, {
      status: 'error',
      service: 'api',
      version: '1.0.0',
      checks: { valkey: { status: 'error', latencyMs: 3, error: 'timeout' } },
    });
    const state = await fetchApiHealth();
    expect(state.kind).toBe('degraded');
  });

  it('reports an unreachable API on network failure or garbage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network'))),
    );
    expect((await fetchApiHealth()).kind).toBe('unreachable');
    respond(502, '<html>Bad gateway</html>');
    expect((await fetchApiHealth()).kind).toBe('unreachable');
  });
});

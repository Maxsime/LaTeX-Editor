import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthResponse } from '../health.js';
import { createProbeServer } from './probe-server.js';

let ready: HealthResponse = { status: 'ok', service: 'test', version: '1.0.0' };
let failMetrics = false;

const server = createProbeServer({
  live: () => ({ status: 'ok', service: 'test', version: '1.0.0' }),
  ready: () => Promise.resolve(ready),
  metrics: () =>
    failMetrics ? Promise.reject(new Error('boom')) : Promise.resolve(['text/plain', 'up 1\n']),
});
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // listen() on a TCP port always yields AddressInfo
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('probe server', () => {
  it('serves liveness', async () => {
    const response = await fetch(`${base}/health/live`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'test' });
  });

  it('returns 503 when not ready', async () => {
    ready = { status: 'error', service: 'test', version: '1.0.0' };
    const response = await fetch(`${base}/health/ready?verbose=1`);
    expect(response.status).toBe(503);
    ready = { status: 'ok', service: 'test', version: '1.0.0' };
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  });

  it('serves metrics', async () => {
    const response = await fetch(`${base}/metrics`);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(await response.text()).toBe('up 1\n');
  });

  it('answers 404 on unknown paths and non-GET methods', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/health/live`, { method: 'POST' })).status).toBe(404);
  });

  it('hides handler failures behind a typed 500', async () => {
    failMetrics = true;
    const response = await fetch(`${base}/metrics`);
    failMetrics = false;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('boom');
  });
});

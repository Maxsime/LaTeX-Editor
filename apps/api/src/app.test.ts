import { apiErrorBody, healthResponse } from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const logger = createLogger({ service: 'api', level: 'silent' });
let app: FastifyInstance | undefined;

function makeApp(probes: Record<string, () => Promise<unknown>> = {}): FastifyInstance {
  app = buildApp({ logger, version: '1.2.3', probes });
  app.get('/api/test/boom', () => {
    throw new Error('connect postgres://user:secret@db failed');
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health routes', () => {
  it('reports liveness without touching dependencies', async () => {
    const response = await makeApp({
      postgres: () => Promise.reject(new Error('down')),
    }).inject('/api/health/live');
    expect(response.statusCode).toBe(200);
    expect(healthResponse.parse(response.json())).toEqual({
      status: 'ok',
      service: 'api',
      version: '1.2.3',
    });
  });

  it('reports readiness per dependency', async () => {
    const response = await makeApp({
      postgres: () => Promise.resolve(),
      valkey: () => Promise.resolve(),
    }).inject('/api/health/ready');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = healthResponse.parse(response.json());
    expect(Object.keys(body.checks ?? {})).toEqual(['postgres', 'valkey']);
  });

  it('answers 503 when a dependency is down', async () => {
    const response = await makeApp({
      postgres: () => Promise.resolve(),
      storage: () => Promise.reject(new Error('unreachable')),
    }).inject('/api/health/ready');
    expect(response.statusCode).toBe(503);
    expect(healthResponse.parse(response.json()).checks?.storage?.status).toBe('error');
  });
});

describe('errors', () => {
  it('answers unknown routes with a typed 404', async () => {
    const response = await makeApp().inject('/api/does-not-exist');
    expect(response.statusCode).toBe(404);
    expect(apiErrorBody.parse(response.json()).error).toMatchObject({
      code: 'NOT_FOUND',
      messageKey: 'errors.NOT_FOUND',
    });
  });

  it('never returns stack traces or driver messages', async () => {
    const response = await makeApp().inject('/api/test/boom');
    expect(response.statusCode).toBe(500);
    expect(apiErrorBody.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('at ');
  });

  it('maps malformed bodies to a typed 400', async () => {
    const instance = makeApp();
    instance.post('/api/test/echo', (request) => request.body);
    const response = await instance.inject({
      method: 'POST',
      url: '/api/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(apiErrorBody.parse(response.json()).error.code).toBe('BAD_REQUEST');
  });
});

describe('request ids', () => {
  it('propagates a well-formed incoming id', async () => {
    const id = 'caddy-0123456789abcdef';
    const response = await makeApp().inject({
      url: '/api/health/live',
      headers: { 'x-request-id': id },
    });
    expect(response.headers['x-request-id']).toBe(id);
  });

  it('replaces a malformed incoming id', async () => {
    const response = await makeApp().inject({
      url: '/api/health/live',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('includes the request id in error bodies', async () => {
    const response = await makeApp().inject('/api/nope');
    expect(apiErrorBody.parse(response.json()).error.requestId).toBe(
      response.headers['x-request-id'],
    );
  });
});

describe('metrics', () => {
  it('exposes Prometheus metrics with route templates', async () => {
    const instance = makeApp();
    await instance.inject('/api/health/live');
    const response = await instance.inject('/metrics');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('galley_http_request_duration_seconds_count');
    expect(response.body).toContain('route="/api/health/live"');
    expect(response.body).toContain('process_cpu_user_seconds_total');
  });
});

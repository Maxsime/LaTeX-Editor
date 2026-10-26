import { describe, expect, it } from 'vitest';
import { healthResponse, runHealthChecks } from './health.js';

describe('runHealthChecks', () => {
  it('reports ok when every probe resolves', async () => {
    const result = await runHealthChecks({
      postgres: () => Promise.resolve(),
      valkey: () => Promise.resolve('PONG'),
    });
    expect(result.status).toBe('ok');
    expect(result.checks.postgres?.status).toBe('ok');
    expect(result.checks.valkey?.status).toBe('ok');
  });

  it('reports the failing dependency without leaking its message', async () => {
    const result = await runHealthChecks({
      postgres: () => Promise.reject(new TypeError('connect postgres://u:secret@db failed')),
      valkey: () => Promise.resolve(),
    });
    expect(result.status).toBe('error');
    expect(result.checks.postgres).toMatchObject({ status: 'error', error: 'TypeError' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.checks.valkey?.status).toBe('ok');
  });

  it('times out a hanging probe', async () => {
    const result = await runHealthChecks({ storage: () => new Promise(() => undefined) }, 20);
    expect(result.checks.storage).toMatchObject({ status: 'error', error: 'timeout' });
  });

  it('handles non-Error rejections', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
    const result = await runHealthChecks({ odd: () => Promise.reject('nope') });
    expect(result.checks.odd?.error).toBe('unknown');
  });

  it('reports ok with no probes', async () => {
    expect((await runHealthChecks({})).status).toBe('ok');
  });

  it('produces bodies accepted by the shared schema', async () => {
    const { status, checks } = await runHealthChecks({ a: () => Promise.resolve() });
    expect(() =>
      healthResponse.parse({ status, service: 'api', version: '0.0.0', checks }),
    ).not.toThrow();
  });
});

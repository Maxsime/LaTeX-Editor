import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, errorMessageKey, setCsrfToken } from './api.js';

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(new Response(body === null ? null : JSON.stringify(body), { status })),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('api', () => {
  it('sends the CSRF token on state-changing calls only', async () => {
    respond(200, { ok: true });
    setCsrfToken('token');
    await api('POST', '/api/x', { json: {} });
    await api('GET', '/api/x', { query: { a: '1', b: undefined, c: '' } });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0]?.[1]?.headers).toMatchObject({ 'x-csrf-token': 'token' });
    expect(calls[1]?.[0]).toBe('/api/x?a=1');
    expect(calls[1]?.[1]?.headers).toEqual({});
  });

  it('turns error bodies into typed errors with translatable keys', async () => {
    respond(400, {
      error: {
        code: 'VALIDATION_FAILED',
        messageKey: 'errors.VALIDATION_FAILED',
        fields: [{ path: 'archive', messageKey: 'archive.SYMLINK' }],
      },
    });
    const error = await api('POST', '/api/projects/import').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(errorMessageKey(error)).toBe('archive.SYMLINK');
  });

  it('maps unreadable errors and network failures', async () => {
    respond(502, null);
    expect(errorMessageKey(await api('GET', '/api/x').catch((e: unknown) => e))).toBe(
      'errors.INTERNAL_ERROR',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    expect(errorMessageKey(await api('GET', '/api/x').catch((e: unknown) => e))).toBe(
      'errors.SERVICE_UNAVAILABLE',
    );
  });

  it('returns undefined for 204', async () => {
    respond(204, null);
    await expect(api('DELETE', '/api/x')).resolves.toBeUndefined();
  });
});

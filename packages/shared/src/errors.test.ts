import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorBody, errorCodes, httpStatusFor } from './errors.js';

describe('API errors', () => {
  it('maps every code to a client or server error status', () => {
    for (const code of errorCodes) {
      const status = httpStatusFor(code);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('carries code and status on ApiError', () => {
    const error = new ApiError('NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('NOT_FOUND');
    expect(new ApiError('CONFLICT', 'detail').message).toBe('detail');
  });

  it('rejects unknown codes in error bodies', () => {
    expect(() =>
      apiErrorBody.parse({ error: { code: 'TEAPOT', messageKey: 'errors.TEAPOT' } }),
    ).toThrow();
  });
});

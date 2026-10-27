import { describe, expect, it } from 'vitest';
import { limitsOf, monthStart } from './quotas.js';

describe('limitsOf', () => {
  const defaults = { storageMb: 500, compileMinutes: 600 };

  it('follows the instance defaults when a person has none', () => {
    expect(limitsOf(defaults, undefined)).toEqual({
      storageBytes: 500 * 1024 * 1024,
      compileSeconds: 36_000,
    });
    expect(limitsOf(defaults, { storageMb: null, compileMinutes: null })).toEqual(
      limitsOf(defaults, undefined),
    );
  });

  it('applies a person own values, -1 lifting the limit', () => {
    expect(limitsOf(defaults, { storageMb: -1, compileMinutes: 10 })).toEqual({
      storageBytes: null,
      compileSeconds: 600,
    });
  });

  it('keeps unlimited defaults unlimited', () => {
    expect(limitsOf({ storageMb: null, compileMinutes: null }, undefined)).toEqual({
      storageBytes: null,
      compileSeconds: null,
    });
  });
});

describe('monthStart', () => {
  it('is the first instant of the UTC month', () => {
    expect(monthStart(new Date('2026-10-27T21:00:00+02:00')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(monthStart(new Date('2026-11-01T00:30:00+01:00')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});

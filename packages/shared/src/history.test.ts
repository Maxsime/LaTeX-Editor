import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_PREFIX,
  createAccessTokenRequest,
  createVersionRequest,
  restoreRequest,
  updateSnapshotRequest,
} from './history.js';

describe('history requests', () => {
  it('trims version names and refuses empty or long ones', () => {
    expect(createVersionRequest.parse({ label: '  Rendu final ' })).toEqual({
      label: 'Rendu final',
    });
    expect(createVersionRequest.safeParse({ label: '   ' }).success).toBe(false);
    expect(createVersionRequest.safeParse({ label: 'x'.repeat(101) }).success).toBe(false);
    expect(updateSnapshotRequest.parse({ label: null })).toEqual({ label: null });
  });

  it('restores a project path only', () => {
    expect(restoreRequest.parse({})).toEqual({});
    expect(restoreRequest.parse({ path: 'chapters/one.tex' })).toEqual({
      path: 'chapters/one.tex',
    });
    expect(restoreRequest.safeParse({ path: '../secret' }).success).toBe(false);
    expect(restoreRequest.safeParse({ path: '/etc/passwd' }).success).toBe(false);
  });
});

describe('access token requests', () => {
  it('bounds names and lifetimes', () => {
    expect(createAccessTokenRequest.parse({ name: ' Portable ', expiresInDays: 30 })).toEqual({
      name: 'Portable',
      expiresInDays: 30,
    });
    expect(createAccessTokenRequest.safeParse({ name: '' }).success).toBe(false);
    expect(createAccessTokenRequest.safeParse({ name: 'x', expiresInDays: 0 }).success).toBe(false);
    expect(createAccessTokenRequest.safeParse({ name: 'x', expiresInDays: 366 }).success).toBe(
      false,
    );
    expect(ACCESS_TOKEN_PREFIX).toBe('glp_');
  });
});

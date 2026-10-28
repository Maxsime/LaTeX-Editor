import { describe, expect, it } from 'vitest';
import { username } from '@galley/shared';
import { claimsOf, publicOrigin, safeRedirect, usernameCandidate } from './oidc.js';
import { readConfig } from '../config.js';

describe('safeRedirect', () => {
  it.each([
    ['/project/1?x=2', '/project/1?x=2'],
    [undefined, '/'],
    ['https://evil.example.org/', '/'],
    ['//evil.example.org/', '/'],
    ['/\\evil.example.org', '/'],
    ['project', '/'],
  ])('keeps %j as %j', (target, expected) => {
    expect(safeRedirect(target)).toBe(expected);
  });
});

describe('claimsOf', () => {
  it('normalises the address and reads string booleans', () => {
    expect(
      claimsOf({ sub: 'abc', email: ' Ada@Example.ORG ', email_verified: 'true', name: 'Ada' }),
    ).toEqual({
      subject: 'abc',
      email: 'ada@example.org',
      emailVerified: true,
      preferredUsername: null,
      name: 'Ada',
    });
  });

  it('treats a missing verification as unverified and requires a subject', () => {
    expect(claimsOf({ sub: 'abc', email: 'a@b.org' }).emailVerified).toBe(false);
    expect(() => claimsOf({ email: 'a@b.org' })).toThrow();
  });
});

describe('usernameCandidate', () => {
  const claims = (preferredUsername: string | null, email: string | null) => ({
    subject: 's',
    email,
    emailVerified: true,
    preferredUsername,
    name: null,
  });

  it.each([
    [claims('ada.lovelace', null), 'ada.lovelace'],
    [claims(null, 'élodie.m@example.org'), 'elodie.m'],
    [claims('_x', null), 'userx'],
    [claims('a b@c', null), 'abc'],
    [claims(null, null), 'user'],
  ])('derives a valid name', (input, expected) => {
    const name = usernameCandidate(input);
    expect(name).toBe(expected);
    expect(username.safeParse(name).success).toBe(true);
  });
});

describe('publicOrigin', () => {
  const env = {
    DATABASE_URL: 'postgres://u:p@db/g',
    VALKEY_URL: 'redis://valkey:6379',
    S3_ENDPOINT: 'http://s3:8333',
    S3_ACCESS_KEY_ID: 'a',
    S3_SECRET_ACCESS_KEY: 'secret-key',
    S3_BUCKET: 'galley',
  };

  it('omits the default port', () => {
    expect(publicOrigin(readConfig({ ...env, GALLEY_HOST: 'tex.example.org' }))).toBe(
      'https://tex.example.org',
    );
    expect(publicOrigin(readConfig({ ...env, GALLEY_HTTPS_PORT: '8443' }))).toBe(
      'https://localhost:8443',
    );
  });
});

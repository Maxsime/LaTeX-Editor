import { describe, expect, it } from 'vitest';
import { parseRedisUrl } from './config.js';

describe('parseRedisUrl', () => {
  it('parses a plain URL with defaults', () => {
    expect(parseRedisUrl('redis://valkey')).toEqual({ host: 'valkey', port: 6379, options: {} });
  });

  it('parses credentials, database and TLS', () => {
    expect(parseRedisUrl('rediss://user:p%40ss@cache.internal:6380/2')).toEqual({
      host: 'cache.internal',
      port: 6380,
      options: { username: 'user', password: 'p@ss', db: 2, tls: {} },
    });
  });
});

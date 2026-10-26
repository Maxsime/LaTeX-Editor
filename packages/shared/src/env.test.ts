import { describe, expect, it } from 'vitest';
import { apiEnv, collabEnv, compilerEnv, ConfigError, loadConfig } from './env.js';

const validApiEnv = {
  DATABASE_URL: 'postgres://galley:pw@postgres:5432/galley',
  VALKEY_URL: 'redis://valkey:6379',
  S3_ENDPOINT: 'http://storage:8333',
  S3_ACCESS_KEY_ID: 'galley',
  S3_SECRET_ACCESS_KEY: 'super-secret-value',
  S3_BUCKET: 'galley',
};

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig(apiEnv, validApiEnv);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      API_HOST: '0.0.0.0',
      API_PORT: 3000,
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: true,
    });
  });

  it('coerces numeric and boolean variables', () => {
    const config = loadConfig(apiEnv, {
      ...validApiEnv,
      API_PORT: '8080',
      S3_FORCE_PATH_STYLE: 'false',
    });
    expect(config.API_PORT).toBe(8080);
    expect(config.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('lists every missing variable', () => {
    expect(() => loadConfig(apiEnv, {})).toThrow(ConfigError);
    try {
      loadConfig(apiEnv, {});
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      const keys = error.issues.map((issue) => issue.split(':')[0]);
      expect(keys).toEqual(
        expect.arrayContaining([
          'DATABASE_URL',
          'VALKEY_URL',
          'S3_ENDPOINT',
          'S3_ACCESS_KEY_ID',
          'S3_SECRET_ACCESS_KEY',
          'S3_BUCKET',
        ]),
      );
    }
  });

  it('rejects malformed values', () => {
    expect(() => loadConfig(apiEnv, { ...validApiEnv, DATABASE_URL: 'mysql://db' })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => loadConfig(apiEnv, { ...validApiEnv, API_PORT: '70000' })).toThrow(/API_PORT/);
    expect(() => loadConfig(apiEnv, { ...validApiEnv, S3_BUCKET: 'Bad_Bucket' })).toThrow(
      /S3_BUCKET/,
    );
    expect(() => loadConfig(apiEnv, { ...validApiEnv, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('never echoes the value of an invalid secret', () => {
    const secret = 'short';
    try {
      loadConfig(apiEnv, { ...validApiEnv, S3_SECRET_ACCESS_KEY: secret });
      expect.unreachable();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      expect(error.message).toContain('S3_SECRET_ACCESS_KEY');
      expect(error.message).not.toContain(secret);
    }
  });

  it('never echoes credentials embedded in an invalid URL', () => {
    const password = 'hunter2-password';
    try {
      loadConfig(apiEnv, { ...validApiEnv, DATABASE_URL: `mysql://u:${password}@db/x` });
      expect.unreachable();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      expect(error.message).not.toContain(password);
    }
  });

  it('requires the internal token once the collab URL is set', () => {
    expect(loadConfig(apiEnv, validApiEnv).COLLAB_INTERNAL_URL).toBeUndefined();
    expect(() =>
      loadConfig(apiEnv, { ...validApiEnv, COLLAB_INTERNAL_URL: 'http://collab:3001' }),
    ).toThrow(/COLLAB_INTERNAL_TOKEN/);
    const config = loadConfig(apiEnv, {
      ...validApiEnv,
      COLLAB_INTERNAL_URL: 'http://collab:3001',
      COLLAB_INTERNAL_TOKEN: 'y'.repeat(40),
    });
    expect(config.COLLAB_INTERNAL_URL).toBe('http://collab:3001');
  });

  it('validates the collab and compiler schemas', () => {
    const collab = loadConfig(collabEnv, {
      DATABASE_URL: validApiEnv.DATABASE_URL,
      VALKEY_URL: 'redis://valkey:6379',
      COLLAB_INTERNAL_TOKEN: 'x'.repeat(32),
    });
    expect(collab).toMatchObject({
      COLLAB_PORT: 3001,
      COLLAB_PERSIST_DEBOUNCE_MS: 2_000,
      COLLAB_PERSIST_MAX_DEBOUNCE_MS: 10_000,
    });
    expect(() =>
      loadConfig(collabEnv, {
        DATABASE_URL: validApiEnv.DATABASE_URL,
        VALKEY_URL: 'redis://valkey:6379',
        COLLAB_INTERNAL_TOKEN: 'short',
      }),
    ).toThrow(/COLLAB_INTERNAL_TOKEN/);
    const compiler = loadConfig(compilerEnv, { VALKEY_URL: 'rediss://valkey:6380' });
    expect(compiler.COMPILER_HEALTH_PORT).toBe(3002);
    expect(compiler.COMPILER_CONCURRENCY).toBe(1);
    expect(() => loadConfig(compilerEnv, { VALKEY_URL: 'http://valkey' })).toThrow(/VALKEY_URL/);
  });
});

import { describe, expect, it } from 'vitest';
import { developmentSecretsInUse, readConfig } from './config.js';

const development = {
  DATABASE_URL: 'postgres://galley:galley-dev-password@postgres:5432/galley',
  VALKEY_URL: 'redis://valkey:6379',
  S3_ENDPOINT: 'http://storage:8333',
  S3_ACCESS_KEY_ID: 'galley',
  S3_SECRET_ACCESS_KEY: 'galley-dev-secret',
  S3_BUCKET: 'galley',
  COLLAB_INTERNAL_URL: 'http://collab:3001',
  COLLAB_INTERNAL_TOKEN: 'galley-dev-internal-token-change-me',
  GALLEY_MASTER_KEY: 'Z2FsbGV5LWRldi1tYXN0ZXIta2V5LWNoYW5nZS1tZSE=',
};

describe('developmentSecretsInUse', () => {
  it('tolerates the development secrets on localhost', () => {
    expect(developmentSecretsInUse(readConfig(development))).toEqual([]);
  });

  it('names each development secret left on a public host', () => {
    const config = readConfig({ ...development, GALLEY_HOST: 'tex.example.org' });
    expect(developmentSecretsInUse(config)).toEqual([
      'POSTGRES_PASSWORD',
      'S3_SECRET_ACCESS_KEY',
      'COLLAB_INTERNAL_TOKEN',
      'GALLEY_MASTER_KEY',
    ]);
  });

  it('accepts a public host once every secret is replaced', () => {
    const config = readConfig({
      ...development,
      GALLEY_HOST: 'tex.example.org',
      DATABASE_URL: 'postgres://galley:Xq9%2Fz@postgres:5432/galley',
      S3_SECRET_ACCESS_KEY: 'another-secret',
      COLLAB_INTERNAL_TOKEN: 'x'.repeat(48),
      GALLEY_MASTER_KEY: Buffer.alloc(32, 3).toString('base64'),
    });
    expect(developmentSecretsInUse(config)).toEqual([]);
  });
});

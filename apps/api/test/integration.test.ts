import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ListBucketsCommand, type S3Client } from '@aws-sdk/client-s3';
import { healthResponse } from '@galley/shared';
import { createLogger } from '@galley/shared/node';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Redis } from 'ioredis';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readConfig, type ApiConfig } from '../src/config.js';
import { createDatabase, type Database, migrationsFolder } from '@galley/db';
import { runMigrations } from '@galley/db';
import { createS3Client, ensureBucket, headBucket } from '../src/storage/s3.js';
import {
  dockerAvailable,
  S3_CREDENTIALS,
  startPostgres,
  startSeaweedfs,
  startValkey,
} from './containers.js';

describe.skipIf(!dockerAvailable)('api against real dependencies', () => {
  let postgres: StartedPostgreSqlContainer;
  let valkey: StartedTestContainer;
  let seaweedfs: StartedTestContainer;
  let config: ApiConfig;
  let database: Database;
  let redis: Redis;
  let s3: S3Client;

  beforeAll(async () => {
    [postgres, valkey, seaweedfs] = await Promise.all([
      startPostgres(),
      startValkey(),
      startSeaweedfs(),
    ]);
    config = readConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      VALKEY_URL: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
      S3_ENDPOINT: `http://${seaweedfs.getHost()}:${seaweedfs.getMappedPort(8333)}`,
      S3_ACCESS_KEY_ID: S3_CREDENTIALS.accessKeyId,
      S3_SECRET_ACCESS_KEY: S3_CREDENTIALS.secretAccessKey,
      S3_BUCKET: 'galley-test',
    });
    database = createDatabase(config.DATABASE_URL);
    redis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 });
    s3 = createS3Client(config);
  });

  afterAll(async () => {
    await database.sql.end({ timeout: 5 });
    redis.disconnect();
    s3.destroy();
    await Promise.all([postgres.stop(), valkey.stop(), seaweedfs.stop()]);
  });

  it('applies migrations, and concurrent or repeated runs are harmless', async () => {
    const second = createDatabase(config.DATABASE_URL);
    try {
      await Promise.all([runMigrations(database), runMigrations(second)]);
      await runMigrations(database);
    } finally {
      await second.sql.end({ timeout: 5 });
    }
    const applied = await database.sql<{ count: string }[]>`
      select count(*)::text as count from drizzle.__drizzle_migrations`;
    // One row per migration in the journal, however many times migrations ran.
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    expect(applied[0]?.count).toBe(String(journal.entries.length));
    const extensions = await database.sql<{ extname: string }[]>`
      select extname from pg_extension where extname = 'citext'`;
    expect(extensions).toHaveLength(1);
  });

  it('creates the bucket once and tolerates repeated or concurrent calls', async () => {
    await Promise.all([
      ensureBucket(s3, config.S3_BUCKET),
      ensureBucket(createS3Client(config), config.S3_BUCKET),
    ]);
    await ensureBucket(s3, config.S3_BUCKET);
    await expect(headBucket(s3, config.S3_BUCKET)).resolves.toBeUndefined();
    const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets.filter((bucket) => bucket.Name === config.S3_BUCKET)).toHaveLength(1);
  });

  it('rejects wrong storage credentials', async () => {
    const intruder = createS3Client({ ...config, S3_SECRET_ACCESS_KEY: 'wrong-secret-value' });
    await expect(headBucket(intruder, config.S3_BUCKET)).rejects.toThrow();
    intruder.destroy();
  });

  it('is ready when every dependency answers, and not ready when one stops', async () => {
    const app = buildApp({
      logger: createLogger({ service: 'api', level: 'silent' }),
      version: 'test',
      probes: {
        postgres: () => database.sql`select 1`,
        valkey: () => redis.ping(),
        storage: () => headBucket(s3, config.S3_BUCKET),
      },
    });
    try {
      const ready = await app.inject('/api/health/ready');
      expect(ready.statusCode).toBe(200);
      expect(healthResponse.parse(ready.json()).checks).toMatchObject({
        postgres: { status: 'ok' },
        valkey: { status: 'ok' },
        storage: { status: 'ok' },
      });

      await valkey.stop();
      const degraded = await app.inject('/api/health/ready');
      expect(degraded.statusCode).toBe(503);
      expect(healthResponse.parse(degraded.json()).checks).toMatchObject({
        postgres: { status: 'ok' },
        valkey: { status: 'error' },
      });
    } finally {
      await app.close();
    }
  });
});

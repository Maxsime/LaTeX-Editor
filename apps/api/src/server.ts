import { ConfigError } from '@galley/shared';
import { createLogger, readPackageVersion } from '@galley/shared/node';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createS3Client, ensureBucket, headBucket } from './storage/s3.js';

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: 'api', level: config.LOG_LEVEL });
  const version = readPackageVersion(import.meta.url);

  const database = createDatabase(config.DATABASE_URL);
  const redis = new Redis(config.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const s3 = createS3Client(config);

  await runMigrations(database);
  logger.info('database migrations applied');
  await ensureBucket(s3, config.S3_BUCKET);
  logger.info({ bucket: config.S3_BUCKET }, 'object storage bucket ready');
  await redis.connect();

  const app = buildApp({
    logger,
    version,
    probes: {
      postgres: () => database.sql`select 1`,
      valkey: () => redis.ping(),
      storage: () => headBucket(s3, config.S3_BUCKET),
    },
  });

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => Promise.allSettled([database.sql.end({ timeout: 5 }), redis.quit()]))
      .then(() => {
        s3.destroy();
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  logger.info({ version }, 'api started');
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // The logger depends on the configuration, so report it on stderr directly.
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(
      `api failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
  process.exit(1);
});

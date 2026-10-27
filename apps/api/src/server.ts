import { COMPILE_QUEUE, type CompileJob, ConfigError, SYNCTEX_QUEUE } from '@galley/shared';
import { Queue, QueueEvents } from 'bullmq';
import { createLogger, readPackageVersion } from '@galley/shared/node';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createDocumentGateway } from './collab/documents.js';
import { followCompileEvents } from './compile/service.js';
import { createSynctexClient } from './compile/synctex.js';
import { ensureSetupCode } from './auth/setup.js';
import { countUsers } from './auth/users.js';
import { readConfig } from './config.js';
import { createDatabase, runMigrations } from '@galley/db';
import { startMaintenance } from './projects/purge.js';
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

  if ((await countUsers(database.db)) === 0) {
    const { code } = await ensureSetupCode(redis);
    // Printed on every start until the first account exists: the operator reads it from the logs.
    logger.warn(
      { setupCode: code },
      'no account yet: open Galley and create the administrator with this setup code',
    );
  }
  // BullMQ needs a connection that retries forever; it must not share the request one.
  const queueRedis = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: null });
  const compileQueue = new Queue<CompileJob, unknown>(COMPILE_QUEUE, { connection: queueRedis });
  // QueueEvents blocks on its connection, so it gets its own.
  const compileEvents = new QueueEvents(COMPILE_QUEUE, {
    connection: { url: config.VALKEY_URL, maxRetriesPerRequest: null },
  });

  const synctexQueue = new Queue(SYNCTEX_QUEUE, { connection: queueRedis });
  const synctexEvents = new QueueEvents(SYNCTEX_QUEUE, {
    connection: { url: config.VALKEY_URL, maxRetriesPerRequest: null },
  });

  const context = {
    config,
    database,
    redis,
    s3,
    documents: createDocumentGateway(config, database, logger),
    compileQueue,
    synctex: createSynctexClient(synctexQueue, synctexEvents),
  };
  followCompileEvents(context, compileEvents, logger);
  const stopMaintenance = await startMaintenance(context, queueRedis, logger);

  const app = buildApp({
    logger,
    version,
    context,
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
      .then(stopMaintenance)
      .then(() =>
        Promise.allSettled([
          compileEvents.close(),
          compileQueue.close(),
          synctexEvents.close(),
          synctexQueue.close(),
        ]),
      )
      .then(() =>
        Promise.allSettled([database.sql.end({ timeout: 5 }), redis.quit(), queueRedis.quit()]),
      )
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

import { ConfigError } from '@galley/shared';
import { createLogger, readPackageVersion } from '@galley/shared/node';
import { Redis } from 'ioredis';
import { createDatabase } from '@galley/db';
import { createCollab } from './collab.js';
import { readConfig } from './config.js';

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: 'collab', level: config.LOG_LEVEL });
  const version = readPackageVersion(import.meta.url);
  const redis = new Redis(config.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();

  const database = createDatabase(config.DATABASE_URL);
  const collab = createCollab({ config, logger, version, database, redis });

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    collab
      .destroy()
      .then(() => database.sql.end({ timeout: 5 }))
      .then(() => redis.quit())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await collab.listen();
  logger.info({ version, port: collab.server.address.port }, 'collab started');
}

main().catch((error: unknown) => {
  const detail = error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`collab failed to start: ${detail}\n`);
  process.exit(1);
});

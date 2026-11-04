import { ConfigError } from '@galley/shared';
import {
  createLogger,
  handleProcessLifecycle,
  logConnectionErrors,
  readPackageVersion,
} from '@galley/shared/node';
import { Redis } from 'ioredis';
import { createDatabase } from '@galley/db';
import { createCollab } from './collab.js';
import { readConfig } from './config.js';

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: 'collab', level: config.LOG_LEVEL });
  const version = readPackageVersion(import.meta.url);
  const redis = new Redis(config.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  logConnectionErrors(logger, 'valkey', redis);
  await redis.connect();

  const database = createDatabase(config.DATABASE_URL);
  const collab = createCollab({ config, logger, version, database, redis });

  handleProcessLifecycle({
    logger,
    close: async () => {
      await collab.destroy();
      await database.sql.end({ timeout: 5 });
      await redis.quit();
    },
  });

  await collab.listen();
  logger.info({ version, port: collab.server.address.port }, 'collab started');
}

main().catch((error: unknown) => {
  const detail = error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`collab failed to start: ${detail}\n`);
  process.exit(1);
});

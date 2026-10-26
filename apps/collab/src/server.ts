import { ConfigError } from '@galley/shared';
import { createLogger, readPackageVersion } from '@galley/shared/node';
import { Redis } from 'ioredis';
import { createCollabServer } from './collab.js';
import { readConfig } from './config.js';

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: 'collab', level: config.LOG_LEVEL });
  const version = readPackageVersion(import.meta.url);
  const redis = new Redis(config.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();

  const server = createCollabServer({ config, logger, version, redis });

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    server
      .destroy()
      .then(() => redis.quit())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await server.listen();
  logger.info({ version, port: server.address.port }, 'collab started');
}

main().catch((error: unknown) => {
  const detail = error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`collab failed to start: ${detail}\n`);
  process.exit(1);
});

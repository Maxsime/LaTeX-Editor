import { ConfigError } from '@galley/shared';
import { createLogger, readPackageVersion } from '@galley/shared/node';
import { readConfig } from './config.js';
import { createCompilerService } from './worker.js';

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: 'compiler', level: config.LOG_LEVEL });
  const version = readPackageVersion(import.meta.url);
  const service = createCompilerService(config, logger, version);

  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    service
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await service.worker.waitUntilReady();
  await new Promise<void>((resolve) => {
    service.probeServer.listen(config.COMPILER_HEALTH_PORT, '0.0.0.0', resolve);
  });
  logger.info({ version, concurrency: config.COMPILER_CONCURRENCY }, 'compiler started');
}

main().catch((error: unknown) => {
  const detail = error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`compiler failed to start: ${detail}\n`);
  process.exit(1);
});

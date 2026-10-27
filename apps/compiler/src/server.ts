import { ConfigError } from '@galley/shared';
import { createLogger, readPackageVersion } from '@galley/shared/node';
import { readConfig } from './config.js';
import { checkSandbox } from './sandbox.js';
import { createS3Client, putOutput, readBlob, readOutput } from './storage.js';
import { detectTexLive } from './texlive.js';
import { createCompilerService } from './worker.js';

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ service: 'compiler', level: config.LOG_LEVEL });
  const version = readPackageVersion(import.meta.url);
  // Refuse to start rather than accept jobs that would all fail.
  await checkSandbox();
  const texlive = await detectTexLive();
  const s3 = createS3Client(config);
  const service = createCompilerService(config, logger, version, {
    texlive,
    fetchBlob: (hash) => readBlob(s3, config.S3_BUCKET, hash),
    fetchOutput: (compileId, name) => readOutput(s3, config.S3_BUCKET, compileId, name),
    publish: (compileId, name, body, size) =>
      putOutput(s3, config.S3_BUCKET, compileId, name, body, size),
  });

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
  logger.info(
    { version, texlive: texlive.release, concurrency: config.COMPILER_CONCURRENCY },
    'compiler started',
  );
}

main().catch((error: unknown) => {
  const detail =
    error instanceof ConfigError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`compiler failed to start: ${detail}\n`);
  process.exit(1);
});

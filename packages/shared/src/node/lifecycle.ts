import type { Logger } from 'pino';

/** Anything that reports failures through an `error` event: ioredis clients, BullMQ queues. */
export interface ErrorEmitter {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** How long the same connection error stays silent after it was logged once. */
export const CONNECTION_ERROR_QUIET_MS = 30_000;

/**
 * Logs the `error` events of a connection that reconnects by itself.
 *
 * Without a listener, ioredis and BullMQ print these errors on the console, outside the
 * structured logs, at every reconnection attempt. The same message is logged at most once
 * per {@link CONNECTION_ERROR_QUIET_MS}, so that a Valkey outage does not flood the logs.
 */
export function logConnectionErrors(
  logger: Logger,
  connection: string,
  emitter: ErrorEmitter,
  now: () => number = Date.now,
): void {
  const lastLogged = new Map<string, number>();
  emitter.on('error', (error) => {
    const time = now();
    const previous = lastLogged.get(error.message);
    if (previous !== undefined && time - previous < CONNECTION_ERROR_QUIET_MS) return;
    lastLogged.set(error.message, time);
    logger.warn({ err: error, connection }, 'connection error, retrying');
  });
}

/** Settings of {@link handleProcessLifecycle}. */
export interface LifecycleSettings {
  logger: Logger;
  /** Releases the service's resources; the process exits once it settles. */
  close: () => Promise<unknown>;
  /** Exit code 1 after this delay if `close` has not settled. Docker kills at 10 s. */
  timeoutMs?: number;
  /** Replaced in tests. */
  exit?: (code: number) => void;
  /** Replaced in tests. */
  target?: NodeJS.EventEmitter;
}

/** Default shutdown deadline, under the 10 s Docker waits before SIGKILL. */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

/**
 * Wires the process signals and fatal errors of a service.
 *
 * SIGTERM and SIGINT run `close` once, then exit 0, or 1 if it fails or outlasts the
 * deadline: a stuck connection must not keep a half-stopped process alive. An uncaught
 * exception or unhandled rejection leaves the process in an unknown state, so it is logged
 * and the process exits 1 without a graceful close; the restart policy brings it back.
 */
export function handleProcessLifecycle({
  logger,
  close,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  exit = (code) => process.exit(code),
  target = process,
}: LifecycleSettings): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => {
      logger.error({ timeoutMs }, 'shutdown timed out');
      exit(1);
    }, timeoutMs);
    // The deadline alone must not keep an otherwise finished process alive.
    deadline.unref();
    close()
      .then(() => {
        clearTimeout(deadline);
        exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(deadline);
        logger.error({ err: error }, 'shutdown failed');
        exit(1);
      });
  };
  target.on('SIGTERM', shutdown);
  target.on('SIGINT', shutdown);
  target.on('uncaughtException', (error: unknown) => {
    logger.fatal({ err: error }, 'uncaught exception');
    exit(1);
  });
  target.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    exit(1);
  });
}

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const RELEASE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

/**
 * Runs `task` while holding a Valkey lock, so that API instances serialise
 * work on one key. A caller waits for the lock rather than failing; the lock
 * expires after `ttlMs` in case its holder dies.
 */
export async function withLock<T>(
  redis: Redis,
  key: string,
  task: () => Promise<T>,
  ttlMs = 60_000,
): Promise<T> {
  const owner = randomUUID();
  const deadline = Date.now() + ttlMs;
  while ((await redis.set(key, owner, 'PX', ttlMs, 'NX')) !== 'OK') {
    if (Date.now() > deadline) throw new Error(`lock ${key} not released`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    return await task();
  } finally {
    // Release only our own lock, in case it expired and someone else took it.
    await redis.eval(RELEASE, 1, key, owner);
  }
}

import type { Redis } from 'ioredis';

/** Failed sign-ins an account may receive, from all addresses together, per window. */
export const MAX_ACCOUNT_FAILURES = 50;
/** Window of {@link MAX_ACCOUNT_FAILURES}, and how long an account stays paused. */
export const ACCOUNT_FAILURE_WINDOW_SECONDS = 15 * 60;

const PREFIX = 'galley:login-failures:';

/**
 * Key of the failure counter of a sign-in name. An unknown name is counted
 * like an account, so that the pause does not tell which names exist.
 */
function keyOf(login: string): string {
  return `${PREFIX}${login.trim().toLowerCase().slice(0, 320)}`;
}

/**
 * Failed sign-ins counted per account across every address. The per-address
 * limit stops one machine; this stops a password guessing run spread over
 * many addresses, at the price of pausing the account for everyone, its
 * owner included, until the window ends.
 */
export class LoginThrottle {
  constructor(private readonly redis: Redis) {}

  /** Whether sign-in to these names is paused. */
  async paused(names: readonly string[]): Promise<boolean> {
    const counts = await this.redis.mget(names.map(keyOf));
    return counts.some((count) => Number(count ?? 0) >= MAX_ACCOUNT_FAILURES);
  }

  /** Counts a failure against every name of the account; the window starts at the first one. */
  async failed(names: readonly string[]): Promise<void> {
    const batch = this.redis.multi();
    for (const name of names) {
      batch.incr(keyOf(name)).expire(keyOf(name), ACCOUNT_FAILURE_WINDOW_SECONDS, 'NX');
    }
    await batch.exec();
  }

  /** Forgets the failures of an account once its owner signs in. */
  async succeeded(names: readonly string[]): Promise<void> {
    await this.redis.del(...names.map(keyOf));
  }
}

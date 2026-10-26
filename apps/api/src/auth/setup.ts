import type { Redis } from 'ioredis';
import { randomToken, safeEqual } from './tokens.js';

const SETUP_CODE_KEY = 'galley:setup-code';

/**
 * Returns the one-time code that authorises creating the first administrator,
 * creating it if needed. It is shared through Valkey so that every API
 * instance accepts the same code; `created` tells the caller to print it.
 */
export async function ensureSetupCode(redis: Redis): Promise<{ code: string; created: boolean }> {
  const candidate = randomToken(12);
  const created = (await redis.set(SETUP_CODE_KEY, candidate, 'NX')) === 'OK';
  if (created) return { code: candidate, created };
  const existing = await redis.get(SETUP_CODE_KEY);
  return { code: existing ?? candidate, created: existing === null };
}

export async function checkSetupCode(redis: Redis, code: string): Promise<boolean> {
  const expected = await redis.get(SETUP_CODE_KEY);
  return expected !== null && safeEqual(expected, code);
}

export async function clearSetupCode(redis: Redis): Promise<void> {
  await redis.del(SETUP_CODE_KEY);
}

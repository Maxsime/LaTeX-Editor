import { randomBytes, timingSafeEqual } from 'node:crypto';

// The digest lives with the session lookup it must match; re-exported for invite tokens.
export { tokenDigest } from '@galley/db';

/** 256-bit random token, URL-safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison for secrets of equal or differing length. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

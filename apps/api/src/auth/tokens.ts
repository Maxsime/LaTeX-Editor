import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, URL-safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Digest stored in place of a token, so a database leak does not leak live tokens. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison for secrets of equal or differing length. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

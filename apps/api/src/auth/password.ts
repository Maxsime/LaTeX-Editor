import { type Algorithm, hash, verify } from '@node-rs/argon2';

// `Algorithm` is an ambient const enum, unusable as a value under verbatimModuleSyntax;
// 2 is `Algorithm.Argon2id`.
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- see above
const ARGON2ID: Algorithm = 2;

// OWASP minimum for argon2id: 19 MiB, 2 iterations, 1 lane.
const options = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Hashes a password with argon2id; the result embeds salt and parameters. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

/** Verifies a password; a malformed stored hash counts as a mismatch. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real verification, so that a login attempt for an
 * unknown account cannot be told apart from a wrong password by its latency.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('galley-dummy-password');
  await verifyPassword(await dummyHash, password);
  return false;
}

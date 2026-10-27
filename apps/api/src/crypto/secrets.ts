import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError } from '@galley/shared';

/** Format version, first byte of every ciphertext, so the scheme can change later. */
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypts and decrypts the secrets users store (SPEC §6.8, CLAUDE.md): AES-256-GCM. */
export interface SecretBox {
  /**
   * @param context Bound to the ciphertext (e.g. `zotero:<userId>`): a value
   * copied to another user's row or another purpose does not decrypt.
   */
  seal(plaintext: string, context: string): Buffer;
  open(ciphertext: Uint8Array, context: string): string;
}

/** The secret box of the master key, or null when the instance has none. */
export function createSecretBox(masterKey: string | undefined): SecretBox | null {
  if (masterKey === undefined) return null;
  const key = Buffer.from(masterKey, 'base64');
  if (key.length !== 32) throw new Error('GALLEY_MASTER_KEY must be 32 bytes');
  return {
    seal(plaintext, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]);
    },
    open(ciphertext, context) {
      const data = Buffer.from(ciphertext);
      if (data[0] !== VERSION || data.length < 1 + NONCE_BYTES + TAG_BYTES) {
        throw new Error('unknown secret format');
      }
      const nonce = data.subarray(1, 1 + NONCE_BYTES);
      const tag = data.subarray(data.length - TAG_BYTES);
      const body = data.subarray(1 + NONCE_BYTES, data.length - TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

/** The secret box, or SECRETS_UNAVAILABLE for a route that needs one. */
export function requireSecretBox(box: SecretBox | null): SecretBox {
  if (box === null) throw new ApiError('SECRETS_UNAVAILABLE');
  return box;
}

/** Last four characters of a key, the only part ever shown again (CLAUDE.md). */
export function keyHint(secret: string): string {
  return secret.slice(-4);
}

import { describe, expect, it } from 'vitest';
import { createSecretBox, keyHint } from './secrets.js';

const box = createSecretBox(Buffer.alloc(32, 3).toString('base64'));

describe('secret box', () => {
  it('round-trips, with a fresh nonce each time', () => {
    if (box === null) throw new Error('no box');
    const a = box.seal('P9xQ2mT7wL4kZ8vB1nC6dF3h', 'zotero:u1');
    const b = box.seal('P9xQ2mT7wL4kZ8vB1nC6dF3h', 'zotero:u1');
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('P9xQ2mT7'))).toBe(false);
    expect(box.open(a, 'zotero:u1')).toBe('P9xQ2mT7wL4kZ8vB1nC6dF3h');
  });

  it('refuses a ciphertext moved to another context or tampered with', () => {
    if (box === null) throw new Error('no box');
    const sealed = box.seal('secret', 'zotero:u1');
    expect(() => box.open(sealed, 'zotero:u2')).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(() => box.open(tampered, 'zotero:u1')).toThrow();
  });

  it('is absent without a master key, and hints show four characters', () => {
    expect(createSecretBox(undefined)).toBeNull();
    expect(keyHint('abcdefgh')).toBe('efgh');
  });
});

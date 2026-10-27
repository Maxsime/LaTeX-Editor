import { describe, expect, it } from 'vitest';
import { isObjectKey } from './objects.js';

describe('isObjectKey', () => {
  it.each(['blobs/ab12', 'compiles/0f/output.pdf', 'snippets/x-y_z.pdf'])('accepts %j', (key) => {
    expect(isObjectKey(key)).toBe(true);
  });

  it.each(['', '/blobs/a', 'blobs//a', '../a', 'blobs/../../a', 'a/./b', 'a b', 'é'])(
    'refuses %j',
    (key) => {
      expect(isObjectKey(key)).toBe(false);
    },
  );
});

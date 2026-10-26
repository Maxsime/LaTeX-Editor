import { describe, expect, it } from 'vitest';
import { decodeText } from '../files/classify.js';
import { stateToText, textBytes, textToState } from './text.js';

describe('Yjs text round trip', () => {
  it.each([
    ['empty', new Uint8Array()],
    ['CRLF without final newline', new TextEncoder().encode('a\r\nb')],
    ['BOM', new Uint8Array([0xef, 0xbb, 0xbf, 0x5c, 0x6f])],
    ['astral characters', new TextEncoder().encode('𝔼 = mc² 🎉\n')],
    ['lone CR', new TextEncoder().encode('a\rb\r')],
  ])('restores the exact bytes: %s', (_label, bytes) => {
    const content = decodeText('file.tex', bytes);
    expect(content).not.toBeNull();
    const restored = textBytes(stateToText(textToState(content ?? '')));
    expect(Buffer.from(restored).equals(Buffer.from(bytes))).toBe(true);
  });
});

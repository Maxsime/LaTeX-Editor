import { describe, expect, it } from 'vitest';
import { readPdfMessage } from './pdf-window.js';

describe('readPdfMessage', () => {
  it('accepts the channel messages and ignores anything else', () => {
    expect(readPdfMessage({ type: 'hello' })).toEqual({ type: 'hello' });
    expect(readPdfMessage({ type: 'synctex', page: 2, x: 10, y: 20 })).toEqual({
      type: 'synctex',
      page: 2,
      x: 10,
      y: 20,
    });
    expect(readPdfMessage({ type: 'pdf', url: 1 })).toBeNull();
    expect(readPdfMessage('hello')).toBeNull();
  });
});

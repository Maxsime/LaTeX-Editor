import { describe, expect, it } from 'vitest';
import { decodeText, hasTextName, MAX_TEXT_BYTES, sha256 } from './classify.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('hasTextName', () => {
  it.each(['main.tex', 'refs.BIB', 'synthese.cls', 'latexmkrc', 'data.csv', 'Makefile'])(
    'treats %j as text',
    (name) => {
      expect(hasTextName(name)).toBe(true);
    },
  );

  it.each(['figure.png', 'logo.pdf', 'archive.zip', 'noextension', 'font.otf'])(
    'treats %j as binary',
    (name) => {
      expect(hasTextName(name)).toBe(false);
    },
  );
});

describe('decodeText', () => {
  it('decodes UTF-8 text and keeps the BOM and CRLF', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('é\r\n')]);
    expect(decodeText('a.tex', bytes)).toBe('\uFEFFé\r\n');
  });

  it('keeps Latin-1 content as binary', () => {
    expect(decodeText('old.tex', new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBeNull();
  });

  it('keeps content with NUL bytes as binary', () => {
    expect(decodeText('a.tex', new Uint8Array([0x61, 0x00]))).toBeNull();
  });

  it('keeps oversized text as binary', () => {
    expect(decodeText('big.tex', new Uint8Array(MAX_TEXT_BYTES + 1).fill(0x61))).toBeNull();
  });

  it('ignores the content of files with a binary name', () => {
    expect(decodeText('figure.png', utf8('plain'))).toBeNull();
  });
});

describe('sha256', () => {
  it('returns the lowercase hex digest', () => {
    expect(sha256(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

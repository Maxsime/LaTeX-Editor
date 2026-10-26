import { describe, expect, it } from 'vitest';
import {
  checkDeclaredSize,
  checkEntryType,
  checkPathCollisions,
  parseEntryPath,
  stripCommonRoot,
} from './entries.js';
import { ArchiveError, DEFAULT_ARCHIVE_LIMITS as limits } from './limits.js';

const UNIX = 3 << 8;
const mode = (bits: number): number => (bits << 16) >>> 0;

function reason(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof ArchiveError) return error.reason;
    throw error;
  }
  return undefined;
}

describe('parseEntryPath', () => {
  it('splits files and directories', () => {
    expect(parseEntryPath('chapitres/intro.tex', limits)).toEqual({
      segments: ['chapitres', 'intro.tex'],
      isDirectory: false,
    });
    expect(parseEntryPath('figures/', limits)).toEqual({
      segments: ['figures'],
      isDirectory: true,
    });
  });

  it.each(['../evil.tex', 'a/../../evil', '/etc/passwd', 'C:/x.tex', 'c:x', 'a\\..\\b', './a'])(
    'refuses the unsafe path %j',
    (name) => {
      expect(reason(() => parseEntryPath(name, limits))).toBe('UNSAFE_PATH');
    },
  );

  it.each(['a//b', 'bad\u0001name', ' a.tex'])('refuses the invalid name %j', (name) => {
    expect(reason(() => parseEntryPath(name, limits))).toBe('INVALID_NAME');
  });

  it('skips archiver noise', () => {
    expect(parseEntryPath('__MACOSX/._main.tex', limits)).toBeNull();
    expect(parseEntryPath('figures/.DS_Store', limits)).toBeNull();
  });

  it('bounds the depth', () => {
    const deep = `${Array(limits.maxDepth).fill('d').join('/')}/f.tex`;
    expect(reason(() => parseEntryPath(deep, limits))).toBe('TOO_DEEP');
  });
});

describe('checkEntryType', () => {
  it('accepts plain files and directories', () => {
    expect(() => {
      checkEntryType(UNIX, mode(0o100644), 'a');
    }).not.toThrow();
    expect(() => {
      checkEntryType(UNIX, mode(0o040755), 'd/');
    }).not.toThrow();
    expect(() => {
      checkEntryType(0, 0x20, 'dos');
    }).not.toThrow();
  });

  it('refuses symbolic links and special files', () => {
    expect(reason(() => checkEntryType(UNIX, mode(0o120777), 'link'))).toBe('SYMLINK');
    expect(reason(() => checkEntryType(UNIX, mode(0o060644), 'dev'))).toBe('SPECIAL_FILE');
  });
});

describe('checkDeclaredSize', () => {
  it('refuses oversized and over-compressed entries', () => {
    expect(
      reason(() => checkDeclaredSize(limits.maxFileBytes + 1, limits.maxFileBytes, 'a', limits)),
    ).toBe('TOO_LARGE');
    expect(reason(() => checkDeclaredSize(50 * 1024 * 1024, 1000, 'a', limits))).toBe(
      'COMPRESSION_RATIO',
    );
  });

  it('tolerates high ratios on small entries', () => {
    expect(reason(() => checkDeclaredSize(500_000, 100, 'a', limits))).toBeUndefined();
  });
});

describe('stripCommonRoot', () => {
  const entry = (path: string, isDirectory = false) => ({
    segments: path.split('/'),
    isDirectory,
  });

  it('drops a folder wrapping every entry', () => {
    const stripped = stripCommonRoot([entry('projet', true), entry('projet/main.tex')]);
    expect(stripped.map((item) => item.segments.join('/'))).toEqual(['main.tex']);
  });

  it('keeps several root items', () => {
    const entries = [entry('main.tex'), entry('figures/a.png')];
    expect(stripCommonRoot(entries)).toEqual(entries);
  });

  it('keeps a lone root file', () => {
    const entries = [entry('main.tex')];
    expect(stripCommonRoot(entries)).toEqual(entries);
  });
});

describe('checkPathCollisions', () => {
  const entry = (path: string, isDirectory = false) => ({
    segments: path.split('/'),
    isDirectory,
  });

  it('refuses duplicate files and files standing in for folders', () => {
    expect(reason(() => checkPathCollisions([entry('a.tex'), entry('a.tex')]))).toBe(
      'DUPLICATE_PATH',
    );
    expect(reason(() => checkPathCollisions([entry('a'), entry('a/b.tex')]))).toBe(
      'DUPLICATE_PATH',
    );
  });

  it('accepts explicit directory entries alongside their files', () => {
    expect(checkPathCollisions([entry('d', true), entry('d/a.tex'), entry('d', true)])).toEqual([]);
  });

  it('warns about names differing only by case', () => {
    expect(checkPathCollisions([entry('Fig.png'), entry('fig.png')])).toEqual([
      { code: 'CASE_CONFLICT', path: 'fig.png' },
    ]);
  });
});

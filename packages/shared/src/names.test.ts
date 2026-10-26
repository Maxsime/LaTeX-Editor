import { describe, expect, it } from 'vitest';
import { isValidFileName, MAX_PATH_DEPTH, splitProjectPath } from './names.js';

describe('isValidFileName', () => {
  it.each(['main.tex', 'Chapitre 1.tex', 'été.bib', '.latexmkrc', 'a'.repeat(255)])(
    'accepts %j',
    (name) => {
      expect(isValidFileName(name)).toBe(true);
    },
  );

  it.each([
    '',
    '.',
    '..',
    'a/b',
    'a\\b',
    'nul\0byte',
    'line\nbreak',
    'bell\u0007',
    ' leading',
    'trailing ',
    'a'.repeat(256),
    'é'.repeat(128),
  ])('refuses %j', (name) => {
    expect(isValidFileName(name)).toBe(false);
  });
});

describe('splitProjectPath', () => {
  it('splits a relative path into segments', () => {
    expect(splitProjectPath('chapitres/intro.tex')).toEqual(['chapitres', 'intro.tex']);
  });

  it.each(['/etc/passwd', '../x', 'a//b', 'a/./b', 'a/'])('refuses %j', (path) => {
    expect(splitProjectPath(path)).toBeNull();
  });

  it('bounds the depth', () => {
    expect(splitProjectPath(Array(MAX_PATH_DEPTH).fill('d').join('/'))).not.toBeNull();
    expect(
      splitProjectPath(
        Array(MAX_PATH_DEPTH + 1)
          .fill('d')
          .join('/'),
      ),
    ).toBeNull();
  });
});

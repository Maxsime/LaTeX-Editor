import { describe, expect, it } from 'vitest';
import { EXPLANATION_CODES } from '@galley/latex-log';
import { errorCodes } from '@galley/shared';
import en from './locales/en.json';
import fr from './locales/fr.json';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('translation catalogues', () => {
  it('define the same keys in French and English', () => {
    expect(keys(en).sort()).toEqual(keys(fr).sort());
  });

  it('translate every API error code', () => {
    for (const code of errorCodes) {
      expect(fr.errors[code]).toBeTruthy();
      expect(en.errors[code]).toBeTruthy();
    }
  });

  it('explain every known LaTeX error', () => {
    for (const code of EXPLANATION_CODES) {
      expect(fr.compile.explain[code]).toBeTruthy();
      expect(en.compile.explain[code]).toBeTruthy();
    }
  });
});

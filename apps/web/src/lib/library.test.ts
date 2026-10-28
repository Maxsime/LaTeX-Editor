import { describe, expect, it } from 'vitest';
import { copyName, nameFromUrl, templateChoice } from './library.js';

describe('nameFromUrl', () => {
  it('takes the last segment of the path', () => {
    expect(nameFromUrl('https://example.org/data/refs.bib')).toBe('refs.bib');
    expect(nameFromUrl('https://example.org/files/My%20figure.pdf?raw=1')).toBe('My figure.pdf');
  });

  it('gives nothing for a bare host or an invalid URL', () => {
    expect(nameFromUrl('https://example.org/')).toBe('');
    expect(nameFromUrl('not a url')).toBe('');
  });
});

describe('copyName', () => {
  it('appends the suffix within the length limit', () => {
    expect(copyName('Thèse', 'copie')).toBe('Thèse (copie)');
    expect(copyName('x'.repeat(149), 'copie')).toHaveLength(150);
  });
});

describe('templateChoice', () => {
  it('tells built-in and saved templates apart', () => {
    expect(templateChoice('beamer')).toEqual({ template: 'beamer' });
    expect(templateChoice('saved:0b5c7a1e-0000-4000-8000-000000000001')).toEqual({
      templateId: '0b5c7a1e-0000-4000-8000-000000000001',
    });
    expect(templateChoice('unknown')).toEqual({ template: 'blank' });
  });
});

import { describe, expect, it } from 'vitest';
import { releaseFromBanner } from './texlive.js';

describe('releaseFromBanner', () => {
  it('reads the release from the tex banner', () => {
    expect(releaseFromBanner('TeX 3.141592653 (TeX Live 2026)\nkpathsea version 6.4.2')).toBe(
      'TeX Live 2026',
    );
    expect(releaseFromBanner('TeX 3.14 (TeX Live 2025/Debian)')).toBe('TeX Live 2025/Debian');
    expect(releaseFromBanner('something else')).toBe('TeX Live');
  });
});

import { describe, expect, it } from 'vitest';
import { detectLanguage } from './language.js';

describe('detectLanguage', () => {
  it('reads the last babel language, or main=', () => {
    expect(detectLanguage('\\usepackage[english,french]{babel}')).toBe('fr');
    expect(detectLanguage('\\usepackage[main=english,french]{babel}')).toBe('en-US');
    expect(detectLanguage('\\usepackage[british]{babel}')).toBe('en-GB');
  });

  it('takes languages given to the document class', () => {
    expect(detectLanguage('\\documentclass[a4paper,ngerman]{article}\n\\usepackage{babel}')).toBe(
      'de-DE',
    );
  });

  it('reads polyglossia', () => {
    expect(detectLanguage('\\usepackage{polyglossia}\n\\setdefaultlanguage{french}')).toBe('fr');
    expect(detectLanguage('\\setmainlanguage[variant=british]{english}')).toBe('en-GB');
  });

  it('returns null when nothing is said, or only after the preamble', () => {
    expect(detectLanguage('\\documentclass{article}\\begin{document}x\\end{document}')).toBeNull();
    expect(detectLanguage('% \\usepackage[french]{babel}')).toBeNull();
    expect(detectLanguage('\\usepackage[french]{csquotes}')).toBeNull();
  });
});

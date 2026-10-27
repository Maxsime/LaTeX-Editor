import { describe, expect, it } from 'vitest';
import { katexMacros, mathAt } from './math.js';

const at = (text: string, marker = '|') => {
  const position = text.indexOf(marker);
  return mathAt(text.replace(marker, ''), position);
};

describe('mathAt', () => {
  it('finds inline and display formulas around the cursor', () => {
    expect(at('Soit $x^|2$ ici')).toMatchObject({ from: 5, to: 10, tex: 'x^2', display: false });
    expect(at('a $$\\int| f$$ b')).toMatchObject({ tex: '\\int f', display: true });
    expect(at('\\(a|+b\\)')).toMatchObject({ tex: 'a+b', display: false });
    expect(at('\\[ e^{i\\pi}| \\]')).toMatchObject({ tex: 'e^{i\\pi}', display: true });
  });

  it('ignores text outside formulas, comments and escaped dollars', () => {
    expect(at('$a$ te|xt $b$')).toBeNull();
    expect(at('% $x\n tex|t $y$')).toBeNull();
    expect(at('5 \\$ and 6 \\$ he|re')).toBeNull();
    expect(at('$a$\n\nnot |closed $')).toBeNull();
  });

  it('turns display environments into what KaTeX renders', () => {
    expect(at('\\begin{align*}\na &= b|\\label{x} \\\\\n\\end{align*}')?.tex).toBe(
      '\\begin{aligned}a &= b \\\\\\end{aligned}',
    );
    expect(at('\\begin{equation}\\label{e} E=mc|^2\\end{equation}')?.tex).toBe('E=mc^2');
    expect(at('\\begin{alignat}{2} a &= |b \\end{alignat}')?.tex).toBe(
      '\\begin{alignedat}{2}a &= b\\end{alignedat}',
    );
  });
});

describe('katexMacros', () => {
  it('keeps the definitions KaTeX can use', () => {
    expect(
      katexMacros([
        { name: 'R', definition: '\\mathbb{R}' },
        { name: 'opt' },
        { name: 'my@internal', definition: 'x' },
      ]),
    ).toEqual({ '\\R': '\\mathbb{R}' });
  });
});

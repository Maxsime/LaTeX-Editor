import { describe, expect, it } from 'vitest';
import { fragmentAt } from './fragment.js';

const TEXT = String.raw`\begin{document}
Du texte et $a^2 + b^2$ ici.
\begin{figure}
  \begin{tikzpicture}
    \draw (0,0) -- (1,1);
  \end{tikzpicture}
  \caption{Un trait}
\end{figure}
\end{document}
`;

describe('fragmentAt', () => {
  it('takes the selection when there is one', () => {
    const from = TEXT.indexOf('Du texte');
    expect(fragmentAt(TEXT, from, from + 8)).toBe('Du texte');
    expect(fragmentAt(TEXT, from - 1, from)).toBeNull();
  });

  it('takes the innermost environment or formula around the cursor', () => {
    const inDraw = TEXT.indexOf('\\draw');
    expect(fragmentAt(TEXT, inDraw, inDraw)).toBe(
      '\\begin{tikzpicture}\n    \\draw (0,0) -- (1,1);\n  \\end{tikzpicture}',
    );
    const inCaption = TEXT.indexOf('Un trait');
    expect(fragmentAt(TEXT, inCaption, inCaption)?.startsWith('\\begin{figure}')).toBe(true);
    const inMath = TEXT.indexOf('b^2');
    expect(fragmentAt(TEXT, inMath, inMath)).toBe('$a^2 + b^2$');
  });

  it('gives nothing in plain text, outside any environment but the document', () => {
    const inText = TEXT.indexOf('ici');
    expect(fragmentAt(TEXT, inText, inText)).toBeNull();
    expect(fragmentAt('\\begin{figure}\nnot closed', 16, 16)).toBeNull();
  });
});

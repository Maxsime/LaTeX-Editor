import { describe, expect, it } from 'vitest';
import {
  type AnnotationSegment,
  annotationSource,
  proseRanges,
  splitParagraphs,
  toAnnotation,
} from './annotation.js';

/** What LanguageTool reads: prose as is, markup as its interpretation. */
function reading(segments: readonly AnnotationSegment[]): string {
  return segments.map((s) => ('text' in s ? s.text : (s.interpretAs ?? ''))).join('');
}

function prose(source: string): string[] {
  const segments = toAnnotation(source);
  return proseRanges(segments).map(([from, to]) => source.slice(from, to));
}

describe('toAnnotation', () => {
  it('keeps the source intact, so offsets are source offsets', () => {
    const sources = [
      '\\documentclass{article}\n\\begin{document}\nLe chat dort.\n\\end{document}\n',
      'Texte $x^2$ et \\(y\\) puis \\[ z \\] fin.',
      "\\section{Intro}\\label{s} Voir \\cref{a}~\\cite[p.~2]{k}. % note\nL'\\oe uvre.",
      '\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}',
      '\\verb|x| \\unterminated{',
    ];
    for (const source of sources) expect(annotationSource(toAnnotation(source))).toBe(source);
  });

  it('skips the preamble and reads the body only', () => {
    const source =
      '\\documentclass{article}\n\\usepackage[french]{babel}\n\\title{Titre}\n\\begin{document}\nLe chat dort.\n\\end{document}\n';
    expect(prose(source).join('').trim()).toBe('Le chat dort.');
  });

  it('reads formulas, references and citations as words of the sentence', () => {
    const segments = toAnnotation(
      'Soit $x$ un réel, voir la figure~\\ref{f} et \\cite{knuth}. On a \\[ x = 1 \\] donc.',
    );
    expect(reading(segments)).toBe('Soit X un réel, voir la figure 1 et [1]. On a  X  donc.');
  });

  it('checks the prose argument of headings and emphasis, not their markup', () => {
    const source = '\\section*[court]{Un titre} Du \\emph{texte} \\textcolor{red}{rouge}.';
    expect(prose(source)).toEqual(['Un titre', ' Du ', 'texte', ' ', 'rouge', '.']);
    expect(reading(toAnnotation(source))).toBe('\n\nUn titre\n\n Du texte rouge.');
  });

  it('turns old-style accents and ligatures into letters', () => {
    const segments = toAnnotation("L'\\oe uvre \\'etait \\`a \\c{c}a, \\^{\\i}le na\\\"ive.");
    expect(reading(segments)).toBe("L'œuvre était à ça, île naïve.");
  });

  it('skips comments, verbatim and non-prose environments', () => {
    const source =
      'Avant. % commentaire\n\\begin{verbatim}\ncode faux\n\\end{verbatim}\n\\begin{tikzpicture}\\node{x};\\end{tikzpicture}\\verb|y| Après.';
    expect(prose(source).join('|')).not.toMatch(/commentaire|code|node|y\|/);
    expect(prose(source).join('')).toContain('Après.');
  });

  it('separates table cells and list items into paragraphs', () => {
    const source =
      '\\begin{itemize}\n\\item Un.\n\\item[b)] Deux.\n\\end{itemize}\n\\begin{tabular}{|l|r|}\nA & B \\\\ \\hline\nC & D\n\\end{tabular}';
    const text = reading(toAnnotation(source));
    expect(text).toContain('Un.');
    expect(text).not.toContain('b)');
    expect(text).toMatch(/A \n\n B \n\n/);
  });

  it('reads unknown macros as a noun and silent ones as nothing', () => {
    expect(reading(toAnnotation('Le \\monlogiciel{} est \\textbf{bon}\\label{x}.'))).toBe(
      'Le X est bon.',
    );
  });

  it('reads a word glued to a word macro as one term', () => {
    const source = 'Compiled with pdf\\LaTeX{} and c\\oe ur, word\\label{x}.';
    expect(reading(toAnnotation(source))).toBe('Compiled with LaTeX and cœur, word.');
    expect(prose(source).join('|')).not.toContain('pdf');
  });

  it('reads a run of unknown macros as one noun, and the text of an unclosed command', () => {
    expect(
      reading(toAnnotation('\\immediate\\write\\out{x}\n\\immediate\\closeout\\out\nFin.')),
    ).toBe('X\nFin.');
    expect(reading(toAnnotation('Avant.\n\\textbf{texte sans fin'))).toBe('Avant.\ntexte sans fin');
  });

  it('skips macro definitions entirely', () => {
    const source = '\\newcommand\\R{\\mathbb{R}}\\def\\x#1#2{a #1}Texte.';
    expect(prose(source).join('')).toBe('Texte.');
  });

  it('reads TeX quotes and dashes', () => {
    expect(reading(toAnnotation("``Bonjour'' -- dit-il --- enfin."))).toBe(
      '"Bonjour" – dit-il — enfin.',
    );
  });

  it('keeps the text of beamer frames and their titles', () => {
    const source = '\\begin{frame}{Titre}\n\\only<2>{Visible.} \\pause Fin.\n\\end{frame}';
    expect(prose(source).join('')).toMatch(/Titre.*Visible\..*Fin\./s);
  });
});

describe('splitParagraphs', () => {
  it('splits at blank lines and paragraph breaks, with source offsets', () => {
    const source = 'Premier.\n\nSecond \\emph{mot}.\n\\section{Titre}\nTroisième.';
    const paragraphs = splitParagraphs(toAnnotation(source));
    const texts = paragraphs.map((p) => annotationSource(p.segments).trim());
    expect(texts).toEqual(['Premier.', 'Second \\emph{mot}.\n\\section{', 'Titre}', 'Troisième.']);
    for (const paragraph of paragraphs) {
      const raw = annotationSource(paragraph.segments);
      expect(source.slice(paragraph.offset, paragraph.offset + raw.length)).toBe(raw);
    }
  });

  it('drops paragraphs without prose', () => {
    expect(splitParagraphs(toAnnotation('\\maketitle\n\n% rien\n\n$x$'))).toEqual([]);
  });
});

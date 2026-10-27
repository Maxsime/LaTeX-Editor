import { type Creator, parse } from '@retorquere/bibtex-parser';

/** One entry of a `.bib` file, reduced to what completion and the linter show. */
export interface BibEntry {
  key: string;
  type: string;
  title: string | null;
  /** Family names of the authors, or of the editors when there is no author. */
  authors: string[];
  year: string | null;
  line: number;
}

function familyName(creator: Creator): string {
  return (creator.lastName ?? creator.name ?? '').trim();
}

/** Offset of each entry's `@type{key` in the text, to give it a line. */
function entryLines(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  let line = 1;
  let scanned = 0;
  for (const match of text.matchAll(/@\s*([a-zA-Z]+)\s*[{(]\s*([^,\s]+)\s*,/g)) {
    for (
      let index = text.indexOf('\n', scanned);
      index !== -1 && index < match.index;
      index = text.indexOf('\n', index + 1)
    ) {
      line += 1;
      scanned = index + 1;
    }
    const key = match[2];
    if (key !== undefined && !lines.has(key)) lines.set(key, line);
  }
  return lines;
}

/**
 * Reads the entries of a BibTeX or BibLaTeX file. The parser is tolerant: a
 * malformed entry is skipped, the others are kept, as BibTeX itself does.
 * Titles keep their casing; LaTeX accents and commands become Unicode.
 */
export function parseBibliography(text: string): BibEntry[] {
  const library = parse(text, { sentenceCase: false, english: false, unsupported: 'ignore' });
  const lines = entryLines(text);
  return library.entries.map((entry) => {
    const creators = entry.fields.author ?? entry.fields.editor ?? [];
    const year = entry.fields.year ?? entry.fields.date?.slice(0, 4) ?? null;
    return {
      key: entry.key,
      type: entry.type,
      title: entry.fields.title ?? null,
      authors: creators.map(familyName).filter((name) => name !== ''),
      year: year === '' ? null : year,
      line: lines.get(entry.key) ?? 1,
    };
  });
}

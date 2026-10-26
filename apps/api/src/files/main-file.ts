/** A text file at the project root, as seen by {@link detectMainFile}. */
export interface RootTextFile {
  id: string;
  name: string;
  content: string;
}

// `\documentclass` outside a comment, at the start of a line or after spaces or other commands.
const DOCUMENT_CLASS = /^[^%\n]*\\documentclass\b/m;
const PREFERRED_NAMES = ['main.tex', 'report.tex', 'rapport.tex', 'thesis.tex', 'these.tex'];

/**
 * Picks the main document among the root `.tex` files that declare a document
 * class. Nothing about the project layout is assumed: a conventional name only
 * breaks ties, otherwise the first candidate in name order wins.
 */
export function detectMainFile(files: readonly RootTextFile[]): string | null {
  const candidates = files
    .filter((file) => file.name.toLowerCase().endsWith('.tex') && DOCUMENT_CLASS.test(file.content))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const preferred of PREFERRED_NAMES) {
    const match = candidates.find((file) => file.name.toLowerCase() === preferred);
    if (match) return match.id;
  }
  return candidates[0]?.id ?? null;
}

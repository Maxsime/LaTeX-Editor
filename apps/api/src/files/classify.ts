import { createHash } from 'node:crypto';

/** Text files above this size are stored as binaries: the editor cannot handle them well. */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  'tex',
  'ltx',
  'latex',
  'sty',
  'cls',
  'clo',
  'bib',
  'bst',
  'bbx',
  'cbx',
  'lbx',
  'dbx',
  'dtx',
  'ins',
  'def',
  'cfg',
  'fd',
  'ist',
  'gst',
  'mf',
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'dat',
  'tikz',
  'pgf',
  'lua',
  'py',
  'r',
  'rnw',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'sh',
  'bat',
  'mk',
  'gitignore',
  'latexmkrc',
  'asy',
  'gp',
  'gnuplot',
  'm',
  'c',
  'h',
  'cpp',
  'hpp',
  'java',
  'js',
  'ts',
  'html',
  'css',
  'el',
]);
const TEXT_FILE_NAMES = new Set(['latexmkrc', '.latexmkrc', 'makefile', 'readme', 'license']);

/** Tells whether a file name designates an editable text format. */
export function hasTextName(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_FILE_NAMES.has(lower)) return true;
  const dot = lower.lastIndexOf('.');
  return dot >= 0 && TEXT_EXTENSIONS.has(lower.slice(dot + 1));
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Decodes `bytes` as an editable text file, or returns `null` when it must be
 * kept as a binary. The BOM is kept as a character (`ignoreBOM`), so
 * re-encoding the string gives back the exact original bytes.
 */
export function decodeText(name: string, bytes: Uint8Array): string | null {
  if (!hasTextName(name) || bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Lowercase hex SHA-256, the digest used for blobs and manifests. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

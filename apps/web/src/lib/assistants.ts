export type ColumnAlign = 'l' | 'c' | 'r';

export interface TableSpec {
  /** Rows of cells, the first one being the header when `header` is set. */
  cells: readonly (readonly string[])[];
  align: readonly ColumnAlign[];
  header: boolean;
  /** Rules from booktabs (`\toprule`…) rather than `\hline`. */
  booktabs: boolean;
  caption: string;
  label: string;
}

export interface FigureSpec {
  path: string;
  /** Fraction of `\linewidth`, from 0.1 to 1. */
  width: number;
  caption: string;
  label: string;
}

export interface AlignSpec {
  rows: number;
  /** `align*`: no equation numbers. */
  starred: boolean;
}

/** Packages each assistant's code needs. */
export function requiredPackages(
  kind: 'table' | 'figure' | 'align',
  spec?: Pick<TableSpec, 'booktabs'>,
): string[] {
  if (kind === 'figure') return ['graphicx'];
  if (kind === 'align') return ['amsmath'];
  return spec?.booktabs === true ? ['booktabs'] : [];
}

/** Packages of `required` the project does not load. */
export function missingPackages(required: readonly string[], loaded: readonly string[]): string[] {
  const present = new Set(loaded);
  return required.filter((name) => !present.has(name));
}

/** `\label` and `\caption` lines, when given. */
function captionLines(caption: string, label: string, indent: string): string[] {
  const lines: string[] = [];
  if (caption.trim() !== '') lines.push(`${indent}\\caption{${caption.trim()}}`);
  if (label.trim() !== '') lines.push(`${indent}\\label{${label.trim()}}`);
  return lines;
}

/**
 * A floating table. Cells are LaTeX as typed: a `&` the user wants printed
 * must be written `\&`, as in the source.
 */
export function tableLatex(spec: TableSpec): string {
  const columns = Math.max(spec.align.length, ...spec.cells.map((row) => row.length), 1);
  const align = Array.from({ length: columns }, (_, index) => spec.align[index] ?? 'l').join('');
  const row = (cells: readonly string[]) =>
    `    ${Array.from({ length: columns }, (_, index) => (cells[index] ?? '').trim()).join(' & ')} \\\\`;
  const [top, mid, bottom] = spec.booktabs
    ? ['\\toprule', '\\midrule', '\\bottomrule']
    : ['\\hline', '\\hline', '\\hline'];
  const body: string[] = [`    ${top}`];
  spec.cells.forEach((cells, index) => {
    body.push(row(cells));
    if (index === 0 && spec.header && spec.cells.length > 1) body.push(`    ${mid}`);
  });
  body.push(`    ${bottom}`);
  return [
    '\\begin{table}[htbp]',
    '  \\centering',
    ...captionLines(spec.caption, spec.label, '  '),
    `  \\begin{tabular}{${align}}`,
    ...body,
    '  \\end{tabular}',
    '\\end{table}',
    '',
  ].join('\n');
}

/** A floating figure showing one image of the project. */
export function figureLatex(spec: FigureSpec): string {
  const width = Math.min(Math.max(spec.width, 0.1), 1);
  const factor = width === 1 ? '' : String(Math.round(width * 100) / 100);
  return [
    '\\begin{figure}[htbp]',
    '  \\centering',
    `  \\includegraphics[width=${factor}\\linewidth]{${spec.path}}`,
    ...captionLines(spec.caption, spec.label, '  '),
    '\\end{figure}',
    '',
  ].join('\n');
}

/** Aligned equations, one placeholder relation per row. */
export function alignLatex(spec: AlignSpec): string {
  const rows = Math.min(Math.max(Math.round(spec.rows), 1), 50);
  const name = spec.starred ? 'align*' : 'align';
  const lines = Array.from(
    { length: rows },
    (_, index) =>
      `  a_{${String(index + 1)}} &= b_{${String(index + 1)}}${index < rows - 1 ? ' \\\\' : ''}`,
  );
  return [`\\begin{${name}}`, ...lines, `\\end{${name}}`, ''].join('\n');
}

/** Path of an image as `\includegraphics` reads it: relative to the main file, without extension. */
export function graphicsPath(imagePath: string, mainPath: string | null): string {
  const slash = mainPath?.lastIndexOf('/') ?? -1;
  const base = mainPath !== null && slash !== -1 ? mainPath.slice(0, slash + 1) : '';
  const relative =
    base !== '' && imagePath.startsWith(base)
      ? imagePath.slice(base.length)
      : base === ''
        ? imagePath
        : `${'../'.repeat(base.split('/').length - 1)}${imagePath}`;
  // graphicx finds the extension itself; a name with dots inside would confuse it otherwise.
  return /\.[^./]+\.[^./]+$/.test(relative)
    ? relative
    : relative.replace(/\.(pdf|png|jpe?g|eps)$/i, '');
}

import { describe, expect, it } from 'vitest';
import {
  alignLatex,
  figureLatex,
  graphicsPath,
  missingPackages,
  requiredPackages,
  tableLatex,
} from './assistants.js';

describe('insertion assistants', () => {
  it('writes a booktabs table with a header row', () => {
    expect(
      tableLatex({
        cells: [
          ['Grandeur', 'Valeur'],
          ['$R$', '10'],
        ],
        align: ['l', 'r'],
        header: true,
        booktabs: true,
        caption: 'Mesures',
        label: 'tab:mesures',
      }),
    ).toBe(
      [
        '\\begin{table}[htbp]',
        '  \\centering',
        '  \\caption{Mesures}',
        '  \\label{tab:mesures}',
        '  \\begin{tabular}{lr}',
        '    \\toprule',
        '    Grandeur & Valeur \\\\',
        '    \\midrule',
        '    $R$ & 10 \\\\',
        '    \\bottomrule',
        '  \\end{tabular}',
        '\\end{table}',
        '',
      ].join('\n'),
    );
  });

  it('pads short rows and uses rules without booktabs', () => {
    const table = tableLatex({
      cells: [['a', 'b', 'c'], ['d']],
      align: ['c'],
      header: false,
      booktabs: false,
      caption: '',
      label: '',
    });
    expect(table).toContain('\\begin{tabular}{cll}');
    expect(table).toContain('    d &  &  \\\\');
    expect(table).not.toContain('\\caption');
    expect(table.match(/\\hline/g)).toHaveLength(2);
  });

  it('writes figures and aligned equations', () => {
    expect(figureLatex({ path: 'img/plot', width: 0.8, caption: 'Courbe', label: '' })).toContain(
      '\\includegraphics[width=0.8\\linewidth]{img/plot}',
    );
    expect(figureLatex({ path: 'a', width: 1, caption: '', label: 'fig:a' })).toContain(
      '[width=\\linewidth]',
    );
    expect(alignLatex({ rows: 2, starred: true })).toBe(
      '\\begin{align*}\n  a_{1} &= b_{1} \\\\\n  a_{2} &= b_{2}\n\\end{align*}\n',
    );
  });

  it('reminds of the packages the project does not load', () => {
    expect(missingPackages(requiredPackages('table', { booktabs: true }), ['amsmath'])).toEqual([
      'booktabs',
    ]);
    expect(missingPackages(requiredPackages('figure'), ['graphicx'])).toEqual([]);
    expect(requiredPackages('table', { booktabs: false })).toEqual([]);
  });

  it('writes image paths relative to the main file', () => {
    expect(graphicsPath('figures/plot.pdf', 'main.tex')).toBe('figures/plot');
    expect(graphicsPath('report/img/a.png', 'report/main.tex')).toBe('img/a');
    expect(graphicsPath('shared/logo.png', 'report/main.tex')).toBe('../shared/logo');
    expect(graphicsPath('img/v1.2.png', null)).toBe('img/v1.2.png');
  });
});

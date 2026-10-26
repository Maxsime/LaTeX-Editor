import type { TreeNode } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import { buildTree, canDrop, flatten, moveTargets, previewKind, visibleItems } from './tree.js';

const node = (
  id: string,
  name: string,
  parentId: string | null,
  kind: TreeNode['kind'] = 'text',
): TreeNode => ({
  id,
  name,
  parentId,
  kind,
  size: kind === 'folder' ? null : 1,
  updatedAt: '2026-10-26T00:00:00.000Z',
});

const nodes = [
  node('main', 'main.tex', null),
  node('chap', 'chapitres', null, 'folder'),
  node('c10', 'chap10.tex', 'chap'),
  node('c2', 'chap2.tex', 'chap'),
  node('fig', 'figures', 'chap', 'folder'),
  node('png', 'a.png', 'fig', 'binary'),
  node('Z', 'Zeta.bib', null),
];

describe('buildTree', () => {
  it('nests nodes, folders first, in natural order', () => {
    const roots = buildTree(nodes);
    expect(roots.map((item) => item.name)).toEqual(['chapitres', 'main.tex', 'Zeta.bib']);
    expect(roots[0]?.children.map((item) => item.path)).toEqual([
      'chapitres/figures',
      'chapitres/chap2.tex',
      'chapitres/chap10.tex',
    ]);
    expect(flatten(roots).find((item) => item.id === 'png')).toMatchObject({
      path: 'chapitres/figures/a.png',
      depth: 2,
    });
  });

  it('only shows children of expanded folders', () => {
    const roots = buildTree(nodes);
    expect(visibleItems(roots, new Set()).map((item) => item.id)).toEqual(['chap', 'main', 'Z']);
    expect(visibleItems(roots, new Set(['chap'])).map((item) => item.id)).toEqual([
      'chap',
      'fig',
      'c2',
      'c10',
      'main',
      'Z',
    ]);
  });
});

describe('moves', () => {
  it('never offers a folder itself, its descendants or its current parent', () => {
    const roots = buildTree(nodes);
    const chap = roots[0];
    if (!chap) throw new Error('missing folder');
    expect(moveTargets(roots, chap)).toEqual([]);
    const png = flatten(roots).find((item) => item.id === 'png');
    if (!png) throw new Error('missing file');
    expect(moveTargets(roots, png).map((item) => item?.id ?? 'root')).toEqual(['root', 'chap']);
  });

  it('refuses drops that create cycles or change nothing', () => {
    expect(canDrop(nodes, 'chap', 'fig')).toBe(false);
    expect(canDrop(nodes, 'chap', 'chap')).toBe(false);
    expect(canDrop(nodes, 'main', null)).toBe(false);
    expect(canDrop(nodes, 'main', 'fig')).toBe(true);
    expect(canDrop(nodes, 'fig', null)).toBe(true);
  });
});

describe('previewKind', () => {
  it('maps files to their preview', () => {
    expect(previewKind({ kind: 'text', name: 'a.tex' })).toBe('text');
    expect(previewKind({ kind: 'binary', name: 'a.PNG' })).toBe('image');
    expect(previewKind({ kind: 'binary', name: 'logo.pdf' })).toBe('pdf');
    expect(previewKind({ kind: 'binary', name: 'font.otf' })).toBe('none');
    expect(previewKind({ kind: 'folder', name: 'figures' })).toBe('none');
  });
});

import { describe, expect, it } from 'vitest';
import { batches, fromFileList, uploadForm } from './upload.js';

describe('uploads', () => {
  it('keeps the relative path of files picked in a folder', () => {
    const plain = new File(['a'], 'a.tex');
    // Browsers set an empty relative path on files picked one by one; Node leaves it out.
    Object.defineProperty(plain, 'webkitRelativePath', { value: '' });
    const nested = new File(['b'], 'b.png');
    Object.defineProperty(nested, 'webkitRelativePath', { value: 'figures/b.png' });
    expect(fromFileList([plain, nested]).map((upload) => upload.path)).toEqual([
      'a.tex',
      'figures/b.png',
    ]);
  });

  it('sends the parent first, then a path before each file', () => {
    const form = uploadForm('parent-id', [{ path: 'd/a.tex', file: new File(['a'], 'a.tex') }]);
    expect([...form.keys()]).toEqual(['parentId', 'path', 'file']);
    expect(form.get('parentId')).toBe('parent-id');
    expect(uploadForm(null, []).get('parentId')).toBe('');
  });

  it('splits uploads into batches', () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

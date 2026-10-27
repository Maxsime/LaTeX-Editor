import { describe, expect, it } from 'vitest';
import { type AiEditorOptions, proposalDecorations } from './ai.js';

const options: AiEditorOptions = {
  onInline: () => undefined,
  onDecide: () => undefined,
  labels: { accept: 'Accept', reject: 'Reject', proposal: 'Proposal' },
  canEdit: () => true,
};

function ranges(text: string, proposals: Parameters<typeof proposalDecorations>[1]) {
  const found: [number, number][] = [];
  proposalDecorations(text, proposals, options).between(0, text.length, (from, to) => {
    found.push([from, to]);
  });
  return found;
}

const proposal = { changesetId: 'c', before: '', after: '' };

describe('proposalDecorations', () => {
  it('strikes the original and places the replacement after it, following moved text', () => {
    const hunk = {
      ...proposal,
      id: 'h',
      start: 0,
      original: 'old',
      replacement: 'new',
      before: 'An ',
      after: ' word',
    };
    expect(ranges('An old word', [{ ...hunk, start: 3 }])).toEqual([
      [3, 6],
      [6, 6],
    ]);
    // Text typed before the hunk since it was proposed: found again by its surroundings.
    expect(ranges('Here. An old word', [{ ...hunk, start: 3 }])).toEqual([
      [9, 12],
      [12, 12],
    ]);
  });

  it('skips proposals that cannot be found or overlap an earlier one', () => {
    expect(
      ranges('nothing here', [
        { ...proposal, id: 'h', start: 0, original: 'gone', replacement: '' },
      ]),
    ).toEqual([]);
    expect(
      ranges('abc abc', [
        { ...proposal, id: '1', start: 0, original: 'abc', replacement: 'x', after: ' abc' },
        { ...proposal, id: '2', start: 1, original: 'bc', replacement: 'y', before: 'a' },
      ]),
    ).toEqual([
      [0, 3],
      [3, 3],
    ]);
  });
});

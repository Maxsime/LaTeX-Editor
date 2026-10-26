import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { replaceText } from './text.js';

function textWith(content: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  text.insert(0, content);
  return { doc, text };
}

describe('replaceText', () => {
  it.each([
    ['abc', 'abc'],
    ['', 'new'],
    ['old', ''],
    ['hello world', 'hello there world'],
    ['aaaa', 'aa'],
    ['\\section{A}\n', '\\section{B}\n'],
    ['x😀y', 'x😁y'],
    ['😀', '😀😀'],
  ])('turns %j into %j', (from, to) => {
    const { text } = textWith(from);
    replaceText(text, to);
    expect(text.toJSON()).toBe(to);
  });

  it('keeps a relative position outside the changed span', () => {
    const { doc, text } = textWith('prefix MIDDLE suffix');
    const anchor = Y.createRelativePositionFromTypeIndex(text, 16);
    replaceText(text, 'prefix middle suffix');
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, doc)?.index).toBe(16);
  });

  it('emits no update when nothing changes', () => {
    const { doc, text } = textWith('same');
    let updates = 0;
    doc.on('update', () => (updates += 1));
    replaceText(text, 'same');
    expect(updates).toBe(0);
  });
});

import type { SpellingMatch } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import { batchParagraphs, SpellChecker, splitMatches } from './spelling.js';

const match = (offset: number, length: number, kind: SpellingMatch['kind'] = 'spelling') => ({
  offset,
  length,
  message: 'Faute',
  replacements: ['faisait'],
  ruleId: 'FR_SPELLING_RULE',
  kind,
});

describe('spelling batches', () => {
  it('keeps requests within the API limits', () => {
    const paragraph = (length: number) => ({
      source: 'a'.repeat(length),
      segments: [{ text: 'a'.repeat(length) }],
    });
    const batches = batchParagraphs([paragraph(9_000), paragraph(9_000), paragraph(9_000)]);
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(batchParagraphs([paragraph(30_000)])).toEqual([]);
  });

  it('gives each paragraph its own matches', () => {
    // "abc" + separator (2) + "defgh": offsets 0..3 and 5..10.
    const split = splitMatches(['abc', 'defgh'], [match(1, 2), match(6, 3), match(2, 4)]);
    expect(split.map((matches) => matches.map((m) => [m.offset, m.length]))).toEqual([
      [[1, 2]],
      [[1, 3]],
    ]);
  });
});

describe('SpellChecker', () => {
  const source = 'Il fesait beau.\n\nSecond paragraphe.\n';

  it('places reports in the source and sends only changed paragraphs again', async () => {
    const requests: string[] = [];
    const checker = new SpellChecker((annotation) => {
      const text = annotation.map((segment) => ('text' in segment ? segment.text : segment.markup));
      requests.push(text.join(''));
      const joined = text.join('');
      const at = joined.indexOf('fesait');
      return Promise.resolve({ language: 'fr', matches: at === -1 ? [] : [match(at, 6)] });
    });
    const issues = await checker.check(source);
    expect(issues.map((issue) => [issue.from, issue.word])).toEqual([[3, 'fesait']]);
    expect(requests).toHaveLength(1);
    await checker.check(source.replace('Second', 'Deuxième'));
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toContain('fesait');
  });

  it('leaves out ignored reports and words of the dictionary', async () => {
    const checker = new SpellChecker(() =>
      Promise.resolve({ language: 'fr', matches: [match(3, 6), match(0, 2, 'grammar')] }),
    );
    const [first, second] = await checker.check(source);
    expect(first?.word).toBe('fesait');
    checker.setDictionary(['fesait']);
    expect((await checker.check(source)).map((issue) => issue.word)).toEqual(['Il']);
    if (second) checker.ignore(second);
    expect(await checker.check(source)).toEqual([]);
  });

  it('waits before calling a failing service again', async () => {
    let now = 0;
    let calls = 0;
    const checker = new SpellChecker(
      () => {
        calls += 1;
        return Promise.reject(new Error('down'));
      },
      () => now,
    );
    expect(await checker.check(source)).toEqual([]);
    await checker.check(source);
    expect(calls).toBe(1);
    now = 61_000;
    await checker.check(source);
    expect(calls).toBe(2);
  });
});

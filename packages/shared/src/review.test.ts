import { describe, expect, it } from 'vitest';
import { commentRequest, mentionedUsernames } from './review.js';

describe('mentions', () => {
  it('finds members named with @, once each', () => {
    expect(mentionedUsernames('@alice, see @Bob. Thanks @alice!')).toEqual(['alice', 'bob']);
    expect(mentionedUsernames('cc @jean-luc.picard_2.')).toEqual(['jean-luc.picard_2']);
  });

  it('ignores e-mail addresses and lone signs', () => {
    expect(mentionedUsernames('write to a@b.fr or @ me, or @x')).toEqual([]);
  });

  it('trims and bounds comment bodies', () => {
    expect(commentRequest.safeParse({ body: '  ok  ' }).data).toEqual({ body: 'ok' });
    expect(commentRequest.safeParse({ body: '   ' }).success).toBe(false);
    expect(commentRequest.safeParse({ body: 'x'.repeat(4001) }).success).toBe(false);
  });
});

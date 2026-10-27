import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  minutesOf,
  parseQuota,
  pricesFromCsv,
  pricesToCsv,
  quotaText,
  usedShare,
} from './admin.js';

describe('formatBytes', () => {
  it('uses the largest fitting unit, in the reader language', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(1536, 'fr')).toBe('1,5 ko');
    expect(formatBytes(20 * 1024 * 1024, 'fr')).toBe('20 Mo');
  });
});

describe('quotas in forms', () => {
  it('reads empty as unlimited and refuses what the API would refuse', () => {
    expect(parseQuota('')).toBeNull();
    expect(parseQuota(' 500 ')).toBe(500);
    expect(parseQuota('0')).toBeUndefined();
    expect(parseQuota('1.5')).toBeUndefined();
    expect(parseQuota('-1')).toBeUndefined();
    expect(parseQuota('-1', true)).toBe(-1);
    expect(parseQuota('-2', true)).toBeUndefined();
    expect(quotaText(null)).toBe('');
    expect(quotaText(-1)).toBe('-1');
  });

  it('rounds a started minute up and caps the share at the limit', () => {
    expect(minutesOf(61)).toBe(2);
    expect(minutesOf(0)).toBe(0);
    expect(usedShare(50, 100)).toBe(0.5);
    expect(usedShare(150, 100)).toBe(1);
    expect(usedShare(5, null)).toBeNull();
  });
});

describe('price table as CSV', () => {
  const prices = [
    {
      provider: 'anthropic' as const,
      model: 'model-a',
      inputPerMTok: 3,
      outputPerMTok: 15,
      cachedInputPerMTok: 0.3,
      currency: 'USD',
    },
    {
      provider: 'mistral' as const,
      model: 'model-b',
      inputPerMTok: 0.4,
      outputPerMTok: 2,
      cachedInputPerMTok: null,
      currency: 'EUR',
    },
  ];

  it('round-trips', () => {
    expect(pricesFromCsv(pricesToCsv(prices))).toEqual({ prices });
  });

  it('names the first invalid line', () => {
    const text = `${pricesToCsv(prices)}\nopenai,model-c,abc,1,,USD`;
    expect(pricesFromCsv(text)).toEqual({ line: 4 });
    expect(pricesFromCsv('anthropic,x,1,2,,usd,extra')).toEqual({ line: 1 });
    expect(pricesFromCsv('\n\n')).toEqual({ prices: [] });
  });
});

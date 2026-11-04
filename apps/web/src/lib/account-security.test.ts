import { describe, expect, it } from 'vitest';
import { describeUserAgent } from './account-security.js';

describe('describeUserAgent', () => {
  it('names common browsers and systems', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      ),
    ).toEqual({ browser: 'Edge', os: 'Windows' });
    expect(
      describeUserAgent(
        'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
      ),
    ).toEqual({ browser: 'Firefox', os: 'Linux' });
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      ),
    ).toEqual({ browser: 'Safari', os: 'macOS' });
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      ),
    ).toEqual({ browser: 'Chrome', os: 'Android' });
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ browser: 'Chrome', os: 'iOS' });
  });

  it('leaves unknown parts empty', () => {
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null });
    expect(describeUserAgent('curl/8.5.0')).toEqual({ browser: null, os: null });
  });
});

import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect.js';

describe('safeRedirect', () => {
  it('keeps paths of the application', () => {
    expect(safeRedirect('/join/abc')).toBe('/join/abc');
    expect(safeRedirect('/projects?x=1')).toBe('/projects?x=1');
  });

  it('drops anything that could leave the origin', () => {
    for (const value of ['https://evil.test', '//evil.test', '/\\evil.test', 'join', '', 3]) {
      expect(safeRedirect(value)).toBeUndefined();
    }
  });
});

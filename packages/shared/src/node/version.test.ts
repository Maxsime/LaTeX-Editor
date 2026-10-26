import { describe, expect, it } from 'vitest';
import { readPackageVersion } from './version.js';

describe('readPackageVersion', () => {
  it('reads the version of the enclosing package', () => {
    // The helper expects a module one level below the package root, like src/server.ts.
    expect(readPackageVersion(new URL('../x.ts', import.meta.url).href)).toBe('0.0.0');
  });
});

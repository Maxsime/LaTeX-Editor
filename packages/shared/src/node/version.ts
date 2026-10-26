import { readFileSync } from 'node:fs';
import * as z from 'zod/mini';

const packageJson = z.object({ version: z.string() });

/**
 * Reads the `version` field of the package that contains `moduleUrl`.
 * Services call it with `import.meta.url` from a file one level below the
 * package root (`src/` in development, `dist/` once built).
 */
export function readPackageVersion(moduleUrl: string): string {
  const raw: unknown = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8'));
  return packageJson.parse(raw).version;
}

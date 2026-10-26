import * as z from 'zod/mini';

const encoder = new TextEncoder();
// C0 controls, DEL and C1 controls: invisible in file trees and hostile to shells.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Tells whether `name` is acceptable as a single file or folder name.
 * Names are case-sensitive, like TeX on Linux.
 */
export function isValidFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !CONTROL_CHARACTERS.test(name) &&
    name.trim() === name &&
    encoder.encode(name).length <= 255
  );
}

/** One segment of a project path. */
export const fileName = z.string().check(z.refine(isValidFileName, 'invalid file name'));

/** Maximum folder depth inside a project. */
export const MAX_PATH_DEPTH = 32;

/** Splits a project-relative path into validated segments, or returns `null`. */
export function splitProjectPath(path: string): string[] | null {
  const segments = path.split('/');
  if (segments.length > MAX_PATH_DEPTH || !segments.every(isValidFileName)) {
    return null;
  }
  return segments;
}

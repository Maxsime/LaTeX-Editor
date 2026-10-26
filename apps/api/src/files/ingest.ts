import { readFile } from 'node:fs/promises';
import type { ImportWarning } from '@galley/shared';
import mime from 'mime';
import type { BlobSource } from '../storage/blobs.js';
import { decodeText, hasTextName, MAX_TEXT_BYTES } from './classify.js';

/** A file ready to be written into a project tree. */
export type IncomingFile =
  | { segments: string[]; kind: 'text'; content: string; size: number }
  | { segments: string[]; kind: 'binary'; blob: BlobSource };

/** Media type stored with a blob and sent back when it is downloaded. */
export function mimeTypeFor(name: string): string {
  return mime.getType(name) ?? 'application/octet-stream';
}

/**
 * Turns a spooled file into an editable text file when its name and content
 * allow it, and into a binary blob otherwise. A file whose name announces text
 * but whose content is not UTF-8 is kept byte for byte, with a warning.
 */
export async function classifySpooled(
  segments: string[],
  spooled: { path: string; size: number; hash: string },
  warnings: ImportWarning[],
): Promise<IncomingFile> {
  const name = segments.at(-1) ?? '';
  if (hasTextName(name) && spooled.size <= MAX_TEXT_BYTES) {
    const bytes = await readFile(spooled.path);
    const content = decodeText(name, bytes);
    if (content !== null) {
      return { segments, kind: 'text', content, size: spooled.size };
    }
    warnings.push({ code: 'NOT_UTF8_TEXT', path: segments.join('/') });
  }
  return {
    segments,
    kind: 'binary',
    blob: {
      hash: spooled.hash,
      size: spooled.size,
      mimeType: mimeTypeFor(name),
      path: spooled.path,
    },
  };
}

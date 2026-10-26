import type { ImportWarning } from '@galley/shared';
import yauzl from 'yauzl';
import { SizeLimitError, spool, type ScratchDir } from '../files/spool.js';
import {
  checkDeclaredSize,
  checkEntryType,
  checkPathCollisions,
  type EntryPath,
  parseEntryPath,
  stripCommonRoot,
} from './entries.js';
import { ArchiveError, type ArchiveLimits } from './limits.js';

/** A file extracted to the scratch directory, with its real size and digest. */
export interface ExtractedFile {
  segments: string[];
  path: string;
  size: number;
  hash: string;
}

export interface ExtractedArchive {
  files: ExtractedFile[];
  /** Every folder, including empty ones, so the tree is restored exactly. */
  folders: string[][];
  warnings: ImportWarning[];
}

interface PlannedEntry extends EntryPath {
  entry: yauzl.Entry;
}

async function openArchive(path: string): Promise<yauzl.ZipFile> {
  try {
    return await yauzl.openPromise(path, {
      lazyEntries: true,
      autoClose: false,
      // Refuses entries whose real size differs from the announced one.
      validateEntrySizes: true,
      // Names are validated by parseEntryPath, with errors the client understands.
      strictFileNames: false,
    });
  } catch {
    throw new ArchiveError('CORRUPT');
  }
}

/**
 * Validates the whole central directory before anything is extracted, so a
 * rejected archive leaves no trace.
 */
async function planEntries(zip: yauzl.ZipFile, limits: ArchiveLimits): Promise<PlannedEntry[]> {
  if (zip.entryCount > limits.maxEntries) throw new ArchiveError('TOO_MANY_ENTRIES');
  const planned: PlannedEntry[] = [];
  let declaredTotal = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (planned.length >= limits.maxEntries) throw new ArchiveError('TOO_MANY_ENTRIES');
      if (entry.isEncrypted()) throw new ArchiveError('ENCRYPTED', entry.fileName);
      checkEntryType(entry.versionMadeBy, entry.externalFileAttributes, entry.fileName);
      const path = parseEntryPath(entry.fileName, limits);
      if (path === null) continue;
      if (!path.isDirectory) {
        checkDeclaredSize(entry.uncompressedSize, entry.compressedSize, entry.fileName, limits);
        declaredTotal += entry.uncompressedSize;
        if (declaredTotal > limits.maxTotalBytes) throw new ArchiveError('TOO_LARGE');
      }
      planned.push({ ...path, entry });
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('CORRUPT');
  }
  return planned;
}

/**
 * Extracts a zip archive into `scratch` under the given limits. Sizes in the
 * archive are never trusted: every stream is metered and cut as soon as the
 * real byte count breaks a limit.
 *
 * @throws {ArchiveError} when the archive is refused; the project is untouched.
 */
export async function extractArchive(
  archivePath: string,
  scratch: ScratchDir,
  limits: ArchiveLimits,
): Promise<ExtractedArchive> {
  const zip = await openArchive(archivePath);
  try {
    const planned = stripCommonRoot(await planEntries(zip, limits));
    if (!planned.some((entry) => !entry.isDirectory)) throw new ArchiveError('EMPTY');
    const warnings = checkPathCollisions(planned);

    const files: ExtractedFile[] = [];
    const folders: string[][] = [];
    let total = 0;
    for (const item of planned) {
      if (item.isDirectory) {
        folders.push(item.segments);
        continue;
      }
      const { entry } = item;
      const budget = Math.min(limits.maxFileBytes, limits.maxTotalBytes - total);
      // Same rule as exceedsRatio, applied to the real byte count while it streams.
      const ratioCap = Math.max(
        limits.ratioThresholdBytes,
        Math.max(entry.compressedSize, 1) * limits.maxRatio,
      );
      const target = scratch.file('entry');
      let spooled: { size: number; hash: string };
      try {
        const stream = await zip.openReadStreamPromise(entry);
        spooled = await spool(stream, target, Math.min(budget, ratioCap));
      } catch (error) {
        if (error instanceof SizeLimitError) {
          throw new ArchiveError(
            budget < ratioCap ? 'TOO_LARGE' : 'COMPRESSION_RATIO',
            entry.fileName,
          );
        }
        throw new ArchiveError('CORRUPT', entry.fileName);
      }
      total += spooled.size;
      files.push({ segments: item.segments, path: target, ...spooled });
    }
    return { files, folders, warnings };
  } finally {
    zip.close();
  }
}

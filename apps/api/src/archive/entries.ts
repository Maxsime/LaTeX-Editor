import { isValidFileName, type ImportWarning } from '@galley/shared';
import { ArchiveError, type ArchiveLimits } from './limits.js';

/** Validated location of an archive entry inside the project. */
export interface EntryPath {
  segments: string[];
  isDirectory: boolean;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const MADE_BY_UNIX = 3;

/** Entries produced by archivers rather than by the author. */
function isNoise(segments: readonly string[]): boolean {
  return segments[0] === '__MACOSX' || segments.at(-1) === '.DS_Store';
}

/**
 * Validates a raw entry name and splits it into project path segments.
 * Returns `null` for archiver noise. Anything that could land outside the
 * project root, or that the project tree cannot represent, is refused.
 */
export function parseEntryPath(rawName: string, limits: ArchiveLimits): EntryPath | null {
  if (
    rawName.startsWith('/') ||
    rawName.includes('\\') ||
    /^[A-Za-z]:/.test(rawName) ||
    rawName.includes('\0')
  ) {
    throw new ArchiveError('UNSAFE_PATH', rawName);
  }
  const isDirectory = rawName.endsWith('/');
  const segments = (isDirectory ? rawName.slice(0, -1) : rawName).split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new ArchiveError('UNSAFE_PATH', rawName);
  }
  if (!segments.every(isValidFileName)) {
    throw new ArchiveError('INVALID_NAME', rawName);
  }
  if (isNoise(segments)) return null;
  if (segments.length > limits.maxDepth) {
    throw new ArchiveError('TOO_DEEP', rawName);
  }
  return { segments, isDirectory };
}

/**
 * Refuses symbolic links and special files. Only archives made on Unix carry
 * a file type; other platforms only produce plain files and directories.
 */
export function checkEntryType(
  versionMadeBy: number,
  externalFileAttributes: number,
  rawName: string,
): void {
  if (versionMadeBy >> 8 !== MADE_BY_UNIX) return;
  const type = (externalFileAttributes >>> 16) & S_IFMT;
  if (type === S_IFLNK) throw new ArchiveError('SYMLINK', rawName);
  if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
    throw new ArchiveError('SPECIAL_FILE', rawName);
  }
}

/** Fails when the sizes announced in the central directory already break the limits. */
export function checkDeclaredSize(
  uncompressedSize: number,
  compressedSize: number,
  rawName: string,
  limits: ArchiveLimits,
): void {
  if (uncompressedSize > limits.maxFileBytes) throw new ArchiveError('TOO_LARGE', rawName);
  if (exceedsRatio(uncompressedSize, compressedSize, limits)) {
    throw new ArchiveError('COMPRESSION_RATIO', rawName);
  }
}

export function exceedsRatio(
  uncompressedSize: number,
  compressedSize: number,
  limits: ArchiveLimits,
): boolean {
  return (
    uncompressedSize > limits.ratioThresholdBytes &&
    uncompressedSize > Math.max(compressedSize, 1) * limits.maxRatio
  );
}

/**
 * Drops the folder that wraps every entry, as produced by "compress this
 * folder" on most systems. A project whose only root item is a file keeps it.
 */
export function stripCommonRoot<T extends EntryPath>(entries: T[]): T[] {
  const first = entries[0]?.segments[0];
  if (first === undefined) return entries;
  const wrapped = entries.every(
    (entry) => entry.segments[0] === first && (entry.segments.length > 1 || entry.isDirectory),
  );
  if (!wrapped) return entries;
  return entries
    .filter((entry) => entry.segments.length > 1)
    .map((entry) => ({ ...entry, segments: entry.segments.slice(1) }));
}

/**
 * Refuses an archive where two entries map to the same path, or where a file
 * stands where a folder is needed. Names differing only by case are kept
 * (TeX on Linux tells them apart) but reported, since they cannot be extracted
 * on Windows or macOS.
 */
export function checkPathCollisions(entries: readonly EntryPath[]): ImportWarning[] {
  const kinds = new Map<string, 'file' | 'folder'>();
  const claim = (path: string, kind: 'file' | 'folder'): void => {
    const existing = kinds.get(path);
    if (existing === undefined) {
      kinds.set(path, kind);
    } else if (kind === 'file' || existing === 'file') {
      throw new ArchiveError('DUPLICATE_PATH', path);
    }
  };
  for (const entry of entries) {
    for (let depth = 1; depth < entry.segments.length; depth++) {
      claim(entry.segments.slice(0, depth).join('/'), 'folder');
    }
    claim(entry.segments.join('/'), entry.isDirectory ? 'folder' : 'file');
  }

  const warnings: ImportWarning[] = [];
  const seen = new Map<string, string>();
  for (const path of [...kinds.keys()].sort()) {
    const folded = path.toLowerCase();
    const other = seen.get(folded);
    if (other !== undefined) {
      warnings.push({ code: 'CASE_CONFLICT', path });
    } else {
      seen.set(folded, path);
    }
  }
  return warnings;
}

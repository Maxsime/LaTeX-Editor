/** Bounds applied to every uploaded archive (J1 plan, "Import zip"). */
export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  /** Uncompressed over compressed size, checked on entries above `ratioThresholdBytes`. */
  maxRatio: number;
  ratioThresholdBytes: number;
  maxDepth: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 5000,
  maxTotalBytes: 500 * 1024 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  maxRatio: 100,
  // Small files of repeated bytes legitimately compress far beyond 100:1.
  ratioThresholdBytes: 1024 * 1024,
  maxDepth: 32,
};

export type ArchiveRejection =
  | 'CORRUPT'
  | 'ENCRYPTED'
  | 'UNSAFE_PATH'
  | 'INVALID_NAME'
  | 'SYMLINK'
  | 'SPECIAL_FILE'
  | 'DUPLICATE_PATH'
  | 'TOO_MANY_ENTRIES'
  | 'TOO_DEEP'
  | 'TOO_LARGE'
  | 'COMPRESSION_RATIO'
  | 'EMPTY';

/** The whole archive is refused; nothing has been written to the project. */
export class ArchiveError extends Error {
  constructor(
    readonly reason: ArchiveRejection,
    readonly path?: string,
  ) {
    super(path === undefined ? reason : `${reason}: ${path}`);
    this.name = 'ArchiveError';
  }
}

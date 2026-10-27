import { createHash } from 'node:crypto';
import type { Manifest } from '@galley/shared';

/** A project's content: every file with its hash, and every folder. */
export interface ProjectState {
  manifest: Manifest;
  folders: string[];
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SHA-256 identifying a state, independent of the order of its entries. */
export function stateDigest({ manifest, folders }: ProjectState): string {
  const entries = Object.entries(manifest).sort(([a], [b]) => byKey(a, b));
  return createHash('sha256')
    .update(JSON.stringify({ entries, folders: [...folders].sort(byKey) }))
    .digest('hex');
}

/** What turns one state into another. */
export interface StateChanges {
  /** Paths whose file is created or gets new content. */
  written: string[];
  /** File paths that disappear. */
  removedFiles: string[];
  /** Folder paths that disappear, deepest first. */
  removedFolders: string[];
}

/**
 * Compares two states. A folder of `from` survives when `to` still lists it or
 * still has something below it.
 */
export function diffStates(from: ProjectState, to: ProjectState): StateChanges {
  const written = Object.keys(to.manifest)
    .filter((path) => from.manifest[path] !== to.manifest[path])
    .sort(byKey);
  const removedFiles = Object.keys(from.manifest)
    .filter((path) => !(path in to.manifest))
    .sort(byKey);
  const kept = new Set(to.folders);
  for (const path of Object.keys(to.manifest)) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      kept.add(segments.slice(0, depth).join('/'));
    }
  }
  const removedFolders = from.folders
    .filter((path) => !kept.has(path))
    .sort((a, b) => b.split('/').length - a.split('/').length || byKey(a, b));
  return { written, removedFiles, removedFolders };
}

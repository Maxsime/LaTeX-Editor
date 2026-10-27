/** Where the compiler placed the project and its outputs inside the sandbox. */
export interface PathContext {
  /** Absolute directory of the project sources, e.g. `/project`. */
  projectRoot: string;
  /** Directory TeX ran in, relative to the project root (`''` for the root). */
  cwd: string;
  /** Absolute output directory, whose files are generated, not sources. */
  outDir?: string;
}

/** A path from a log, resolved against the project. */
export type ResolvedPath =
  | { kind: 'project'; path: string }
  | { kind: 'external'; path: string }
  | { kind: 'generated'; path: string };

/** Collapses `.` and `..` segments; returns null when the path climbs above its root. */
export function normalizeSegments(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join('/');
}

function within(path: string, root: string): string | null {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/**
 * Maps a file name printed by TeX, Biber or BibTeX to a project path. TeX
 * prints the name as it was opened: absolute for files found through kpathsea,
 * relative to its working directory for project files.
 */
export function resolveLogPath(raw: string, context: PathContext): ResolvedPath {
  const name = raw.trim();
  if (name.startsWith('/')) {
    const absolute = normalizeSegments(name);
    if (absolute === null) return { kind: 'external', path: name };
    const rooted = `/${absolute}`;
    if (context.outDir !== undefined) {
      const generated = within(rooted, normalizeOrSelf(context.outDir));
      if (generated !== null) return { kind: 'generated', path: generated };
    }
    const inProject = within(rooted, normalizeOrSelf(context.projectRoot));
    if (inProject !== null && inProject !== '') return { kind: 'project', path: inProject };
    return { kind: 'external', path: name };
  }
  const relative = normalizeSegments(context.cwd === '' ? name : `${context.cwd}/${name}`);
  if (relative === null || relative === '') return { kind: 'external', path: name };
  return { kind: 'project', path: relative };
}

function normalizeOrSelf(path: string): string {
  const normalized = normalizeSegments(path);
  return normalized === null ? path : `/${normalized}`;
}

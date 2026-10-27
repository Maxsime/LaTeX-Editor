import { extractStructure, type Structure } from './structure.js';

/** Extensions of files whose definitions feed completion. */
const SOURCE_EXTENSIONS = ['.tex', '.ltx', '.sty', '.cls', '.def'];

/** Whether a path names a LaTeX source file, by extension. */
export function isLatexSource(path: string): boolean {
  const lower = path.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface Located {
  path: string;
  line: number;
}

/** Everything a project defines, for completion and navigation. */
export interface ProjectIndex {
  commands: ({ name: string; args: number; optional: boolean } & Located)[];
  environments: ({ name: string; args: number } & Located)[];
  labels: ({ name: string } & Located)[];
  /** Keys of `\bibitem` lists. */
  bibitems: ({ name: string } & Located)[];
}

/**
 * Collects the commands, environments and labels defined across a project's
 * LaTeX sources. A name defined twice keeps its first definition in path order.
 */
export function buildProjectIndex(
  files: ReadonlyMap<string, string>,
  structureOf: (path: string, text: string) => Structure = (_path, text) => extractStructure(text),
): ProjectIndex {
  const index: ProjectIndex = { commands: [], environments: [], labels: [], bibitems: [] };
  const seen = { commands: new Set<string>(), environments: new Set<string>() };
  const paths = [...files.keys()].filter(isLatexSource).sort();
  for (const path of paths) {
    const structure = structureOf(path, files.get(path) ?? '');
    for (const command of structure.commands) {
      if (seen.commands.has(command.name)) continue;
      seen.commands.add(command.name);
      index.commands.push({ ...command, path });
    }
    for (const environment of structure.environments) {
      if (seen.environments.has(environment.name)) continue;
      seen.environments.add(environment.name);
      index.environments.push({ ...environment, path });
    }
    for (const label of structure.labels) index.labels.push({ ...label, path });
    for (const item of structure.bibitems) index.bibitems.push({ ...item, path });
  }
  return index;
}

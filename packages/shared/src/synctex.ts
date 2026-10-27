import * as z from 'zod/mini';
import { projectPath } from './compile-job.js';

/** BullMQ queue of SyncTeX queries, answered by the compiler workers (SPEC §6.5). */
export const SYNCTEX_QUEUE = 'synctex';

/** How long the API waits for a SyncTeX answer before giving up. */
export const SYNCTEX_TIMEOUT_MS = 5_000;

const coordinate = z.number().check(z.gte(0), z.lte(100_000));
const pageNumber = z.int().check(z.gte(1), z.lte(100_000));
const lineNumber = z.int().check(z.gte(1), z.lte(10_000_000));

const synctexTarget = {
  compileId: z.uuid(),
  /** Name of the `.synctex.gz` among the compilation's published outputs. */
  synctexFile: projectPath.check(z.refine((name) => name.endsWith('.synctex.gz'))),
};

/**
 * Payload of a SyncTeX job. `edit` goes from a point of the PDF to the source,
 * `view` from a source line to the boxes of the PDF. Coordinates are in big
 * points from the top-left corner of the page, as SyncTeX counts them.
 */
export const synctexJob = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('edit'),
    ...synctexTarget,
    page: pageNumber,
    x: coordinate,
    y: coordinate,
  }),
  z.object({
    kind: z.literal('view'),
    ...synctexTarget,
    /** Project-relative path of the source file. */
    file: projectPath,
    line: lineNumber,
    column: z.int().check(z.gte(0), z.lte(100_000)),
  }),
]);
export type SynctexJob = z.infer<typeof synctexJob>;

/** A rectangle of the PDF, in big points from the top-left corner of its page. */
export const synctexBox = z.object({
  page: z.number(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type SynctexBox = z.infer<typeof synctexBox>;

/** Source position of a point of the PDF, as SyncTeX records it. */
export const synctexSource = z.object({
  /** Path as recorded by TeX inside the sandbox, e.g. `/project/./chapters/one.tex`. */
  input: z.string(),
  line: z.number(),
  /** Column, or null when SyncTeX does not know it (the usual case). */
  column: z.nullable(z.number()),
});
export type SynctexSource = z.infer<typeof synctexSource>;

/** Value a worker returns for a SyncTeX job. */
export const synctexResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), source: z.nullable(synctexSource) }),
  z.object({ kind: z.literal('view'), boxes: z.array(synctexBox) }),
]);
export type SynctexResult = z.infer<typeof synctexResult>;

/** Query of `GET /api/projects/:id/compiles/:compileId/synctex/edit`. */
export const synctexEditQuery = z.object({
  page: z.coerce.number().check(z.int(), z.gte(1), z.lte(100_000)),
  x: z.coerce.number().check(z.gte(0), z.lte(100_000)),
  y: z.coerce.number().check(z.gte(0), z.lte(100_000)),
});

/** Query of `GET /api/projects/:id/compiles/:compileId/synctex/view`. */
export const synctexViewQuery = z.object({
  fileId: z.uuid(),
  line: z.coerce.number().check(z.int(), z.gte(1), z.lte(10_000_000)),
  column: z._default(z.coerce.number().check(z.int(), z.gte(0), z.lte(100_000)), 0),
});

/** Body of the `edit` route: the project file and line under a point of the PDF. */
export const synctexEditResponse = z.object({
  /** The project file, or null when the point is outside the project or on nothing. */
  file: z.nullable(z.object({ id: z.uuid(), path: z.string() })),
  /** File of the TeX distribution (class, package) when the point comes from one. */
  externalFile: z.nullable(z.string()),
  line: z.nullable(z.number()),
  column: z.nullable(z.number()),
});
export type SynctexEditResponse = z.infer<typeof synctexEditResponse>;

/** Body of the `view` route: where a source line lands in the PDF. */
export const synctexViewResponse = z.object({ boxes: z.array(synctexBox) });
export type SynctexViewResponse = z.infer<typeof synctexViewResponse>;

/** The folder SyncTeX paths are relative to inside the compilation sandbox. */
const SANDBOX_PROJECT_PREFIX = '/project/';

/**
 * Turns a path recorded by SyncTeX into a project-relative path, or null when
 * it points outside the project (TeX distribution, auxiliary folder).
 */
export function synctexInputToProjectPath(input: string): string | null {
  if (!input.startsWith(SANDBOX_PROJECT_PREFIX)) return null;
  const segments: string[] = [];
  for (const segment of input.slice(SANDBOX_PROJECT_PREFIX.length).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.pop() === undefined) return null;
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join('/');
}

/** Path to give SyncTeX for a project file, matching what TeX recorded. */
export function projectPathToSynctexInput(path: string): string {
  return `${SANDBOX_PROJECT_PREFIX}${path}`;
}

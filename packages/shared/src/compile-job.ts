import { z } from 'zod';

/** BullMQ queue consumed by the compiler workers. */
export const COMPILE_QUEUE = 'compile';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 hex digest');

/** Project-relative POSIX path. Absolute paths and `..` segments are rejected. */
export const projectPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'must be a normalised relative path inside the project',
  );

/** Snapshot of a project as `{path: blob digest}` (SPEC §6.2). */
export const manifest = z.record(projectPath, sha256);
export type Manifest = z.infer<typeof manifest>;

export const engine = z.enum(['pdflatex', 'xelatex', 'lualatex']);
export const bibTool = z.enum(['biber', 'bibtex']);
export const shellEscapeMode = z.enum(['disabled', 'restricted', 'full']);

/** Payload of a compile job (SPEC §6.3). */
export const compileJob = z.object({
  compileId: z.uuid(),
  projectId: z.uuid(),
  manifest,
  texmfManifest: manifest,
  mainFile: projectPath,
  engine,
  bibTool,
  shellEscape: shellEscapeMode,
  draft: z.boolean(),
  haltOnError: z.boolean(),
});
export type CompileJob = z.infer<typeof compileJob>;

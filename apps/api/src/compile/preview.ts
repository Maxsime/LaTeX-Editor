import { previewDocument } from '@galley/latex-index';
import type { PreviewResponse } from '@galley/shared';
import { compileSnippet } from '../ai/snippets.js';
import type { AppContext } from '../context.js';
import { materializeProject, readProjectTexts } from '../materialize.js';
import type { ProjectRow } from '../projects/access.js';
import { requireDocument, texmfManifestOf } from '../projects/texmf.js';

/** Name of the previewed document, placed beside the main file. */
const PREVIEW_NAME = 'galley-preview';
/** Name of the PDF an isolated preview publishes. */
export const PREVIEW_PDF = `${PREVIEW_NAME}.pdf`;

/**
 * Compiles a fragment alone (SPEC §3.3): a `standalone` document with the
 * main file's preamble, beside the main file so that images, packages and
 * inputs of the project are found. The project itself is left untouched.
 */
export async function previewFragment(
  context: AppContext,
  project: ProjectRow,
  userId: string,
  code: string,
): Promise<PreviewResponse> {
  requireDocument(project);
  const texts = await readProjectTexts(context, project.id);
  const main = texts.find((file) => file.id === project.mainFileId);
  const snapshot = await materializeProject(context, project.id);
  const folder = main?.path.includes('/') ? main.path.slice(0, main.path.lastIndexOf('/') + 1) : '';
  const document = previewDocument(main?.text ?? '', code);
  return compileSnippet(context, project.id, userId, document, {
    engine: project.engine,
    manifest: snapshot.manifest,
    texmfManifest: await texmfManifestOf(context, project.ownerId),
    mainFile: `${folder}${PREVIEW_NAME}.tex`,
  });
}

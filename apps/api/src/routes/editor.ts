import {
  buildOutline,
  buildProjectIndex,
  extractStructure,
  type Structure,
} from '@galley/latex-index';
import {
  type OutlineResponse,
  type ProjectIndexResponse,
  replaceRequest,
  type ReplaceResponse,
  searchQuery,
  type SearchResponse,
} from '@galley/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import { parseBibliography } from '../bibliography/parse.js';
import type { AppContext } from '../context.js';
import { parse } from '../http/validate.js';
import { readProjectTexts } from '../materialize.js';
import { loadProject } from '../projects/access.js';
import { compileQuery, replaceInText, searchFiles } from '../search/search.js';
import { projectParams } from './projects.js';

/**
 * Routes serving the editor: project outline, defined names for completion,
 * and project-wide search and replace. All read the live document contents.
 */
export function editorRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context.database;

  app.get('/api/projects/:id/outline', async (request): Promise<OutlineResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { project } = await loadProject(db, id, auth.user.id, 'reader');
    const texts = await readProjectTexts(context, id);
    const main = texts.find((file) => file.id === project.mainFileId);
    if (main === undefined) return { mainFileId: null, entries: [] };
    const idByPath = new Map(texts.map((file) => [file.path, file.id]));
    const entries = buildOutline(new Map(texts.map((file) => [file.path, file.text])), main.path);
    return {
      mainFileId: main.id,
      entries: entries.map((entry) => ({ ...entry, fileId: idByPath.get(entry.path) ?? main.id })),
    };
  });

  app.get('/api/projects/:id/index', async (request): Promise<ProjectIndexResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader');
    const texts = await readProjectTexts(context, id);
    const idByPath = new Map(texts.map((file) => [file.path, file.id]));
    const structures = new Map<string, Structure>();
    const index = buildProjectIndex(
      new Map(texts.map((file) => [file.path, file.text])),
      (path, text) => {
        const structure = structures.get(path) ?? extractStructure(text);
        structures.set(path, structure);
        return structure;
      },
    );
    const locate = <T extends { path: string }>({ path, ...rest }: T) => ({
      ...rest,
      fileId: idByPath.get(path) ?? '',
    });
    const citations: ProjectIndexResponse['citations'] = [];
    for (const file of texts) {
      if (!file.path.toLowerCase().endsWith('.bib')) continue;
      for (const entry of parseBibliography(file.text))
        citations.push({ ...entry, fileId: file.id });
    }
    for (const item of index.bibitems) {
      const { fileId, line } = locate(item);
      citations.push({
        key: item.name,
        type: 'bibitem',
        title: null,
        authors: [],
        year: null,
        fileId,
        line,
      });
    }
    return {
      commands: index.commands.map(locate),
      environments: index.environments.map(locate),
      labels: index.labels.map(locate),
      citations,
    };
  });

  app.get('/api/projects/:id/search', async (request): Promise<SearchResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const query = parse(searchQuery, request.query);
    await loadProject(db, id, auth.user.id, 'reader');
    return searchFiles(await readProjectTexts(context, id), query);
  });

  app.post('/api/projects/:id/replace', async (request): Promise<ReplaceResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(replaceRequest, request.body);
    await loadProject(db, id, auth.user.id, 'editor');
    const pattern = compileQuery(body);
    const only = body.fileIds === undefined ? null : new Set(body.fileIds);
    const replaced: { fileId: string; content: string }[] = [];
    let replacements = 0;
    for (const file of await readProjectTexts(context, id)) {
      if (only !== null && !only.has(file.id)) continue;
      const result = replaceInText(file.text, pattern, body.replacement, body.regex);
      if (result.count === 0) continue;
      replaced.push({ fileId: file.id, content: result.text });
      replacements += result.count;
    }
    await context.documents.apply({ replaced, closed: [] });
    return { files: replaced.length, replacements };
  });
}

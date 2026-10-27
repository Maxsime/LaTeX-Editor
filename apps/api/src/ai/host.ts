import { standaloneDocument, ToolError, type ToolHost } from '@galley/ai';
import { compileRuns, files } from '@galley/db';
import { buildOutline } from '@galley/latex-index';
import { type AiChangeset, ApiError } from '@galley/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { entryFromReference } from '../bibliography/import.js';
import { lookupArxiv, lookupDoi, lookupIsbn } from '../bibliography/sources.js';
import type { AppContext } from '../context.js';
import { nodePaths } from '../files/tree.js';
import { type ProjectText, readProjectTexts } from '../materialize.js';
import type { ProjectRow } from '../projects/access.js';
import { searchFiles } from '../search/search.js';
import { buildHunks, citationViolations, knownCitationKeys } from './changes.js';
import { searchLiterature } from './literature.js';
import { compileSnippet } from './snippets.js';
import { type AiStore, type ConversationState, newId } from './store.js';

/** Most lines `read_file` returns at once; the model asks for the rest. */
const MAX_READ_LINES = 1500;
const MAX_READ_CHARS = 120_000;
const MAX_SEARCH_MATCHES = 50;
const MAX_LOG_ENTRIES = 30;

export interface HostOptions {
  context: AppContext;
  project: ProjectRow;
  userId: string;
  /** Editors and owners may receive proposals; readers only talk. */
  canEdit: boolean;
  store: AiStore;
  conversation: { id: string; state: ConversationState };
  logger: FastifyBaseLogger;
  /** Called with each proposal, to stream it to the user. */
  onChangeset(changeset: AiChangeset): void;
  /** Called with each successful snippet compilation, for the preview. */
  onSnippet?(compileId: string): void;
}

/** Turns an ApiError of a shared helper into a refusal the model can read. */
async function asTool<T>(
  run: () => Promise<T>,
  messages: Partial<Record<string, string>>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ToolError(messages[error.code] ?? `The request failed (${error.code}).`);
    }
    throw error;
  }
}

/**
 * The tools of one assistant request, bound to one project and one user
 * whose access was checked by the route. Every write is a proposal.
 */
export function createToolHost(options: HostOptions): ToolHost {
  const { context, project, userId, store, conversation, logger } = options;
  const { db } = context.database;
  let texts: ProjectText[] | null = null;

  async function projectTexts(): Promise<ProjectText[]> {
    texts ??= await readProjectTexts(context, project.id);
    return texts;
  }

  async function tree() {
    const rows = await db.select().from(files).where(eq(files.projectId, project.id));
    const paths = nodePaths(rows);
    return rows.map((row) => ({ kind: row.kind, path: paths.get(row.id) ?? row.name }));
  }

  async function textAt(path: string): Promise<ProjectText> {
    const file = (await projectTexts()).find((candidate) => candidate.path === path);
    if (file === undefined) {
      throw new ToolError(`No text file ${path} in the project. Use list_files to see the paths.`);
    }
    return file;
  }

  return {
    async listFiles() {
      return (await tree()).flatMap((node) =>
        node.kind === 'folder' ? [] : [{ path: node.path, kind: node.kind }],
      );
    },

    async readFile(path, startLine, endLine) {
      const file = await textAt(path.replace(/^\.\//, ''));
      const lines = file.text.split('\n');
      const first = Math.min(Math.max(1, startLine ?? 1), Math.max(1, lines.length));
      let last = Math.min(lines.length, endLine ?? lines.length, first + MAX_READ_LINES - 1);
      let text = lines.slice(first - 1, last).join('\n');
      while (text.length > MAX_READ_CHARS && last > first) {
        last = first + Math.floor((last - first) / 2);
        text = lines.slice(first - 1, last).join('\n');
      }
      return { path: file.path, firstLine: first, lastLine: last, totalLines: lines.length, text };
    },

    async searchProject(pattern, regex) {
      const result = await asTool(
        async () =>
          searchFiles(await projectTexts(), {
            q: pattern,
            regex,
            caseSensitive: false,
            wholeWord: false,
          }),
        { INVALID_PATTERN: 'Invalid regular expression (RE2 syntax).' },
      );
      return result.matches
        .slice(0, MAX_SEARCH_MATCHES)
        .map((match) => ({ path: match.path, line: match.line, text: match.preview }));
    },

    async getOutline() {
      const all = await projectTexts();
      const main = all.find((file) => file.id === project.mainFileId);
      if (main === undefined) return [];
      return buildOutline(new Map(all.map((file) => [file.path, file.text])), main.path).map(
        (entry) => ({ level: entry.depth, title: entry.title, file: entry.path, line: entry.line }),
      );
    },

    async getCompileLog() {
      const [latest] = await db
        .select()
        .from(compileRuns)
        .where(eq(compileRuns.projectId, project.id))
        .orderBy(desc(compileRuns.createdAt))
        .limit(1);
      if (!latest) return null;
      const diagnostics = latest.result?.diagnostics ?? [];
      return {
        status: latest.status,
        errors: diagnostics
          .filter((diagnostic) => diagnostic.level !== 'badbox')
          .slice(0, MAX_LOG_ENTRIES)
          .map((diagnostic) => ({
            file: diagnostic.file ?? undefined,
            line: diagnostic.line ?? undefined,
            message: `${diagnostic.level}: ${diagnostic.message}`,
          })),
      };
    },

    async compileSnippet(latex) {
      const outcome = await asTool(
        () => compileSnippet(context, project.id, userId, standaloneDocument(latex)),
        {
          QUOTA_COMPILE_EXCEEDED: 'The monthly compilation time is used up; nothing was compiled.',
        },
      );
      if (outcome.compileId !== null) {
        await store.recordSnippet(outcome.compileId, userId, project.id);
        options.onSnippet?.(outcome.compileId);
      }
      if (outcome.outcome === 'error') {
        throw new ToolError(
          'No compiler is available right now; the snippet could not be checked.',
        );
      }
      return { outcome: outcome.outcome, errors: outcome.errors };
    },

    async proposeChanges(edits) {
      if (!options.canEdit) {
        throw new ToolError('The user can only read this project: changes cannot be proposed.');
      }
      const all = await projectTexts();
      const nodes = await tree();
      const hunks = buildHunks(
        all,
        new Set(nodes.filter((node) => node.kind === 'folder').map((node) => node.path)),
        new Set(nodes.filter((node) => node.kind === 'binary').map((node) => node.path)),
        edits,
      );
      const { fetched } = conversation.state;
      const violations = citationViolations(hunks, knownCitationKeys(all, fetched), fetched);
      if (violations.length > 0) {
        logger.info(
          { projectId: project.id, violations: violations.length },
          'assistant proposal refused: citations',
        );
        throw new ToolError(violations.join('\n'));
      }
      const changeset: AiChangeset = {
        id: newId(),
        hunks: hunks.map((hunk) => ({ ...hunk, status: 'pending' as const })),
      };
      await store.saveChangeset({
        userId,
        projectId: project.id,
        conversationId: conversation.id,
        changeset,
      });
      options.onChangeset(changeset);
      return {
        changesetId: changeset.id,
        hunks: hunks.length,
        files: [...new Set(hunks.map((hunk) => hunk.path))],
      };
    },

    searchLiterature(query) {
      return asTool(() => searchLiterature(context.config, fetch, query), {
        SERVICE_UNAVAILABLE: 'The literature services are unreachable. Try again later.',
      });
    },

    async fetchBibtex({ doi, arxivId, isbn }) {
      const reference = await asTool(
        () =>
          doi !== undefined && doi !== ''
            ? lookupDoi(context.config, fetch, doi)
            : arxivId !== undefined && arxivId !== ''
              ? lookupArxiv(context.config, fetch, arxivId)
              : lookupIsbn(context.config, fetch, isbn ?? ''),
        {
          IDENTIFIER_INVALID: 'This identifier is not valid.',
          REFERENCE_NOT_FOUND: 'No reference has this identifier.',
          SERVICE_UNAVAILABLE: 'The bibliographic service is unreachable. Try again later.',
        },
      );
      const taken = knownCitationKeys(await projectTexts(), conversation.state.fetched);
      // A reference fetched twice keeps the key it got the first time.
      const entry = entryFromReference(reference, { pattern: project.citeKeyPattern, taken });
      const same = conversation.state.fetched.find(
        (fetched) => fetched.bibtex.replace(entry.key, '') === entry.bibtex.replace(entry.key, ''),
      );
      if (same !== undefined) return same;
      conversation.state.fetched.push({ key: entry.key, bibtex: entry.bibtex });
      await store.saveConversation(conversation.id, conversation.state);
      return { key: entry.key, bibtex: entry.bibtex };
    },

    onFailure(name, error) {
      // Only the kind of failure: an error may quote the document.
      logger.error(
        {
          projectId: project.id,
          tool: name,
          error: error instanceof Error ? error.name : typeof error,
        },
        'assistant tool failed',
      );
    },
  };
}

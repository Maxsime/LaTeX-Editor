import {
  buildContext,
  classifyProviderError,
  contextBudget,
  createModel,
  estimateCost,
  generatedCode,
  inlineReplacement,
  loggableProviderError,
  type ProjectSummary,
  runAssistant,
  standaloneDocument,
  type TokenUsage,
} from '@galley/ai';
import { aiModelPrices, aiUsage, compileRuns, files } from '@galley/db';
import { buildOutline, buildProjectIndex, loadedPackages } from '@galley/latex-index';
import {
  type AiChangeset,
  type AiChatRequest,
  type AiStreamEvent,
  type AiToolName,
  type aiChatRequest,
  ApiError,
} from '@galley/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type * as z from 'zod/mini';
import type { AppContext } from '../context.js';
import { nodePaths } from '../files/tree.js';
import { type ProjectText, readProjectTexts } from '../materialize.js';
import type { ProjectRow } from '../projects/access.js';
import { citationViolations, knownCitationKeys } from './changes.js';
import { createToolHost } from './host.js';
import type { ResolvedModel } from './settings.js';
import { compileSnippet } from './snippets.js';
import { type AiStore, newId } from './store.js';

/** Longest a request may run, model calls and tools included. */
const REQUEST_TIMEOUT_MS = 120_000;

const READ_TOOLS: AiToolName[] = ['list_files', 'read_file', 'search_project', 'get_outline'];
const CHAT_TOOLS: AiToolName[] = [
  ...READ_TOOLS,
  'get_compile_log',
  'compile_snippet',
  'search_literature',
  'fetch_bibtex',
];
const GENERATE_TOOLS: AiToolName[] = [...READ_TOOLS, 'compile_snippet'];

export interface ChatOptions {
  context: AppContext;
  store: AiStore;
  project: ProjectRow;
  userId: string;
  canEdit: boolean;
  model: ResolvedModel;
  body: z.output<typeof aiChatRequest>;
  signal: AbortSignal;
  logger: FastifyBaseLogger;
  send: (event: AiStreamEvent) => void;
}

async function summarize(
  context: AppContext,
  project: ProjectRow,
  texts: readonly ProjectText[],
  fetched: readonly { key: string }[],
): Promise<ProjectSummary> {
  const rows = await context.database.db
    .select()
    .from(files)
    .where(eq(files.projectId, project.id));
  const paths = nodePaths(rows);
  const byPath = new Map(texts.map((file) => [file.path, file.text]));
  const main = texts.find((file) => file.id === project.mainFileId);
  const index = buildProjectIndex(byPath);
  const packages = new Set<string>();
  for (const file of texts) {
    if (!file.path.toLowerCase().endsWith('.bib')) {
      for (const name of loadedPackages(file.text)) packages.add(name);
    }
  }
  return {
    mainFile: main?.path ?? null,
    files: rows
      .map((row) => ({ path: paths.get(row.id) ?? row.name, kind: row.kind }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    outline:
      main === undefined
        ? []
        : buildOutline(byPath, main.path).map((entry) => ({
            level: entry.depth,
            title: entry.title,
            file: entry.path,
            line: entry.line,
          })),
    labels: index.labels.map((label) => label.name),
    citationKeys: [
      ...knownCitationKeys(
        texts,
        fetched.map((entry) => ({ ...entry, bibtex: '' })),
      ),
    ].sort(),
    packages: [...packages].sort(),
    commands: index.commands.map((command) => ({ name: command.name, arguments: command.args })),
  };
}

async function lastErrors(context: AppContext, projectId: string) {
  const [latest] = await context.database.db
    .select({ result: compileRuns.result })
    .from(compileRuns)
    .where(eq(compileRuns.projectId, projectId))
    .orderBy(desc(compileRuns.createdAt))
    .limit(1);
  return (latest?.result?.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.level === 'error')
    .slice(0, 10)
    .map((diagnostic) => ({
      file: diagnostic.file ?? undefined,
      line: diagnostic.line ?? undefined,
      message: diagnostic.message,
    }));
}

/** The conversation sent to the model, with the request's specifics in the last message. */
function conversationOf(
  body: AiChatRequest & { messages: { role: 'user' | 'assistant'; text: string }[] },
) {
  const messages = body.messages.map((message) => ({ ...message }));
  const last = messages.at(-1);
  if (last?.role !== 'user')
    throw new ApiError('VALIDATION_FAILED', 'last message must be the user');
  if (body.mode === 'fix' && body.diagnostic !== undefined) {
    const where = [body.diagnostic.file, body.diagnostic.line]
      .filter((part) => part !== undefined)
      .join(':');
    last.text = `${last.text}\n\nCompilation error${where === '' ? '' : ` at ${where}`}:\n${body.diagnostic.message}`;
  }
  if (
    (body.mode === 'generate' || body.mode === 'image') &&
    body.kind !== undefined &&
    body.kind !== 'auto'
  ) {
    last.text = `${last.text}\n\n(Kind of code wanted: ${body.kind}.)`;
  }
  return messages;
}

async function recordUsage(
  options: ChatOptions,
  usage: TokenUsage,
  promptId: string,
): Promise<void> {
  const { context, model } = options;
  const { db } = context.database;
  const [price] = await db
    .select()
    .from(aiModelPrices)
    .where(
      and(
        eq(aiModelPrices.provider, model.config.provider),
        eq(aiModelPrices.model, model.config.model),
      ),
    );
  const costMicros = price ? estimateCost(usage, price) : null;
  await db.insert(aiUsage).values({
    userId: options.userId,
    projectId: options.project.id,
    provider: model.config.provider,
    model: model.config.model,
    mode: options.body.mode,
    promptVersion: promptId,
    ...usage,
    costMicros,
    currency: price?.currency ?? null,
  });
  options.send({
    type: 'usage',
    usage: { ...usage, costMicros, currency: price?.currency ?? null },
  });
}

/**
 * Serves one request of the assistant panel (SPEC §6.8), streaming events
 * through `send`. Nothing is written to the project: proposals are stored as
 * changesets for the user to accept.
 */
export async function runChat(options: ChatOptions): Promise<void> {
  const { context, store, project, userId, body, model, logger, send } = options;
  if (body.image !== undefined && !model.capabilities.vision) throw new ApiError('AI_NO_VISION');
  if (body.mode === 'image' && body.image === undefined) {
    throw new ApiError('VALIDATION_FAILED', 'image mode needs an image');
  }
  const conversation = await store.conversation(body.conversationId, userId, project.id);
  send({ type: 'conversation', id: conversation.id });

  const texts = await readProjectTexts(context, project.id);
  const current =
    body.context.fileId === undefined
      ? undefined
      : texts.find((file) => file.id === body.context.fileId);
  const selection = body.context.selection;
  if (body.mode === 'inline') {
    if (!options.canEdit) throw new ApiError('FORBIDDEN');
    if (current === undefined || selection === undefined || selection.to > current.text.length) {
      throw new ApiError('VALIDATION_FAILED', 'inline edits need a selection in a file');
    }
  }

  const built = buildContext({
    project: await summarize(context, project, texts, conversation.state.fetched),
    current:
      current === undefined
        ? undefined
        : {
            path: current.path,
            text: current.text,
            cursor: body.context.cursor,
            selection,
          },
    logErrors: body.mode === 'fix' ? [] : await lastErrors(context, project.id),
    budget: contextBudget(model.capabilities.contextTokens),
  });

  const changesets: AiChangeset[] = [];
  const host = createToolHost({
    context,
    project,
    userId,
    canEdit: options.canEdit,
    store,
    conversation,
    logger,
    onChangeset: (changeset) => {
      changesets.push(changeset);
      send({ type: 'changeset', changeset });
    },
  });
  const names =
    body.mode === 'inline'
      ? []
      : body.mode === 'generate' || body.mode === 'image'
        ? GENERATE_TOOLS
        : options.canEdit
          ? [...CHAT_TOOLS, 'propose_changes' as const]
          : CHAT_TOOLS;

  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  let result;
  try {
    result = await runAssistant({
      model: createModel(model.config),
      provider: model.config.provider,
      capabilities: model.capabilities,
      mode: body.mode,
      context: built,
      messages: conversationOf(body),
      image: body.image,
      tools: names.length === 0 ? undefined : { host, names },
      abortSignal: signal,
      maxOutputTokens: body.mode === 'chat' || body.mode === 'fix' ? 4096 : 8192,
      onEvent: (event) => {
        send(event);
      },
    });
  } catch (error) {
    if (signal.aborted && options.signal.aborted) return;
    const code = classifyProviderError(error);
    logger.warn(
      { projectId: project.id, ...loggableProviderError(error), code },
      'assistant request failed',
    );
    send({ type: 'error', code });
    return;
  }

  if (body.mode === 'inline' && current !== undefined && selection !== undefined) {
    const replacement = inlineReplacement(result.text);
    if (replacement === null) {
      send({ type: 'error', code: 'AI_BAD_RESPONSE' });
    } else {
      const start = selection.from;
      const original = current.text.slice(selection.from, selection.to);
      const hunk = {
        id: 'h1',
        fileId: current.id,
        path: current.path,
        start,
        original,
        replacement,
        before: current.text.slice(Math.max(0, start - 40), start),
        after: current.text.slice(selection.to, selection.to + 40),
      };
      const { fetched } = conversation.state;
      if (citationViolations([hunk], knownCitationKeys(texts, fetched), fetched).length > 0) {
        send({ type: 'error', code: 'UNKNOWN_CITATION' });
      } else {
        const changeset: AiChangeset = { id: newId(), hunks: [{ ...hunk, status: 'pending' }] };
        await store.saveChangeset({
          userId,
          projectId: project.id,
          conversationId: conversation.id,
          changeset,
        });
        send({ type: 'changeset', changeset });
      }
    }
  }

  if (body.mode === 'generate' || body.mode === 'image') {
    const generated = generatedCode(result.text);
    if (generated === null) {
      send({ type: 'error', code: 'AI_BAD_RESPONSE' });
    } else {
      const compiled = await compileSnippet(
        context,
        project.id,
        userId,
        standaloneDocument(generated.code, generated.preamble),
      );
      if (compiled.compileId !== null)
        await store.recordSnippet(compiled.compileId, userId, project.id);
      send({
        type: 'snippet',
        snippet: {
          code: generated.code,
          preamble: generated.preamble,
          compileId: compiled.compileId,
          outcome: compiled.outcome,
          errors: compiled.errors,
        },
      });
    }
  }

  await recordUsage(options, result.usage, result.promptId);
}

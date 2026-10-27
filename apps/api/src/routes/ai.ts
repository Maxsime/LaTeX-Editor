import { aiModelPrices, aiProviderConfigs, aiUsage } from '@galley/db';
import {
  type AiChangeset,
  aiChatRequest,
  type AiProviderSettings,
  type AiStatus,
  type AiStreamEvent,
  type AiUsageSummary,
  ApiError,
  changesetDecisionRequest,
  hasRole,
  putAiPricesRequest,
  putAiProviderRequest,
  splitProjectPath,
} from '@galley/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as z from 'zod/mini';
import { runChat } from '../ai/chat.js';
import { citationViolations, knownCitationKeys } from '../ai/changes.js';
import {
  aiKeyContext,
  checkUserEndpoint,
  instanceDefault,
  requireAvailable,
  resolveModel,
  statusOf,
  toProviderConfig,
} from '../ai/settings.js';
import { storageGuard } from '../admin/quotas.js';
import { instanceSettingsOf } from '../admin/settings.js';
import { AiStore } from '../ai/store.js';
import { requireAdmin, requireAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import { createSecretBox, keyHint, requireSecretBox } from '../crypto/secrets.js';
import { touchProject, writeFiles } from '../files/tree.js';
import { recordActivity } from '../history/snapshots.js';
import { parse } from '../http/validate.js';
import { readProjectTexts } from '../materialize.js';
import { loadProject } from '../projects/access.js';
import { publishProjectEvent } from '../projects/events.js';
import { readCompileOutput } from '../storage/compiles.js';
import { projectParams } from './projects.js';

const changesetParams = z.object({
  id: z.uuid(),
  changesetId: z.string().check(z.regex(/^[A-Za-z0-9_-]{8,64}$/)),
});
const snippetParams = z.object({ id: z.uuid(), compileId: z.uuid() });

/** Largest chat request: an image of 4 MB in base64, and the conversation. */
const CHAT_BODY_LIMIT = 8 * 1024 * 1024;

function perPerson(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: '1 minute',
      hook: 'preHandler' as const,
      keyGenerator: (request: FastifyRequest) => request.auth?.user.id ?? request.ip,
    },
  };
}

function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The AI assistant: provider settings, streamed chat, proposals, previews, usage (SPEC §3.8, §6.8). */
export function aiRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context.database;
  const { config, redis } = context;
  const secrets = createSecretBox(config.GALLEY_MASTER_KEY);
  const store = new AiStore(redis);

  // --- Provider settings ----------------------------------------------------------

  async function settingsOf(userId: string): Promise<AiProviderSettings> {
    const [row] = await db
      .select()
      .from(aiProviderConfigs)
      .where(eq(aiProviderConfigs.userId, userId));
    const settings = await instanceSettingsOf(context).get();
    const instance = instanceDefault(config, settings);
    return {
      config: row ? toProviderConfig(row) : null,
      instance,
      allowUserEndpoints: config.AI_ALLOW_USER_ENDPOINTS,
      enabled: settings.aiEnabled,
    };
  }

  app.get('/api/me/ai/provider', async (request): Promise<AiProviderSettings> => {
    const auth = requireAuth(request);
    return settingsOf(auth.user.id);
  });

  app.put(
    '/api/me/ai/provider',
    { config: perPerson(10) },
    async (request): Promise<AiProviderSettings> => {
      const auth = requireAuth(request);
      const body = parse(putAiProviderRequest, request.body);
      const baseUrl = checkUserEndpoint(config, body.provider, body.baseUrl);
      const [existing] = await db
        .select()
        .from(aiProviderConfigs)
        .where(eq(aiProviderConfigs.userId, auth.user.id));
      // A key belongs to one provider: changing provider without a new key drops it.
      const keep = body.apiKey === undefined && existing?.provider === body.provider;
      const key =
        body.apiKey === undefined
          ? keep
            ? { keyCiphertext: existing.keyCiphertext, keyHint: existing.keyHint }
            : { keyCiphertext: null, keyHint: null }
          : {
              keyCiphertext: requireSecretBox(secrets).seal(
                body.apiKey,
                aiKeyContext(auth.user.id),
              ),
              keyHint: keyHint(body.apiKey),
            };
      const values = { provider: body.provider, model: body.model, baseUrl, ...key };
      await db
        .insert(aiProviderConfigs)
        .values({ userId: auth.user.id, ...values })
        .onConflictDoUpdate({
          target: aiProviderConfigs.userId,
          set: { ...values, updatedAt: new Date() },
        });
      return settingsOf(auth.user.id);
    },
  );

  app.delete('/api/me/ai/provider', async (request, reply) => {
    const auth = requireAuth(request);
    await db.delete(aiProviderConfigs).where(eq(aiProviderConfigs.userId, auth.user.id));
    return reply.status(204).send();
  });

  app.get('/api/me/ai/usage', async (request): Promise<AiUsageSummary> => {
    const auth = requireAuth(request);
    const since = startOfMonth(new Date());
    const rows = await db
      .select({
        provider: aiUsage.provider,
        model: aiUsage.model,
        currency: aiUsage.currency,
        requests: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
        cachedInputTokens: sql<number>`coalesce(sum(${aiUsage.cachedInputTokens}), 0)::int`,
        costMicros: sql<number | null>`sum(${aiUsage.costMicros})::float8`,
        unpriced: sql<number>`count(*) filter (where ${aiUsage.costMicros} is null)::int`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, auth.user.id), gte(aiUsage.createdAt, since)))
      .groupBy(aiUsage.provider, aiUsage.model, aiUsage.currency);
    const total = (pick: (row: (typeof rows)[number]) => number | null) =>
      rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);
    return {
      since: since.toISOString(),
      requests: total((row) => row.requests),
      inputTokens: total((row) => row.inputTokens),
      outputTokens: total((row) => row.outputTokens),
      cachedInputTokens: total((row) => row.cachedInputTokens),
      costs: [
        ...rows
          .reduce((sums, row) => {
            if (row.currency !== null && row.costMicros !== null) {
              sums.set(row.currency, (sums.get(row.currency) ?? 0) + row.costMicros);
            }
            return sums;
          }, new Map<string, number>())
          .entries(),
      ].map(([currency, micros]) => ({ currency, micros: Math.round(micros) })),
      unpricedRequests: total((row) => row.unpriced),
      byModel: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        requests: row.requests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costMicros: row.costMicros === null ? null : Math.round(row.costMicros),
        currency: row.currency,
      })),
    };
  });

  // --- Prices (administration) ----------------------------------------------------

  app.get('/api/admin/ai/prices', async (request) => {
    requireAdmin(request);
    const rows = await db.select().from(aiModelPrices);
    return {
      prices: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        inputPerMTok: row.inputPerMTok,
        outputPerMTok: row.outputPerMTok,
        cachedInputPerMTok: row.cachedInputPerMTok,
        currency: row.currency,
      })),
    };
  });

  app.put('/api/admin/ai/prices', async (request) => {
    requireAdmin(request);
    const { prices } = parse(putAiPricesRequest, request.body);
    await db.transaction(async (tx) => {
      await tx.delete(aiModelPrices);
      if (prices.length > 0) await tx.insert(aiModelPrices).values(prices);
    });
    return { prices };
  });

  // --- Project ----------------------------------------------------------------------

  app.get('/api/projects/:id/ai/status', async (request): Promise<AiStatus> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const { project } = await loadProject(db, id, auth.user.id, 'reader');
    return statusOf(
      await instanceSettingsOf(context).get(),
      project,
      await resolveModel(context, secrets, auth.user.id),
    );
  });

  app.post(
    '/api/projects/:id/ai/chat',
    { bodyLimit: CHAT_BODY_LIMIT, config: perPerson(config.AI_RATE_LIMIT_PER_MINUTE) },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { id } = parse(projectParams, request.params);
      const body = parse(aiChatRequest, request.body);
      const { project, role } = await loadProject(db, id, auth.user.id, 'reader');
      const model = requireAvailable(
        await instanceSettingsOf(context).get(),
        project,
        await resolveModel(context, secrets, auth.user.id),
      );

      // Errors before the first event are ordinary JSON errors; after it, stream events.
      const controller = new AbortController();
      request.raw.on('close', () => {
        if (!reply.raw.writableEnded) controller.abort();
      });
      const stream = { started: false };
      const send = (event: AiStreamEvent) => {
        if (!stream.started) {
          stream.started = true;
          reply.hijack();
          reply.raw.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no',
            'x-request-id': request.id,
          });
        }
        if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      try {
        await runChat({
          context,
          store,
          project,
          userId: auth.user.id,
          canEdit: hasRole(role, 'editor'),
          model,
          body,
          signal: controller.signal,
          logger: request.log,
          send,
        });
      } catch (error) {
        if (!stream.started) throw error;
        request.log.error(
          { projectId: id, error: error instanceof Error ? error.name : typeof error },
          'assistant request failed',
        );
        send({ type: 'error', code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR' });
      }
      send({ type: 'done' });
      reply.raw.end();
    },
  );

  app.post('/api/projects/:id/ai/changesets/:changesetId/apply', async (request) => {
    const auth = requireAuth(request);
    const { id, changesetId } = parse(changesetParams, request.params);
    const { hunkIds } = parse(changesetDecisionRequest, request.body);
    const { project } = await loadProject(db, id, auth.user.id, 'editor');
    const state = await store.changeset(changesetId, auth.user.id, id);
    const wanted = new Set(hunkIds);
    const selected = state.changeset.hunks.filter(
      (hunk) => wanted.has(hunk.id) && hunk.status === 'pending',
    );
    if (selected.length === 0) return { changeset: state.changeset };

    // Checked again: the bibliography may have changed since the proposal.
    const texts = await readProjectTexts(context, id);
    const fetched = (await store.conversationOf(state))?.fetched ?? [];
    if (citationViolations(selected, knownCitationKeys(texts, fetched), fetched).length > 0) {
      throw new ApiError('UNKNOWN_CITATION');
    }

    const statuses = new Map<string, 'applied' | 'conflict'>();
    const byFile = new Map<string, typeof selected>();
    for (const hunk of selected) {
      if (hunk.fileId === null) continue;
      byFile.set(hunk.fileId, [...(byFile.get(hunk.fileId) ?? []), hunk]);
    }
    for (const [fileId, hunks] of byFile) {
      const result = await context.documents.edit(fileId, {
        userId: auth.user.id,
        hunks: hunks.map((hunk) => ({
          id: hunk.id,
          fileId: hunk.fileId,
          path: hunk.path,
          start: hunk.start,
          original: hunk.original,
          replacement: hunk.replacement,
          before: hunk.before,
          after: hunk.after,
        })),
      });
      for (const hunk of hunks) {
        statuses.set(
          hunk.id,
          result?.results.find((entry) => entry.id === hunk.id)?.status ?? 'conflict',
        );
      }
    }

    const creations = selected.filter((hunk) => hunk.fileId === null);
    if (creations.length > 0) {
      const taken = new Set(texts.map((file) => file.path));
      const incoming = creations.flatMap((hunk) => {
        const segments = splitProjectPath(hunk.path);
        if (segments === null || taken.has(hunk.path)) {
          statuses.set(hunk.id, 'conflict');
          return [];
        }
        statuses.set(hunk.id, 'applied');
        const size = Buffer.byteLength(hunk.replacement, 'utf8');
        return [{ segments, kind: 'text' as const, content: hunk.replacement, size }];
      });
      if (incoming.length > 0) {
        try {
          const { quotas } = await instanceSettingsOf(context).get();
          await db.transaction(async (tx) => {
            const guard = await storageGuard(tx, quotas, id);
            await writeFiles(tx, id, null, incoming);
            await guard.check();
          });
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          if (error.code === 'QUOTA_STORAGE_EXCEEDED') throw error;
          // A folder or binary file took the path in the meantime.
          for (const hunk of creations) statuses.set(hunk.id, 'conflict');
        }
        await touchProject(db, id);
        await publishProjectEvent(redis, id, { type: 'tree.changed' });
      }
    }

    if ([...statuses.values()].includes('applied'))
      await recordActivity(db, project.id, auth.user.id);
    const changeset: AiChangeset = {
      ...state.changeset,
      hunks: state.changeset.hunks.map((hunk) => {
        const status = statuses.get(hunk.id);
        return status === undefined ? hunk : { ...hunk, status };
      }),
    };
    await store.saveChangeset({ ...state, changeset });
    return { changeset };
  });

  app.post('/api/projects/:id/ai/changesets/:changesetId/reject', async (request) => {
    const auth = requireAuth(request);
    const { id, changesetId } = parse(changesetParams, request.params);
    const { hunkIds } = parse(changesetDecisionRequest, request.body);
    await loadProject(db, id, auth.user.id, 'reader');
    const state = await store.changeset(changesetId, auth.user.id, id);
    const wanted = new Set(hunkIds);
    const changeset: AiChangeset = {
      ...state.changeset,
      hunks: state.changeset.hunks.map((hunk) =>
        wanted.has(hunk.id) && hunk.status === 'pending' ? { ...hunk, status: 'rejected' } : hunk,
      ),
    };
    await store.saveChangeset({ ...state, changeset });
    return { changeset };
  });

  app.get('/api/projects/:id/ai/snippets/:compileId/pdf', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, compileId } = parse(snippetParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader');
    if (!(await store.snippetBelongsTo(compileId, auth.user.id, id))) {
      throw new ApiError('NOT_FOUND');
    }
    const body = await readCompileOutput(context.s3, config.S3_BUCKET, compileId, 'main.pdf');
    return reply
      .header('content-type', 'application/pdf')
      .header('cache-control', 'private, max-age=3600')
      .send(body);
  });
}

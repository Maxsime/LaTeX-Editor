import {
  ApiError,
  compileRequest,
  type CompileRun,
  type CompilerInfo,
  type LatestCompileResponse,
  TEXLIVE_VERSION_KEY,
} from '@galley/shared';
import { compileRuns } from '@galley/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/mini';
import { requireAuth } from '../auth/plugin.js';
import {
  cancelCompile,
  type CompileRunRow,
  reconcile,
  requestCompile,
  toCompileRun,
} from '../compile/service.js';
import type { AppContext } from '../context.js';
import { parse } from '../http/validate.js';
import { loadProject } from '../projects/access.js';
import { readCompileOutput } from '../storage/compiles.js';
import { sendUserFile } from './files.js';
import { projectParams } from './projects.js';

const compileParams = z.object({ id: z.uuid(), compileId: z.uuid() });
const outputParams = z.object({ id: z.uuid(), compileId: z.uuid(), '*': z.string() });

/** A user compiling in a loop (auto-compile on every pause) stays far below this. */
const compileRateLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

/**
 * Compilation routes (SPEC §3.3). Any member may compile, readers included,
 * since compiling never changes the sources.
 */
export function compileRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context.database;

  async function loadRun(projectId: string, compileId: string): Promise<CompileRunRow> {
    const [row] = await db
      .select()
      .from(compileRuns)
      .where(and(eq(compileRuns.id, compileId), eq(compileRuns.projectId, projectId)));
    if (!row) throw new ApiError('NOT_FOUND');
    return row;
  }

  app.get('/api/compiler', async (request): Promise<CompilerInfo> => {
    requireAuth(request);
    return { texlive: await context.redis.get(TEXLIVE_VERSION_KEY) };
  });

  app.post(
    '/api/projects/:id/compile',
    { config: compileRateLimit },
    async (request, reply): Promise<CompileRun> => {
      const auth = requireAuth(request);
      const { id } = parse(projectParams, request.params);
      const body = parse(compileRequest, request.body ?? {});
      const { project } = await loadProject(db, id, auth.user.id, 'reader');
      const row = await requestCompile(context, project, auth.user.id, body, request.log);
      void reply.status(202);
      return toCompileRun(row);
    },
  );

  app.get('/api/projects/:id/compiles/latest', async (request): Promise<LatestCompileResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader');
    const [latest] = await db
      .select()
      .from(compileRuns)
      .where(eq(compileRuns.projectId, id))
      .orderBy(desc(compileRuns.createdAt))
      .limit(1);
    const [lastPdf] = await db
      .select()
      .from(compileRuns)
      .where(and(eq(compileRuns.projectId, id), sql`${compileRuns.result}->>'pdf' is not null`))
      .orderBy(desc(compileRuns.createdAt))
      .limit(1);
    const current = latest ? await reconcile(context, latest, request.log) : undefined;
    return {
      latest: current ? toCompileRun(current) : null,
      lastPdf: lastPdf ? toCompileRun(lastPdf) : null,
    };
  });

  app.get('/api/projects/:id/compiles/:compileId', async (request): Promise<CompileRun> => {
    const auth = requireAuth(request);
    const { id, compileId } = parse(compileParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader');
    return toCompileRun(await reconcile(context, await loadRun(id, compileId), request.log));
  });

  app.post('/api/projects/:id/compiles/:compileId/cancel', async (request): Promise<CompileRun> => {
    const auth = requireAuth(request);
    const { id, compileId } = parse(compileParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader');
    await cancelCompile(context, await loadRun(id, compileId), request.log);
    return toCompileRun(await loadRun(id, compileId));
  });

  app.get('/api/projects/:id/compiles/:compileId/output/*', async (request, reply) => {
    const auth = requireAuth(request);
    const { id, compileId, '*': name } = parse(outputParams, request.params);
    await loadProject(db, id, auth.user.id, 'reader');
    const row = await loadRun(id, compileId);
    // Only names the worker published are served; nothing else under the prefix is reachable.
    const output = row.result?.outputs.find((file) => file.name === name);
    if (!output) throw new ApiError('NOT_FOUND');
    const body = await readCompileOutput(context.s3, context.config.S3_BUCKET, compileId, name);
    void reply.header('content-length', output.size);
    const baseName = name.slice(name.lastIndexOf('/') + 1);
    // A compilation's files never change once published.
    return sendUserFile(reply, baseName, body, 'private, max-age=31536000, immutable');
  });
}

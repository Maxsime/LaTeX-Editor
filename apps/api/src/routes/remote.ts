import { projectRemotes } from '@galley/db';
import {
  ApiError,
  normalizeRemoteUrl,
  type ProjectRemote,
  type PullResponse,
  type PushResponse,
  type RemoteResponse,
  setRemoteRequest,
} from '@galley/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import { createSecretBox, keyHint, requireSecretBox } from '../crypto/secrets.js';
import { pullRemote, pushRemote, type RemoteTarget } from '../git/remote.js';
import { git } from '../git/run.js';
import { parse } from '../http/validate.js';
import { loadProject } from '../projects/access.js';
import { publishProjectEvent } from '../projects/events.js';
import { requireDocument } from '../projects/texmf.js';
import { projectParams } from './projects.js';

/** Each pull or push talks to GitHub or GitLab; a few a minute is plenty. */
const syncRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest) => request.auth?.user.id ?? request.ip,
  },
};

/** Context in which a remote's token is encrypted: bound to its project. */
const tokenContext = (projectId: string) => `remote:${projectId}`;

/** Whether Git itself accepts the branch name, beyond the schema's pattern. */
async function validBranch(branch: string): Promise<boolean> {
  return git('/nonexistent', ['check-ref-format', '--branch', branch]).then(
    () => true,
    () => false,
  );
}

/**
 * Synchronisation with a GitHub or GitLab repository (SPEC §3.5): the owner
 * sets the repository, branch and token; editors pull and push on demand.
 */
export function remoteRoutes(
  app: FastifyInstance,
  context: AppContext,
  limits: { maxEntries: number },
): void {
  const { database, config, redis } = context;
  const { db } = database;
  const secrets = createSecretBox(config.GALLEY_MASTER_KEY);
  const pushLimits = {
    maxBytes: config.GIT_MAX_PUSH_MB * 1024 * 1024,
    maxEntries: limits.maxEntries,
  };

  async function remoteRow(projectId: string) {
    const [row] = await db
      .select()
      .from(projectRemotes)
      .where(eq(projectRemotes.projectId, projectId));
    return row;
  }

  function toRemote(row: typeof projectRemotes.$inferSelect): ProjectRemote {
    return {
      url: row.url,
      branch: row.branch,
      tokenHint: row.tokenHint,
      lastCommit: row.lastCommit,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    };
  }

  /** The stored remote of a project an editor works on, with its token decrypted. */
  async function target(request: FastifyRequest, projectId: string): Promise<RemoteTarget> {
    const auth = requireAuth(request);
    requireDocument((await loadProject(db, projectId, auth.user.id, 'editor')).project);
    const row = await remoteRow(projectId);
    if (!row) throw new ApiError('REMOTE_NOT_CONFIGURED');
    // A remote whose host the administrator has since removed is not contacted.
    const url = normalizeRemoteUrl(row.url, config.GIT_SYNC_HOSTS, config.GIT_SYNC_ALLOW_HTTP);
    if (url === null) throw new ApiError('REMOTE_URL_REFUSED');
    const token = requireSecretBox(secrets).open(row.tokenCiphertext, tokenContext(projectId));
    return { url, branch: row.branch, token };
  }

  async function synced(projectId: string, remoteCommit: string): Promise<void> {
    await db
      .update(projectRemotes)
      .set({ lastCommit: remoteCommit, lastSyncedAt: new Date() })
      .where(eq(projectRemotes.projectId, projectId));
  }

  app.get('/api/projects/:id/remote', async (request): Promise<RemoteResponse> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    await loadProject(db, id, auth.user.id, 'editor');
    const row = await remoteRow(id);
    return {
      remote: row ? toRemote(row) : null,
      allowedHosts: config.GIT_SYNC_HOSTS,
      available: secrets !== null,
    };
  });

  app.put('/api/projects/:id/remote', async (request): Promise<ProjectRemote> => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    const body = parse(setRemoteRequest, request.body);
    requireDocument((await loadProject(db, id, auth.user.id, 'owner')).project);
    const url = normalizeRemoteUrl(body.url, config.GIT_SYNC_HOSTS, config.GIT_SYNC_ALLOW_HTTP);
    if (url === null) throw new ApiError('REMOTE_URL_REFUSED');
    if (!(await validBranch(body.branch))) {
      throw new ApiError('VALIDATION_FAILED', 'invalid branch name');
    }
    const box = requireSecretBox(secrets);
    const existing = await remoteRow(id);
    if (body.token === undefined && !existing) {
      throw new ApiError('VALIDATION_FAILED', 'token required');
    }
    const token =
      body.token === undefined
        ? {}
        : {
            tokenCiphertext: box.seal(body.token, tokenContext(id)),
            tokenHint: keyHint(body.token),
          };
    // Another repository or branch: the last synchronised commit means nothing there.
    const moved =
      existing !== undefined && (existing.url !== url || existing.branch !== body.branch);
    const values = {
      url,
      branch: body.branch,
      updatedBy: auth.user.id,
      ...token,
      ...(moved ? { lastCommit: null, lastSyncedAt: null } : {}),
    };
    if (existing) {
      await db.update(projectRemotes).set(values).where(eq(projectRemotes.projectId, id));
    } else if (body.token !== undefined) {
      await db.insert(projectRemotes).values({
        projectId: id,
        url,
        branch: body.branch,
        updatedBy: auth.user.id,
        tokenCiphertext: box.seal(body.token, tokenContext(id)),
        tokenHint: keyHint(body.token),
      });
    }
    request.log.info({ projectId: id }, 'remote repository set');
    const row = await remoteRow(id);
    if (!row) throw new ApiError('INTERNAL_ERROR');
    return toRemote(row);
  });

  app.delete('/api/projects/:id/remote', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parse(projectParams, request.params);
    await loadProject(db, id, auth.user.id, 'owner');
    await db.delete(projectRemotes).where(eq(projectRemotes.projectId, id));
    return reply.status(204).send();
  });

  app.post(
    '/api/projects/:id/remote/pull',
    { config: syncRateLimit },
    async (request): Promise<PullResponse> => {
      const { id } = parse(projectParams, request.params);
      const remote = await target(request, id);
      const auth = requireAuth(request);
      const { response, remoteCommit } = await pullRemote(context, {
        projectId: id,
        userId: auth.user.id,
        target: remote,
        limits: pushLimits,
        logger: request.log,
      });
      if (
        response.outcome === 'updated' ||
        response.outcome === 'merged' ||
        response.outcome === 'upToDate'
      ) {
        await synced(id, remoteCommit);
      }
      if (response.outcome === 'updated' || response.outcome === 'merged') {
        await publishProjectEvent(redis, id, { type: 'history.changed' });
      }
      request.log.info({ projectId: id, outcome: response.outcome }, 'remote repository pulled');
      return response;
    },
  );

  app.post(
    '/api/projects/:id/remote/push',
    { config: syncRateLimit },
    async (request): Promise<PushResponse> => {
      const { id } = parse(projectParams, request.params);
      const remote = await target(request, id);
      const response = await pushRemote(context, {
        projectId: id,
        target: remote,
        logger: request.log,
      });
      await synced(id, response.commit);
      request.log.info({ projectId: id, outcome: response.outcome }, 'remote repository pushed');
      return response;
    },
  );
}

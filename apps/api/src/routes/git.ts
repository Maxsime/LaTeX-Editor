import type { AddressInfo } from 'node:net';
import { ApiError, type ProjectRole } from '@galley/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import * as z from 'zod/mini';
import { authenticateAccessToken } from '../auth/access-tokens.js';
import { randomToken, safeEqual } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { type GitService, runService, serviceContentType } from '../git/backend.js';
import { serveCurrentState } from '../git/commit.js';
import { applyPush, type PushRefusal, PushRefused, type RefUpdate } from '../git/push.js';
import { ensureRepository } from '../git/repository.js';
import { loadProject } from '../projects/access.js';

/** Failed sign-ins tolerated per address before Git requests are refused for a while. */
const MAX_AUTH_FAILURES = 30;
const AUTH_FAILURE_WINDOW_MS = 15 * 60_000;
/** Fetch negotiation bodies list commits only; 10 MiB is far beyond any real one. */
const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024;

const GIT_CONTENT_TYPES = [
  'application/x-git-upload-pack-request',
  'application/x-git-receive-pack-request',
];

const repoParams = z.object({ repo: z.string().check(z.regex(/^[0-9a-f-]{36}(\.git)?$/)) });
const serviceQuery = z.object({
  service: z.optional(z.enum(['git-upload-pack', 'git-receive-pack'])),
});
const hookBody = z.object({
  updates: z
    .array(
      z.object({
        oldId: z.string().check(z.regex(/^[0-9a-f]{40,64}$/)),
        newId: z.string().check(z.regex(/^[0-9a-f]{40,64}$/)),
        ref: z.string().check(z.maxLength(1024)),
      }),
    )
    .check(z.maxLength(100)),
  objectDirectory: z.nullable(z.string().check(z.maxLength(4096))),
});

type Locale = 'fr' | 'en';

const refusalMessages: Record<PushRefusal['reason'], Record<Locale, (path: string) => string>> = {
  onlyMain: {
    fr: () => 'Seule la branche main peut être poussée, et elle ne peut pas être supprimée.',
    en: () => 'Only the main branch can be pushed, and it cannot be deleted.',
  },
  fetchFirst: {
    fr: () =>
      'Le projet a changé depuis votre dernière récupération : faites git pull, puis poussez.',
    en: () => 'The project changed since you last fetched: run git pull, then push again.',
  },
  symlink: {
    fr: (path) => `Les liens symboliques ne sont pas acceptés : ${path}`,
    en: (path) => `Symbolic links are not accepted: ${path}`,
  },
  submodule: {
    fr: (path) => `Les sous-modules ne sont pas acceptés : ${path}`,
    en: (path) => `Submodules are not accepted: ${path}`,
  },
  invalidPath: {
    fr: (path) => `Chemin refusé : ${path}`,
    en: (path) => `Path not accepted: ${path}`,
  },
  fileTooLarge: {
    fr: (path) => `Fichier trop volumineux : ${path}`,
    en: (path) => `File too large: ${path}`,
  },
  tooLarge: {
    fr: () => 'Le projet poussé est trop volumineux.',
    en: () => 'The pushed project is too large.',
  },
  tooManyFiles: {
    fr: () => 'Le projet poussé contient trop de fichiers.',
    en: () => 'The pushed project has too many files.',
  },
  quota: {
    fr: () => "L'espace de stockage du propriétaire du projet est plein.",
    en: () => "The project owner's storage space is full.",
  },
};

/** Git sends the user's language, from LANG, in Accept-Language. */
function localeOf(request: FastifyRequest): Locale {
  const header = request.headers['accept-language'] ?? '';
  return /^\s*en\b/i.test(header) ? 'en' : 'fr';
}

function refusalMessage(refusal: PushRefusal, locale: Locale): string {
  return `Galley : ${refusalMessages[refusal.reason][locale]('path' in refusal ? refusal.path : '')}`;
}

interface PendingPush {
  projectId: string;
  userId: string;
  gitDir: string;
  locale: Locale;
}

/**
 * Git smart HTTP (SPEC §3.5, §6.7): `/git/<projectId>` is a repository that
 * members clone and pull, and editors push to, with a personal access token
 * as password.
 */
export function gitRoutes(
  app: FastifyInstance,
  context: AppContext,
  limits: { maxEntries: number },
): void {
  const { database, redis, config } = context;
  const { db } = database;
  const maxPushBytes = config.GIT_MAX_PUSH_MB * 1024 * 1024;
  /** Pushes in progress, by the secret their hook presents. */
  const pending = new Map<string, PendingPush>();

  // Pack data is streamed to Git as it arrives, never parsed or buffered.
  app.addContentTypeParser(GIT_CONTENT_TYPES, (_request, payload, done) => {
    done(null, payload);
  });

  function plain(reply: FastifyReply, status: number, message: string) {
    return reply.status(status).type('text/plain; charset=utf-8').send(`${message}\n`);
  }

  /**
   * Authenticates by HTTP Basic, with a personal access token as password,
   * and checks the project role. Answers the request itself on failure.
   */
  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    role: ProjectRole,
  ): Promise<string | null> {
    const failures = `git:auth-failures:${request.ip}`;
    if (Number((await redis.get(failures)) ?? 0) >= MAX_AUTH_FAILURES) {
      await plain(reply, 429, 'Too many failed attempts, try again later.');
      return null;
    }
    const header = request.headers.authorization ?? '';
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header);
    const decoded = match?.[1] === undefined ? '' : Buffer.from(match[1], 'base64').toString();
    const password = decoded.slice(decoded.indexOf(':') + 1);
    const identity = match ? await authenticateAccessToken(db, password) : null;
    if (!identity) {
      if (match) {
        await redis.multi().incr(failures).pexpire(failures, AUTH_FAILURE_WINDOW_MS).exec();
      }
      await reply
        .header('www-authenticate', 'Basic realm="Galley", charset="UTF-8"')
        .status(401)
        .type('text/plain; charset=utf-8')
        .send('Authentication required: use a personal access token as password.\n');
      return null;
    }
    try {
      await loadProject(db, projectId, identity.userId, role);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await plain(
        reply,
        error.code === 'FORBIDDEN' ? 403 : 404,
        error.code === 'FORBIDDEN' ? 'Read-only access.' : 'Repository not found.',
      );
      return null;
    }
    return identity.userId;
  }

  async function backend(
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
    service: GitService,
    mode: 'advertise' | 'rpc',
    env?: Record<string, string>,
  ) {
    const maxBodyBytes = service === 'receive-pack' ? maxPushBytes : MAX_FETCH_BODY_BYTES;
    if (Number(request.headers['content-length'] ?? 0) > maxBodyBytes) {
      return plain(reply, 413, 'Request too large.');
    }
    const protocol = String(request.headers['git-protocol'] ?? '');
    const body = runService({
      gitDir: await ensureRepository(config, projectId),
      service,
      mode,
      // The content-type parser above hands POST bodies over as the raw stream.
      body: mode === 'rpc' ? (request.body as Readable) : null,
      gzip: request.headers['content-encoding'] === 'gzip',
      gitProtocol: /^[\w=:.]{1,64}$/.test(protocol) ? protocol : undefined,
      maxBodyBytes,
      ...(env === undefined ? {} : { env }),
      onTooLarge: () => {
        request.log.warn({ projectId }, 'git request body too large');
      },
    });
    return reply
      .header('content-type', serviceContentType(service, mode))
      .header('cache-control', 'no-cache, max-age=0, must-revalidate')
      .send(body);
  }

  function projectOf(request: FastifyRequest): string {
    return repoParams.parse(request.params).repo.replace(/\.git$/, '');
  }

  app.get('/git/:repo/info/refs', async (request, reply) => {
    const projectId = projectOf(request);
    const { service } = serviceQuery.parse(request.query);
    // Dumb HTTP is not offered: clients always name a service.
    if (service === undefined) return plain(reply, 403, 'Smart HTTP only.');
    const userId = await authorize(
      request,
      reply,
      projectId,
      service === 'git-receive-pack' ? 'editor' : 'reader',
    );
    if (userId === null) return reply;
    await serveCurrentState(context, projectId);
    return backend(
      request,
      reply,
      projectId,
      service === 'git-receive-pack' ? 'receive-pack' : 'upload-pack',
      'advertise',
    );
  });

  app.post('/git/:repo/git-upload-pack', async (request, reply) => {
    const projectId = projectOf(request);
    const userId = await authorize(request, reply, projectId, 'reader');
    if (userId === null) return reply;
    return backend(request, reply, projectId, 'upload-pack', 'rpc');
  });

  app.post('/git/:repo/git-receive-pack', async (request, reply) => {
    const projectId = projectOf(request);
    const userId = await authorize(request, reply, projectId, 'editor');
    if (userId === null) return reply;
    const gitDir = await ensureRepository(config, projectId);
    const token = randomToken();
    // A server answering requests listens on TCP, so its address is an AddressInfo.
    const { port } = app.server.address() as AddressInfo;
    pending.set(token, { projectId, userId, gitDir, locale: localeOf(request) });
    reply.raw.on('close', () => pending.delete(token));
    return backend(request, reply, projectId, 'receive-pack', 'rpc', {
      GALLEY_HOOK_URL: `http://127.0.0.1:${String(port)}/internal/git/pre-receive`,
      GALLEY_PUSH_TOKEN: token,
    });
  });

  // Called by the pre-receive hook only; Caddy does not route /internal.
  app.post('/internal/git/pre-receive', async (request, reply) => {
    const secret = String(request.headers['x-galley-push'] ?? '');
    const entry = [...pending].find(([token]) => safeEqual(token, secret));
    if (!entry) return reply.status(403).send({ message: 'Galley: unknown push.' });
    const push = entry[1];
    const body = hookBody.parse(request.body);
    try {
      await applyPush(
        context,
        {
          projectId: push.projectId,
          userId: push.userId,
          gitDir: push.gitDir,
          updates: body.updates satisfies RefUpdate[],
          objectDirectory: body.objectDirectory,
        },
        { maxBytes: maxPushBytes, maxEntries: limits.maxEntries },
      );
    } catch (error) {
      if (error instanceof PushRefused) {
        return reply.status(409).send({ message: refusalMessage(error.refusal, push.locale) });
      }
      request.log.error({ err: error, projectId: push.projectId }, 'push failed');
      return reply.status(500).send({ message: 'Galley : erreur interne / internal error.' });
    }
    return { message: null };
  });
}

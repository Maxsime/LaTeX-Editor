import {
  ApiError,
  type AuthConfigResponse,
  authConfigResponse,
  loginRequest,
  registerRequest,
  type SessionResponse,
  setupRequest,
} from '@galley/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clearSessionCookie, requireAuth, setSessionCookie } from '../auth/plugin.js';
import { verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/sessions.js';
import { checkSetupCode, clearSetupCode } from '../auth/setup.js';
import { tokenDigest } from '../auth/tokens.js';
import { countUsers, createUser, findUserByLogin, toPublicUser } from '../auth/users.js';
import type { AppContext } from '../context.js';
import { registrationInvites } from '@galley/db';
import { parse } from '../http/validate.js';

/** Brute-force guard for credential endpoints, per client address. */
const credentialRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/**
 * Sign-in attempts are counted per address and account, so that a password
 * guessing run is stopped without locking out a whole classroom behind one NAT.
 * The body is only parsed by the preHandler stage, hence the hook.
 */
const loginRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (request: FastifyRequest): string => {
      const body = request.body;
      const login =
        typeof body === 'object' &&
        body !== null &&
        'login' in body &&
        typeof body.login === 'string'
          ? body.login.toLowerCase().slice(0, 320)
          : '';
      return `login:${request.ip}:${login}`;
    },
  },
};

/** Arbitrary constant serialising first-account creation across API instances. */
const SETUP_LOCK_KEY = 7_265_830_142;

export function authRoutes(app: FastifyInstance, context: AppContext): void {
  const { database, config, redis } = context;

  async function startSession(
    reply: Parameters<typeof setSessionCookie>[0],
    userId: string,
    userAgent: string | undefined,
  ): Promise<void> {
    const { token, expiresAt } = await createSession(
      database,
      userId,
      config.SESSION_TTL_DAYS,
      userAgent,
    );
    setSessionCookie(reply, token, expiresAt);
  }

  app.get(
    '/api/auth/config',
    { config: { public: true } },
    async (): Promise<AuthConfigResponse> => {
      return authConfigResponse.parse({
        registrationMode: config.REGISTRATION_MODE,
        setupRequired: (await countUsers(database.db)) === 0,
      });
    },
  );

  app.get('/api/auth/session', { config: { public: true } }, (request): SessionResponse => {
    return request.auth
      ? { user: request.auth.user, csrfToken: request.auth.csrfToken }
      : { user: null, csrfToken: null };
  });

  app.post(
    '/api/auth/setup',
    { config: { public: true, ...credentialRateLimit } },
    async (request, reply) => {
      const body = parse(setupRequest, request.body);
      if (!(await checkSetupCode(redis, body.setupCode))) {
        throw new ApiError('FORBIDDEN', 'invalid setup code');
      }
      const user = await database.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
        if ((await countUsers(tx)) > 0) {
          throw new ApiError('CONFLICT', 'setup already done');
        }
        return createUser(tx, body, true);
      });
      await clearSetupCode(redis);
      request.log.info({ userId: user.id }, 'administrator account created');
      await startSession(reply, user.id, request.headers['user-agent']);
      return reply.status(201).send({ user });
    },
  );

  app.post(
    '/api/auth/register',
    { config: { public: true, ...credentialRateLimit } },
    async (request, reply) => {
      const body = parse(registerRequest, request.body);
      if (config.REGISTRATION_MODE === 'closed') {
        throw new ApiError('FORBIDDEN', 'registration closed');
      }
      const user = await database.db.transaction(async (tx) => {
        let inviteId: string | undefined;
        if (config.REGISTRATION_MODE === 'invite') {
          if (!body.inviteToken) throw new ApiError('FORBIDDEN', 'invite required');
          // Locks the invite row so that one invite cannot create two accounts.
          const [invite] = await tx
            .select({ id: registrationInvites.id })
            .from(registrationInvites)
            .where(
              and(
                eq(registrationInvites.tokenHash, tokenDigest(body.inviteToken)),
                isNull(registrationInvites.usedAt),
                gt(registrationInvites.expiresAt, new Date()),
              ),
            )
            .for('update');
          if (!invite) throw new ApiError('FORBIDDEN', 'invalid invite');
          inviteId = invite.id;
        }
        const created = await createUser(tx, body);
        if (inviteId) {
          await tx
            .update(registrationInvites)
            .set({ usedAt: new Date(), usedBy: created.id })
            .where(eq(registrationInvites.id, inviteId));
        }
        return created;
      });
      await startSession(reply, user.id, request.headers['user-agent']);
      return reply.status(201).send({ user });
    },
  );

  app.post(
    '/api/auth/login',
    { config: { public: true, ...loginRateLimit } },
    async (request, reply) => {
      const body = parse(loginRequest, request.body);
      const row = await findUserByLogin(database.db, body.login);
      // An account without a password (created through OIDC) is checked like an
      // unknown one, so that timing does not tell them apart.
      const hash = row?.passwordHash ?? null;
      const valid =
        hash === null
          ? await verifyAgainstDummy(body.password)
          : await verifyPassword(hash, body.password);
      if (!row || !valid) {
        throw new ApiError('UNAUTHENTICATED', 'invalid credentials');
      }
      if (request.auth) await deleteSession(database, request.auth.sessionId);
      await startSession(reply, row.id, request.headers['user-agent']);
      return { user: toPublicUser(row) };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    await deleteSession(database, auth.sessionId);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });
}

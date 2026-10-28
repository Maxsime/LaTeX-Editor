import {
  ApiError,
  type AuthConfigResponse,
  authConfigResponse,
  loginRequest,
  passwordResetConfirm,
  passwordResetRequest,
  registerRequest,
  type SessionResponse,
  setupRequest,
} from '@galley/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as z from 'zod/mini';
import { clearSessionCookie, requireAuth, setSessionCookie } from '../auth/plugin.js';
import { verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { confirmPasswordReset, requestPasswordReset } from '../auth/password-reset.js';
import { createSession, deleteSession } from '../auth/sessions.js';
import { checkSetupCode, clearSetupCode } from '../auth/setup.js';
import { safeEqual, tokenDigest } from '../auth/tokens.js';
import { countUsers, createUser, findUserByLogin, toPublicUser } from '../auth/users.js';
import { instanceSettingsOf } from '../admin/settings.js';
import {
  accountForIdentity,
  OIDC_CALLBACK_PATH,
  OidcClient,
  oidcEnabled,
  publicOrigin,
  safeRedirect,
} from '../auth/oidc.js';
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

const OIDC_STATE_COOKIE = 'galley_oidc_state';
const OIDC_KEY_PREFIX = 'galley:oidc:';
/** Time a person has to sign in at the provider. */
const OIDC_PENDING_SECONDS = 600;

const oidcStartQuery = z.object({ redirect: z.optional(z.string().check(z.maxLength(2_000))) });
const oidcCallbackQuery = z.object({ state: z.string().check(z.minLength(1), z.maxLength(200)) });

/** What the start of a sign-in leaves for its return, kept in Valkey under its state. */
const pendingSignIn = z.object({ nonce: z.string(), verifier: z.string(), redirect: z.string() });
type PendingSignIn = z.infer<typeof pendingSignIn>;

/** A loggable reason: library messages name the failed check, never a token. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown';
}

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
        registrationMode: (await instanceSettingsOf(context).get()).registrationMode,
        setupRequired: (await countUsers(database.db)) === 0,
        oidc: oidcEnabled(config) ? { displayName: config.OIDC_DISPLAY_NAME } : null,
        mail: context.mailer !== undefined,
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
      const { registrationMode } = await instanceSettingsOf(context).get();
      if (registrationMode === 'closed') {
        throw new ApiError('FORBIDDEN', 'registration closed');
      }
      const user = await database.db.transaction(async (tx) => {
        let inviteId: string | undefined;
        if (registrationMode === 'invite') {
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

  // --- Password reset by e-mail (SPEC §3.9) -------------------------------------------

  app.post(
    '/api/auth/password-reset',
    { config: { public: true, ...credentialRateLimit } },
    async (request, reply) => {
      const { mailer } = context;
      if (mailer === undefined) throw new ApiError('MAIL_DISABLED');
      const { email } = parse(passwordResetRequest, request.body);
      // Answered before the lookup, so that neither the reply nor its latency
      // tells whether an account uses this address.
      requestPasswordReset(database, mailer, publicOrigin(config), email, new Date()).then(
        (sent) => {
          if (sent) request.log.info('password reset link sent');
        },
        (error: unknown) => {
          request.log.error({ reason: reasonOf(error) }, 'password reset request failed');
        },
      );
      return reply.status(202).send();
    },
  );

  app.post(
    '/api/auth/password-reset/confirm',
    { config: { public: true, ...credentialRateLimit } },
    async (request, reply) => {
      const { token, password } = parse(passwordResetConfirm, request.body);
      const userId = await confirmPasswordReset(database, token, password, new Date());
      request.log.info({ userId }, 'password reset through an e-mail link');
      return reply.status(204).send();
    },
  );

  // --- Identity provider (OIDC) ------------------------------------------------------

  const oidc = new OidcClient(config);
  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/api/auth/oidc/',
  };

  app.get(
    '/api/auth/oidc/start',
    { config: { public: true, ...credentialRateLimit } },
    async (request, reply) => {
      if (!oidcEnabled(config)) throw new ApiError('OIDC_NOT_CONFIGURED');
      const { redirect } = parse(oidcStartQuery, request.query);
      let started;
      try {
        started = await oidc.start();
      } catch (error) {
        request.log.warn({ reason: reasonOf(error) }, 'identity provider unreachable');
        return reply.redirect('/login?error=OIDC_FAILED');
      }
      const pending: PendingSignIn = {
        nonce: started.nonce,
        verifier: started.verifier,
        redirect: safeRedirect(redirect),
      };
      await redis.set(
        `${OIDC_KEY_PREFIX}${started.state}`,
        JSON.stringify(pending),
        'EX',
        OIDC_PENDING_SECONDS,
      );
      // Binds the sign-in to this browser, so that a link carrying someone
      // else's state cannot sign the victim into the attacker's account.
      void reply.setCookie(OIDC_STATE_COOKIE, started.state, {
        ...cookieOptions,
        maxAge: OIDC_PENDING_SECONDS,
      });
      return reply.redirect(started.url);
    },
  );

  app.get(
    OIDC_CALLBACK_PATH,
    { config: { public: true, ...credentialRateLimit } },
    async (request, reply) => {
      void reply.clearCookie(OIDC_STATE_COOKIE, cookieOptions);
      let target: string;
      try {
        if (!oidcEnabled(config)) throw new ApiError('OIDC_NOT_CONFIGURED');
        const { state } = parse(oidcCallbackQuery, request.query);
        const bound = request.cookies[OIDC_STATE_COOKIE];
        if (bound === undefined || !safeEqual(bound, state)) {
          throw new ApiError('OIDC_FAILED', 'state not bound to this browser');
        }
        const stored = await redis.getdel(`${OIDC_KEY_PREFIX}${state}`);
        if (stored === null) throw new ApiError('OIDC_FAILED', 'unknown or expired state');
        const pending = pendingSignIn.parse(JSON.parse(stored));
        const query = request.url.slice(request.url.indexOf('?'));
        const claims = await oidc.finish(query, { state, ...pending });
        const { registrationMode } = await instanceSettingsOf(context).get();
        const policy = {
          issuer: oidc.issuer,
          allowSignup: config.OIDC_ALLOW_SIGNUP || registrationMode === 'open',
        };
        const outcome = await database.db.transaction((tx) =>
          accountForIdentity(tx, policy, claims),
        );
        request.log.info(
          { userId: outcome.user.id, created: outcome.created, linked: outcome.linked },
          'signed in through the identity provider',
        );
        if (request.auth) await deleteSession(database, request.auth.sessionId);
        await startSession(reply, outcome.user.id, request.headers['user-agent']);
        target = pending.redirect;
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'OIDC_FAILED';
        request.log.warn({ code, reason: reasonOf(error) }, 'identity provider sign-in refused');
        target = `/login?error=${code}`;
      }
      return reply.redirect(target);
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = requireAuth(request);
    await deleteSession(database, auth.sessionId);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });
}

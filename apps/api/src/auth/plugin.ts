import cookie from '@fastify/cookie';
import { ApiError, CSRF_HEADER, SESSION_COOKIE } from '@galley/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { type AuthenticatedSession, findSession } from './sessions.js';
import { safeEqual } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Session of the signed-in user, or `null` for anonymous requests. */
    auth: AuthenticatedSession | null;
  }
  interface FastifyContextConfig {
    /** Routes reachable without a session (sign-in, registration). CSRF falls back to the Origin check. */
    public?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Sets the session cookie with the attributes CLAUDE.md requires. */
export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * A browser always sends Origin on cross-site state-changing requests; when it
 * is present it must name the host the request was addressed to.
 */
function originMatches(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/**
 * Resolves the session on every request, then guards state-changing requests
 * with an Origin check and the per-session CSRF token. Routes are private by
 * default: only those flagged `config.public` accept anonymous requests.
 */
export async function registerAuth(app: FastifyInstance, context: AppContext): Promise<void> {
  await app.register(cookie);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.auth = token
      ? await findSession(context.database, token, context.config.SESSION_TTL_DAYS)
      : null;
    if (request.auth) {
      request.log = request.log.child({ userId: request.auth.user.id });
    }
  });

  app.addHook('preHandler', (request, _reply, done) => {
    done(guard(request));
  });
}

/** Returns the error that refuses the request, if any. */
function guard(request: FastifyRequest): ApiError | undefined {
  const route = request.routeOptions.url;
  // Only feature routes are guarded; health, metrics and 404s stay untouched.
  if (route === undefined || !route.startsWith('/api/') || route.startsWith('/api/health/')) {
    return undefined;
  }
  if (request.routeOptions.config.public !== true && !request.auth) {
    return new ApiError('UNAUTHENTICATED');
  }
  if (SAFE_METHODS.has(request.method)) return undefined;
  if (!originMatches(request)) {
    return new ApiError('FORBIDDEN', 'origin mismatch');
  }
  if (request.auth) {
    const sent = request.headers[CSRF_HEADER];
    if (typeof sent !== 'string' || !safeEqual(sent, request.auth.csrfToken)) {
      return new ApiError('FORBIDDEN', 'csrf token mismatch');
    }
  }
  return undefined;
}

/** Narrows `request.auth` inside handlers of private routes. */
export function requireAuth(request: FastifyRequest): AuthenticatedSession {
  if (!request.auth) throw new ApiError('UNAUTHENTICATED');
  return request.auth;
}

/** Restricts a handler to instance administrators. */
export function requireAdmin(request: FastifyRequest): AuthenticatedSession {
  const auth = requireAuth(request);
  if (!auth.user.isAdmin) throw new ApiError('FORBIDDEN');
  return auth;
}

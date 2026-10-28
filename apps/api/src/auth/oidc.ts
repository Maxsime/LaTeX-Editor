import { type Executor, userIdentities, users } from '@galley/db';
import { ApiError, type PublicUser, username as usernameSchema } from '@galley/shared';
import { and, eq } from 'drizzle-orm';
import * as client from 'openid-client';
import type { ApiConfig } from '../config.js';
import { createUser, toPublicUser } from './users.js';

/** Whether sign-in through an identity provider is configured. */
export function oidcEnabled(config: ApiConfig): boolean {
  return Boolean(config.OIDC_ISSUER) && Boolean(config.OIDC_CLIENT_ID);
}

/** Address of the instance as browsers reach it, from the host and port behind Caddy. */
export function publicOrigin(config: ApiConfig): string {
  const port = config.GALLEY_HTTPS_PORT === 443 ? '' : `:${String(config.GALLEY_HTTPS_PORT)}`;
  return `https://${config.GALLEY_HOST}${port}`;
}

export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

/**
 * Keeps a post-sign-in destination inside the instance: a path, never a
 * scheme-relative `//host` or a backslash that some browsers read as one.
 */
export function safeRedirect(target: string | undefined): string {
  if (!target?.startsWith('/')) return '/';
  if (target.startsWith('//') || target.includes('\\')) return '/';
  return target;
}

/** The claims the account logic needs, as the provider asserted them. */
export interface OidcClaims {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  preferredUsername: string | null;
  name: string | null;
}

/** Reads the ID token claims, tolerating providers that omit the optional ones. */
export function claimsOf(raw: Record<string, unknown>): OidcClaims {
  const text = (key: string) => {
    const value = raw[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  const subject = text('sub');
  if (subject === null) throw new ApiError('OIDC_FAILED', 'no subject');
  return {
    subject,
    email: text('email')?.toLowerCase() ?? null,
    // Some providers send the string "true".
    emailVerified: raw.email_verified === true || raw.email_verified === 'true',
    preferredUsername: text('preferred_username'),
    name: text('name'),
  };
}

/**
 * A valid username derived from the provider's claims: its preferred username,
 * else the e-mail's local part, with forbidden characters replaced.
 */
export function usernameCandidate(claims: OidcClaims): string {
  const source = claims.preferredUsername ?? claims.email?.split('@')[0] ?? 'user';
  let name = source
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^[._-]+/, '')
    .slice(0, 32);
  if (name.length < 2) name = `user${name}`;
  return name;
}

/** Number of suffixed usernames tried before giving up on a name collision. */
const USERNAME_ATTEMPTS = 20;

/** How the first sign-in of an identity may end. */
export interface OidcAccountPolicy {
  issuer: string;
  /** Whether an identity without an account may create one. */
  allowSignup: boolean;
}

/**
 * The account an identity signs in as. Known identities sign in directly; a
 * new one is linked to the account with the same e-mail address when the
 * provider vouches for it, or creates an account when the policy allows.
 */
export async function accountForIdentity(
  db: Executor,
  policy: OidcAccountPolicy,
  claims: OidcClaims,
): Promise<{ user: PublicUser; created: boolean; linked: boolean }> {
  const [known] = await db
    .select({ user: users })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(
      and(eq(userIdentities.issuer, policy.issuer), eq(userIdentities.subject, claims.subject)),
    );
  if (known) {
    if (known.user.disabledAt !== null) throw new ApiError('FORBIDDEN', 'account disabled');
    return { user: toPublicUser(known.user), created: false, linked: false };
  }
  // Linking on an unverified address would let anyone claim an account by
  // typing its address at a lax provider.
  if (claims.email === null || !claims.emailVerified) throw new ApiError('OIDC_EMAIL_UNVERIFIED');
  const [existing] = await db.select().from(users).where(eq(users.email, claims.email));
  if (existing) {
    if (existing.disabledAt !== null) throw new ApiError('FORBIDDEN', 'account disabled');
    await db
      .insert(userIdentities)
      .values({ userId: existing.id, issuer: policy.issuer, subject: claims.subject });
    return { user: toPublicUser(existing), created: false, linked: true };
  }
  if (!policy.allowSignup) throw new ApiError('OIDC_SIGNUP_CLOSED');
  const base = usernameCandidate(claims);
  for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 32)}-${String(attempt + 1)}`;
    if (!usernameSchema.safeParse(candidate).success) break;
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate));
    if (taken) continue;
    const user = await createUser(db, {
      email: claims.email,
      username: candidate,
      displayName: (claims.name ?? candidate).slice(0, 100),
      password: null,
    });
    await db
      .insert(userIdentities)
      .values({ userId: user.id, issuer: policy.issuer, subject: claims.subject });
    return { user, created: true, linked: false };
  }
  throw new ApiError('OIDC_FAILED', 'no free username');
}

/** The provider's configuration, discovered once and kept while it works. */
export class OidcClient {
  private discovered: Promise<client.Configuration> | null = null;

  constructor(private readonly config: ApiConfig) {}

  get issuer(): string {
    return this.config.OIDC_ISSUER ?? '';
  }

  get redirectUri(): string {
    return `${publicOrigin(this.config)}${OIDC_CALLBACK_PATH}`;
  }

  /** Discovers the provider; a failure is retried on the next sign-in. */
  configuration(): Promise<client.Configuration> {
    this.discovered ??= this.discover().catch((error: unknown) => {
      this.discovered = null;
      throw error;
    });
    return this.discovered;
  }

  private async discover(): Promise<client.Configuration> {
    const { OIDC_CLIENT_ID, OIDC_CLIENT_SECRET } = this.config;
    const issuer = new URL(this.issuer);
    const http = issuer.protocol === 'http:';
    const configuration = await client.discovery(
      issuer,
      OIDC_CLIENT_ID ?? '',
      undefined,
      OIDC_CLIENT_SECRET ? client.ClientSecretPost(OIDC_CLIENT_SECRET) : client.None(),
      // A plain-HTTP issuer is what the administrator configured (a provider on
      // the internal network, or the tests' simulated one); HTTPS is the rule.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- flagged only to stand out, see above
      http ? { execute: [client.allowInsecureRequests] } : undefined,
    );
    return configuration;
  }

  /** Starts a sign-in: the provider's address and the secrets to check on return. */
  async start(): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
    const configuration = await this.configuration();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: this.config.OIDC_SCOPES,
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    return { url: url.href, state, nonce, verifier };
  }

  /** Exchanges the code the provider returned and checks the ID token. */
  async finish(
    callbackQuery: string,
    expected: { state: string; nonce: string; verifier: string },
  ): Promise<OidcClaims> {
    const configuration = await this.configuration();
    const tokens = await client.authorizationCodeGrant(
      configuration,
      new URL(`${this.redirectUri}${callbackQuery}`),
      {
        pkceCodeVerifier: expected.verifier,
        expectedState: expected.state,
        expectedNonce: expected.nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (claims === undefined) throw new ApiError('OIDC_FAILED', 'no ID token');
    return claimsOf(claims);
  }
}

import * as z from 'zod/mini';

export const registrationMode = z.enum(['open', 'invite', 'closed']);
export type RegistrationMode = z.infer<typeof registrationMode>;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 1024;

export const password = z
  .string()
  .check(z.minLength(PASSWORD_MIN_LENGTH), z.maxLength(PASSWORD_MAX_LENGTH));

export const email = z.email().check(z.maxLength(320));

/** Letters, digits, dot, dash and underscore; used in mentions and Git URLs later on. */
export const username = z
  .string()
  .check(z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,38}$/, 'invalid username'));

export const displayName = z.string().check(z.minLength(1), z.maxLength(100));

export const registerRequest = z.object({
  email,
  username,
  displayName,
  password,
  inviteToken: z.optional(z.string().check(z.maxLength(200))),
});
export type RegisterRequest = z.infer<typeof registerRequest>;

export const setupRequest = z.object({
  setupCode: z.string().check(z.minLength(1), z.maxLength(200)),
  email,
  username,
  displayName,
  password,
});
export type SetupRequest = z.infer<typeof setupRequest>;

export const loginRequest = z.object({
  /** E-mail address or username. */
  login: z.string().check(z.minLength(1), z.maxLength(320)),
  password: z.string().check(z.minLength(1), z.maxLength(PASSWORD_MAX_LENGTH)),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const publicUser = z.object({
  id: z.uuid(),
  email: z.string(),
  username: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
});
export type PublicUser = z.infer<typeof publicUser>;

export const sessionResponse = z.object({
  user: z.nullable(publicUser),
  /** Echoed in the `X-CSRF-Token` header of every state-changing request. */
  csrfToken: z.nullable(z.string()),
});
export type SessionResponse = z.infer<typeof sessionResponse>;

export const authConfigResponse = z.object({
  registrationMode,
  /** True while no account exists: the first one is created with the setup code. */
  setupRequired: z.boolean(),
  /** Sign-in through the instance's identity provider, when one is configured. */
  oidc: z.nullable(z.object({ displayName: z.string() })),
});
export type AuthConfigResponse = z.infer<typeof authConfigResponse>;

export const createInviteRequest = z.object({
  expiresInDays: z._default(z.number().check(z.int(), z.gte(1), z.lte(90)), 7),
});

export const invite = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  expiresAt: z.string(),
  usedAt: z.nullable(z.string()),
});
export type Invite = z.infer<typeof invite>;

export const createdInvite = z.object({
  invite,
  /** Shown once; only its digest is stored. */
  token: z.string(),
});
export type CreatedInvite = z.infer<typeof createdInvite>;

export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_COOKIE = '__Host-galley_session';

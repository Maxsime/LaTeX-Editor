import * as z from 'zod/mini';
import { aiCapabilities, aiProvider, MAX_API_KEY_LENGTH } from './ai.js';
import { displayName, email, registrationMode, username } from './auth.js';

// --- Quotas -----------------------------------------------------------------------

/** Largest quota accepted: 10 TB, or a month and a half of compilation. */
const MAX_QUOTA = 10_000_000;

/** An instance-wide limit; null means unlimited. */
const limit = z.nullable(z.number().check(z.int(), z.positive(), z.lte(MAX_QUOTA)));

/** Default limits of the instance (SPEC §3.9). */
export const instanceQuotas = z.object({
  /** Megabytes of project files a person may own. */
  storageMb: limit,
  /** Minutes of compilation a person may start per calendar month. */
  compileMinutes: limit,
});
export type InstanceQuotas = z.infer<typeof instanceQuotas>;

/** A person's own limit: null follows the instance default, -1 is unlimited. */
const override = z.nullable(z.number().check(z.int(), z.gte(-1), z.lte(MAX_QUOTA)));

export const userQuotaOverride = z.object({ storageMb: override, compileMinutes: override });
export type UserQuotaOverride = z.infer<typeof userQuotaOverride>;

/** What a person used and may use; null limits are unlimited. */
export const quotaUsage = z.object({
  storage: z.object({ usedBytes: z.number(), limitBytes: z.nullable(z.number()) }),
  compile: z.object({
    usedSeconds: z.number(),
    limitSeconds: z.nullable(z.number()),
    /** Start of the counted month, ISO 8601. */
    since: z.string(),
  }),
});
export type QuotaUsage = z.infer<typeof quotaUsage>;

// --- Instance settings ------------------------------------------------------------

/** The instance's default model as the console shows it: the key only by its last characters. */
export const instanceAiDefault = z.object({
  provider: aiProvider,
  model: z.string(),
  baseUrl: z.nullable(z.string()),
  keyHint: z.nullable(z.string()),
  vision: z.nullable(z.boolean()),
  contextTokens: z.nullable(z.number()),
});
export type InstanceAiDefault = z.infer<typeof instanceAiDefault>;

/** Response of `GET /api/admin/settings`: effective values and where each one comes from. */
export const instanceSettingsResponse = z.object({
  registrationMode,
  quotas: instanceQuotas,
  aiEnabled: z.boolean(),
  aiDefault: z.nullable(instanceAiDefault),
  /** Settings changed in the console; the others follow the environment. */
  overridden: z.array(z.string()),
});
export type InstanceSettingsResponse = z.infer<typeof instanceSettingsResponse>;

/** Body of `PATCH /api/admin/settings`; an absent field is left as it is. */
export const updateInstanceSettingsRequest = z.object({
  registrationMode: z.optional(registrationMode),
  quotas: z.optional(instanceQuotas),
  aiEnabled: z.optional(z.boolean()),
  /** Null removes the console's default model, falling back on the environment. */
  aiDefault: z.optional(
    z.nullable(
      z.object({
        provider: aiProvider,
        model: z.string().check(z.trim(), z.minLength(1), z.maxLength(200)),
        baseUrl: z.nullable(z.url({ protocol: /^https?$/ }).check(z.maxLength(500))),
        /** Absent keeps the stored key when the provider is unchanged. */
        apiKey: z.optional(
          z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_API_KEY_LENGTH)),
        ),
        vision: z.nullable(z.boolean()),
        contextTokens: z.nullable(z.number().check(z.int(), z.gte(2_000), z.lte(10_000_000))),
      }),
    ),
  ),
});
export type UpdateInstanceSettingsRequest = z.input<typeof updateInstanceSettingsRequest>;

// --- Users ------------------------------------------------------------------------

export const adminUser = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean(),
  /** Whether the account can sign in with a password (not only through OIDC). */
  hasPassword: z.boolean(),
  oidc: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.nullable(z.string()),
  storageBytes: z.number(),
  compileSecondsThisMonth: z.number(),
  quotas: userQuotaOverride,
});
export type AdminUser = z.infer<typeof adminUser>;

export const adminUsersQuery = z.object({
  q: z.optional(z.string().check(z.maxLength(200))),
  offset: z._default(z.coerce.number().check(z.int(), z.gte(0)), 0),
});

export const ADMIN_USERS_PAGE = 50;

export const adminUsersResponse = z.object({ users: z.array(adminUser), total: z.number() });
export type AdminUsersResponse = z.infer<typeof adminUsersResponse>;

/** Body of `POST /api/admin/users`: the account gets a temporary password. */
export const createUserRequest = z.object({
  email,
  username,
  displayName,
  isAdmin: z._default(z.boolean(), false),
});
export type CreateUserRequest = z.input<typeof createUserRequest>;

/** Body of `PATCH /api/admin/users/:id`. */
export const updateUserRequest = z.object({
  isAdmin: z.optional(z.boolean()),
  disabled: z.optional(z.boolean()),
  quotas: z.optional(userQuotaOverride),
});
export type UpdateUserRequest = z.infer<typeof updateUserRequest>;

/** Answer of user creation and password reset: shown once, never stored in clear. */
export const temporaryPasswordResponse = z.object({
  user: adminUser,
  temporaryPassword: z.string(),
});
export type TemporaryPasswordResponse = z.infer<typeof temporaryPasswordResponse>;

// --- Services ---------------------------------------------------------------------

/** Response of `GET /api/admin/system`. */
export const systemStatus = z.object({
  version: z.string(),
  compileQueue: z.object({
    waiting: z.number(),
    active: z.number(),
    delayed: z.number(),
    failed: z.number(),
  }),
  /** Compilations of the last 24 hours by outcome. */
  compilesLastDay: z.record(z.string(), z.number()),
  texliveVersion: z.nullable(z.string()),
  users: z.object({ total: z.number(), active30Days: z.number() }),
  projects: z.number(),
  storageBytes: z.number(),
  oidc: z.nullable(z.object({ issuer: z.string() })),
});
export type SystemStatus = z.infer<typeof systemStatus>;

/** Capabilities of the default model, for the console. */
export const instanceAiCapabilities = z.nullable(aiCapabilities);

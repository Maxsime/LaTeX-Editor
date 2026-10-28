import * as z from 'zod/mini';
import { aiProvider } from './ai.js';
import { registrationMode } from './auth.js';

/**
 * Raised when environment variables do not satisfy a service's schema.
 * The message lists offending variable names and reasons, never their values,
 * so it is safe to print even when the variable holds a secret.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Validates `env` against `schema` and returns the parsed configuration.
 *
 * @throws {ConfigError} listing every invalid or missing variable.
 */
export function loadConfig<Schema extends z.ZodMiniType>(
  schema: Schema,
  env: Record<string, string | undefined>,
): z.output<Schema> {
  const result = schema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join('.') || '(root)';
    return `${key}: ${issue.message}`;
  });
  throw new ConfigError(issues);
}

const port = z.coerce.number().check(z.int(), z.gte(1), z.lte(65_535));

/** Accepts the usual spellings of a boolean flag in environment variables. */
const booleanFlag = z.pipe(
  z.enum(['true', 'false', '1', '0']),
  z.transform((value) => value === 'true' || value === '1'),
);

/** An optional variable that compose may pass as an empty string, which means unset. */
function blankable<T extends z.ZodMiniType>(schema: T) {
  return z.optional(z.union([z.literal(''), schema]));
}

export const commonEnv = z.object({
  NODE_ENV: z._default(z.enum(['development', 'production', 'test']), 'development'),
  LOG_LEVEL: z._default(
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    'info',
  ),
});

export const postgresEnv = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export const valkeyEnv = z.object({
  VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
});

export const s3Env = z.object({
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  S3_REGION: z._default(z.string().check(z.minLength(1)), 'us-east-1'),
  S3_ACCESS_KEY_ID: z.string().check(z.minLength(1)),
  S3_SECRET_ACCESS_KEY: z.string().check(z.minLength(8)),
  S3_BUCKET: z
    .string()
    .check(z.regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be a valid S3 bucket name')),
  // Self-hosted S3 implementations rarely support virtual-hosted-style buckets.
  S3_FORCE_PATH_STYLE: z._default(booleanFlag, true),
});

/** Base64 of exactly 32 bytes: an AES-256 key. */
const masterKey = z
  .string()
  .check(
    z.refine(
      (value) => /^[A-Za-z0-9+/]{43}=$/.test(value),
      'must be base64 of 32 bytes (openssl rand -base64 32)',
    ),
  );

/** Shared secret of the internal routes between api and collab, never exposed by the proxy. */
const internalToken = z.string().check(z.minLength(32, 'must be at least 32 characters'));

export const apiEnv = z
  .object({
    ...commonEnv.shape,
    ...postgresEnv.shape,
    ...valkeyEnv.shape,
    ...s3Env.shape,
    API_HOST: z._default(z.string(), '0.0.0.0'),
    API_PORT: z._default(port, 3000),
    REGISTRATION_MODE: z._default(registrationMode, 'invite'),
    SESSION_TTL_DAYS: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(365)), 30),
    /** Scratch space for uploads and archive imports; must hold the largest accepted archive. */
    API_TMP_DIR: z._default(z.string(), '/tmp'),
    /** Bare repositories of the Git bridge, one per project. */
    GIT_DATA_DIR: z._default(z.string(), '/var/lib/galley/git'),
    /** Largest pack a single `git push` may send. */
    GIT_MAX_PUSH_MB: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(2_048)), 100),
    /**
     * Internal base URL of collab, e.g. `http://collab:3001`. When unset (API
     * tests run without collab), the API writes document states directly.
     */
    COLLAB_INTERNAL_URL: z.optional(z.url({ protocol: /^https?$/ })),
    COLLAB_INTERNAL_TOKEN: z.optional(internalToken),
    /**
     * Key encrypting the secrets users store (Zotero and AI provider keys), as
     * base64 of 32 random bytes. Without it, storing such secrets is refused.
     */
    GALLEY_MASTER_KEY: z.optional(masterKey),
    /** LanguageTool server, e.g. `http://languagetool:8010`; spell checking is off without it. */
    LANGUAGETOOL_URL: z.optional(z.url({ protocol: /^https?$/ })),
    /** Bibliographic services, overridable for a mirror and for tests. */
    CROSSREF_URL: z._default(z.url({ protocol: /^https?$/ }), 'https://api.crossref.org'),
    /** Contact sent to Crossref, which then serves requests from its faster "polite" pool. */
    CROSSREF_MAILTO: z.optional(z.union([z.literal(''), z.email()])),
    ARXIV_URL: z._default(z.url({ protocol: /^https?$/ }), 'https://export.arxiv.org'),
    OPENLIBRARY_URL: z._default(z.url({ protocol: /^https?$/ }), 'https://openlibrary.org'),
    ZOTERO_URL: z._default(z.url({ protocol: /^https?$/ }), 'https://api.zotero.org'),
    OPENALEX_URL: z._default(z.url({ protocol: /^https?$/ }), 'https://api.openalex.org'),
    SEMANTIC_SCHOLAR_URL: z._default(
      z.url({ protocol: /^https?$/ }),
      'https://api.semanticscholar.org',
    ),
    /** Optional: Semantic Scholar throttles anonymous callers hard, so it is only queried with a key. */
    SEMANTIC_SCHOLAR_API_KEY: blankable(z.string()),
    /** Instance-wide switch of the AI assistant (SPEC §3.8). */
    AI_ENABLED: z._default(booleanFlag, true),
    /** Provider used by everyone without a configuration of their own; empty: none. */
    AI_DEFAULT_PROVIDER: blankable(aiProvider),
    AI_DEFAULT_MODEL: blankable(z.string().check(z.maxLength(200))),
    AI_DEFAULT_BASE_URL: blankable(z.url({ protocol: /^https?$/ })),
    AI_DEFAULT_API_KEY: blankable(z.string().check(z.maxLength(500))),
    /** Capabilities of the default model when the built-in table does not know it. */
    AI_DEFAULT_VISION: blankable(booleanFlag),
    AI_DEFAULT_CONTEXT_TOKENS: blankable(z.coerce.number().check(z.int(), z.gte(2_000))),
    /** Lets users point a provider at an address of their choice (see docs/operations.md). */
    AI_ALLOW_USER_ENDPOINTS: z._default(booleanFlag, false),
    AI_RATE_LIMIT_PER_MINUTE: z._default(
      z.coerce.number().check(z.int(), z.gte(1), z.lte(1_000)),
      20,
    ),
    /** Default quotas of every account (SPEC §3.9); empty means unlimited. */
    QUOTA_STORAGE_MB: blankable(z.coerce.number().check(z.int(), z.positive())),
    QUOTA_COMPILE_MINUTES: blankable(z.coerce.number().check(z.int(), z.positive())),
    /** Public host name and HTTPS port, from which the API derives its own address. */
    GALLEY_HOST: z._default(z.string().check(z.minLength(1)), 'localhost'),
    GALLEY_HTTPS_PORT: z._default(port, 443),
    /** OpenID Connect provider (SPEC §3.9); sign-in through it is off while the issuer is empty. */
    OIDC_ISSUER: blankable(z.url({ protocol: /^https?$/ })),
    OIDC_CLIENT_ID: blankable(z.string().check(z.maxLength(500))),
    OIDC_CLIENT_SECRET: blankable(z.string().check(z.maxLength(1_000))),
    /** Label of the sign-in button, e.g. "Keycloak de l'école". */
    OIDC_DISPLAY_NAME: z._default(z.string().check(z.minLength(1), z.maxLength(80)), 'SSO'),
    OIDC_SCOPES: z._default(z.string(), 'openid email profile'),
    /** Creates accounts on first sign-in even when registration is not open. */
    OIDC_ALLOW_SIGNUP: z._default(booleanFlag, false),
    /** Lets people link files to public web addresses (SPEC §3.1). */
    LINKED_URLS_ENABLED: z._default(booleanFlag, true),
    /** Hosts projects may be synchronised with, comma-separated (SPEC §3.5). */
    GIT_SYNC_HOSTS: z.pipe(
      z._default(z.string(), 'github.com,gitlab.com'),
      z.transform((value) =>
        value
          .split(',')
          .map((host) => host.trim().toLowerCase())
          .filter((host) => host !== ''),
      ),
    ),
    /** Allows plain HTTP remotes: tests and mirrors on a trusted network only. */
    GIT_SYNC_ALLOW_HTTP: z._default(booleanFlag, false),
    /**
     * Outgoing mail server, e.g. `smtps://user:password@mail.example.org`;
     * password reset by e-mail and notifications are off while it is empty.
     */
    SMTP_URL: blankable(z.url({ protocol: /^smtps?$/ })),
    /** Sender of every message, e.g. `Galley <galley@example.org>`. */
    SMTP_FROM: blankable(z.string().check(z.maxLength(320))),
  })
  .check(
    z.refine((env) => !env.OIDC_ISSUER || Boolean(env.OIDC_CLIENT_ID), {
      message: 'OIDC_CLIENT_ID is required when OIDC_ISSUER is set',
      path: ['OIDC_CLIENT_ID'],
    }),
    z.refine((env) => !env.SMTP_URL || Boolean(env.SMTP_FROM), {
      message: 'SMTP_FROM is required when SMTP_URL is set',
      path: ['SMTP_FROM'],
    }),
    z.refine(
      (env) => env.COLLAB_INTERNAL_URL === undefined || env.COLLAB_INTERNAL_TOKEN !== undefined,
      {
        message: 'COLLAB_INTERNAL_TOKEN is required when COLLAB_INTERNAL_URL is set',
        path: ['COLLAB_INTERNAL_TOKEN'],
      },
    ),
  );
export type ApiConfig = z.output<typeof apiEnv>;

export const collabEnv = z.object({
  ...commonEnv.shape,
  ...postgresEnv.shape,
  ...valkeyEnv.shape,
  COLLAB_PORT: z._default(port, 3001),
  COLLAB_INTERNAL_TOKEN: internalToken,
  /** Quiet period before a document is written to PostgreSQL. */
  COLLAB_PERSIST_DEBOUNCE_MS: z._default(z.coerce.number().check(z.int(), z.gte(0)), 2_000),
  /** Longest a document under continuous typing can go without being written. */
  COLLAB_PERSIST_MAX_DEBOUNCE_MS: z._default(z.coerce.number().check(z.int(), z.gte(0)), 10_000),
});
export type CollabConfig = z.output<typeof collabEnv>;

const positiveInt = z.coerce.number().check(z.int(), z.gte(1));

export const compilerEnv = z.object({
  ...commonEnv.shape,
  ...valkeyEnv.shape,
  ...s3Env.shape,
  COMPILER_HEALTH_PORT: z._default(port, 3002),
  COMPILER_CONCURRENCY: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(64)), 1),
  /** Persistent working directories, one per project, kept between compilations. */
  COMPILER_WORK_DIR: z._default(z.string(), '/var/lib/galley/work'),
  /** Disk budget of all working directories; the least recently used are evicted beyond it. */
  COMPILER_WORK_QUOTA_MB: z._default(positiveInt, 20_480),
  /** Read-only assets of the sandbox built into the image (passwd, latexmkrc, caches). */
  COMPILER_ASSETS_DIR: z._default(z.string(), '/opt/galley'),
  /** Wall-clock limit of one compilation (SPEC §6.3). */
  COMPILER_TIMEOUT_S: z._default(positiveInt, 180),
  /** Address space limit of each process of a compilation. */
  COMPILER_MEMORY_MB: z._default(positiveInt, 2_048),
  COMPILER_MAX_PROCESSES: z._default(positiveInt, 64),
  /** Size limit of the output folder of a compilation. */
  COMPILER_MAX_OUTPUT_MB: z._default(positiveInt, 500),
  /** Whether projects may compile with unrestricted shell-escape (still inside the sandbox). */
  COMPILER_ALLOW_FULL_SHELL_ESCAPE: z._default(booleanFlag, false),
});
export type CompilerConfig = z.output<typeof compilerEnv>;

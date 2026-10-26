import * as z from 'zod/mini';
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

export const apiEnv = z.object({
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
});
export type ApiConfig = z.output<typeof apiEnv>;

export const collabEnv = z.object({
  ...commonEnv.shape,
  ...valkeyEnv.shape,
  COLLAB_PORT: z._default(port, 3001),
});
export type CollabConfig = z.output<typeof collabEnv>;

export const compilerEnv = z.object({
  ...commonEnv.shape,
  ...valkeyEnv.shape,
  COMPILER_HEALTH_PORT: z._default(port, 3002),
  COMPILER_CONCURRENCY: z._default(z.coerce.number().check(z.int(), z.gte(1), z.lte(64)), 1),
});
export type CompilerConfig = z.output<typeof compilerEnv>;

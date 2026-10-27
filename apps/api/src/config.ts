import { apiEnv, loadConfig, type ApiConfig } from '@galley/shared';
import { DEVELOPMENT_MASTER_KEY } from './crypto/secrets.js';

export type { ApiConfig };

/** Reads and validates the API configuration from the process environment. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return loadConfig(apiEnv, env);
}

/** Values shipped in compose.yaml and .env.example: public, fit for a local instance only. */
const DEVELOPMENT_SECRETS = {
  POSTGRES_PASSWORD: 'galley-dev-password',
  S3_SECRET_ACCESS_KEY: 'galley-dev-secret',
  COLLAB_INTERNAL_TOKEN: 'galley-dev-internal-token-change-me',
  GALLEY_MASTER_KEY: DEVELOPMENT_MASTER_KEY,
} as const;

/** Hosts that only the machine itself reaches. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Names of the development secrets still in use, when the instance is served
 * on a public name; empty for a local instance, which may keep them.
 */
export function developmentSecretsInUse(config: ApiConfig): string[] {
  if (LOCAL_HOSTS.has(config.GALLEY_HOST)) return [];
  const used: string[] = [];
  let password = '';
  try {
    password = decodeURIComponent(new URL(config.DATABASE_URL).password);
  } catch {
    // A URL the schema accepted always parses; nothing to report otherwise.
  }
  if (password === DEVELOPMENT_SECRETS.POSTGRES_PASSWORD) used.push('POSTGRES_PASSWORD');
  if (config.S3_SECRET_ACCESS_KEY === DEVELOPMENT_SECRETS.S3_SECRET_ACCESS_KEY) {
    used.push('S3_SECRET_ACCESS_KEY');
  }
  if (config.COLLAB_INTERNAL_TOKEN === DEVELOPMENT_SECRETS.COLLAB_INTERNAL_TOKEN) {
    used.push('COLLAB_INTERNAL_TOKEN');
  }
  if (config.GALLEY_MASTER_KEY === DEVELOPMENT_SECRETS.GALLEY_MASTER_KEY) {
    used.push('GALLEY_MASTER_KEY');
  }
  return used;
}

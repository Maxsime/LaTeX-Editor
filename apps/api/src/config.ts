import { apiEnv, loadConfig, type ApiConfig } from '@galley/shared';

export type { ApiConfig };

/** Reads and validates the API configuration from the process environment. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return loadConfig(apiEnv, env);
}

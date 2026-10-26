import { collabEnv, loadConfig, type CollabConfig } from '@galley/shared';

export type { CollabConfig };

/** Reads and validates the collaboration server configuration. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): CollabConfig {
  return loadConfig(collabEnv, env);
}

export interface RedisConnection {
  host: string;
  port: number;
  options: { username?: string; password?: string; db?: number; tls?: object };
}

/**
 * Splits a `redis://` or `rediss://` URL into the host, port and options form
 * expected by the Hocuspocus Redis extension.
 */
export function parseRedisUrl(url: string): RedisConnection {
  const parsed = new URL(url);
  const options: RedisConnection['options'] = {};
  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  const db = parsed.pathname.replace(/^\//, '');
  if (db) options.db = Number(db);
  if (parsed.protocol === 'rediss:') options.tls = {};
  return { host: parsed.hostname, port: Number(parsed.port || 6379), options };
}

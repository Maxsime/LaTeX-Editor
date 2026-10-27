import { capabilitiesOf, type ModelConfig, OFFICIAL_BASE_URLS } from '@galley/ai';
import { aiProviderConfigs } from '@galley/db';
import {
  type AiCapabilities,
  type AiProvider,
  type AiProviderConfig,
  type AiStatus,
  ApiError,
} from '@galley/shared';
import { eq } from 'drizzle-orm';
import type { ApiConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { requireSecretBox, type SecretBox } from '../crypto/secrets.js';
import type { ProjectRow } from '../projects/access.js';

/** Context in which a user's AI key is encrypted: bound to its owner. */
export const aiKeyContext = (userId: string) => `ai:${userId}`;

/** Empty strings from compose mean "unset". */
function present<T>(value: T | '' | undefined): T | undefined {
  return value === '' ? undefined : value;
}

/** The instance default provider, from the environment; null when none is set. */
export function instanceProvider(
  config: ApiConfig,
): (ModelConfig & { provider: AiProvider }) | null {
  const provider = present(config.AI_DEFAULT_PROVIDER);
  const model = present(config.AI_DEFAULT_MODEL);
  if (provider === undefined || model === undefined) return null;
  return {
    provider,
    model,
    apiKey: present(config.AI_DEFAULT_API_KEY),
    baseUrl: present(config.AI_DEFAULT_BASE_URL) ?? null,
  };
}

/** A resolved model: who configured it, how to reach it, what it can do. */
export interface ResolvedModel {
  source: 'user' | 'instance';
  config: ModelConfig;
  capabilities: AiCapabilities;
}

/**
 * The model a user's requests go to: their own configuration, else the
 * instance default. The key is decrypted here and must not leave the request.
 */
export async function resolveModel(
  context: AppContext,
  secrets: SecretBox | null,
  userId: string,
): Promise<ResolvedModel | null> {
  const { config } = context;
  const [row] = await context.database.db
    .select()
    .from(aiProviderConfigs)
    .where(eq(aiProviderConfigs.userId, userId));
  if (row) {
    const apiKey =
      row.keyCiphertext === null
        ? undefined
        : requireSecretBox(secrets).open(row.keyCiphertext, aiKeyContext(userId));
    return {
      source: 'user',
      config: { provider: row.provider, model: row.model, apiKey, baseUrl: row.baseUrl },
      capabilities: capabilitiesOf(row.provider, row.model),
    };
  }
  const instance = instanceProvider(config);
  if (instance === null) return null;
  return {
    source: 'instance',
    config: instance,
    capabilities: capabilitiesOf(instance.provider, instance.model, {
      ...(typeof config.AI_DEFAULT_VISION === 'boolean'
        ? { vision: config.AI_DEFAULT_VISION }
        : {}),
      ...(typeof config.AI_DEFAULT_CONTEXT_TOKENS !== 'number'
        ? {}
        : { contextTokens: config.AI_DEFAULT_CONTEXT_TOKENS }),
    }),
  };
}

/** Why the assistant is off for a project, or null when it may run. */
export function disabledReason(
  config: ApiConfig,
  project: ProjectRow,
): 'instance-disabled' | 'project-disabled' | null {
  if (!config.AI_ENABLED) return 'instance-disabled';
  if (!project.aiEnabled) return 'project-disabled';
  return null;
}

/** The assistant's status for a project, as the interface needs it. */
export function statusOf(
  config: ApiConfig,
  project: ProjectRow,
  model: ResolvedModel | null,
): AiStatus {
  const reason = disabledReason(config, project) ?? (model === null ? 'not-configured' : null);
  return {
    available: reason === null,
    reason,
    provider: model?.config.provider ?? null,
    model: model?.config.model ?? null,
    capabilities: model?.capabilities ?? null,
  };
}

/** Refuses a request when the assistant is off or not configured. */
export function requireAvailable(
  config: ApiConfig,
  project: ProjectRow,
  model: ResolvedModel | null,
): ResolvedModel {
  if (disabledReason(config, project) !== null) throw new ApiError('AI_DISABLED');
  if (model === null) throw new ApiError('AI_NOT_CONFIGURED');
  return model;
}

/**
 * Checks the address a user asks for. Without `AI_ALLOW_USER_ENDPOINTS`, only
 * the providers' official addresses: a free address would let anyone make the
 * API call internal services (SSRF).
 */
export function checkUserEndpoint(
  config: ApiConfig,
  provider: AiProvider,
  baseUrl: string | null | undefined,
): string | null {
  if (baseUrl === null || baseUrl === undefined) {
    if (provider === 'openai-compatible') throw new ApiError('AI_ENDPOINT_FORBIDDEN');
    return null;
  }
  if (config.AI_ALLOW_USER_ENDPOINTS) return baseUrl;
  if (provider !== 'openai-compatible' && baseUrl === OFFICIAL_BASE_URLS[provider]) return null;
  throw new ApiError('AI_ENDPOINT_FORBIDDEN');
}

/** A stored configuration as the API shows it. */
export function toProviderConfig(row: typeof aiProviderConfigs.$inferSelect): AiProviderConfig {
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    keyHint: row.keyHint,
  };
}

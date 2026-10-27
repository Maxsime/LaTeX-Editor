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
import {
  type EffectiveSettings,
  INSTANCE_AI_KEY_CONTEXT,
  instanceSettingsOf,
} from '../admin/settings.js';
import { keyHint, requireSecretBox, type SecretBox } from '../crypto/secrets.js';
import type { ProjectRow } from '../projects/access.js';

/** Context in which a user's AI key is encrypted: bound to its owner. */
export const aiKeyContext = (userId: string) => `ai:${userId}`;

/** Empty strings from compose mean "unset". */
function present<T>(value: T | '' | undefined): T | undefined {
  return value === '' ? undefined : value;
}

/** The instance default model with what is known of its capabilities. */
export interface InstanceModel {
  config: ModelConfig & { provider: AiProvider };
  /** Capabilities stated by the administrator, over the built-in table. */
  overrides: { vision?: boolean; contextTokens?: number };
  /** Last characters of the key, for the console. */
  keyHint: string | null;
  /** Where it is configured. */
  origin: 'console' | 'environment';
}

/**
 * The instance default model: the console's when one is set there, else the
 * environment's; null when neither names one. Decrypts the console's key, which
 * must not leave the request.
 */
export function instanceModel(
  config: ApiConfig,
  settings: EffectiveSettings,
  secrets: SecretBox | null,
): InstanceModel | null {
  const stored = settings.aiDefault;
  if (stored !== null) {
    return {
      config: {
        provider: stored.provider,
        model: stored.model,
        apiKey:
          stored.keyCiphertext === null
            ? undefined
            : requireSecretBox(secrets).open(
                Buffer.from(stored.keyCiphertext, 'base64'),
                INSTANCE_AI_KEY_CONTEXT,
              ),
        baseUrl: stored.baseUrl,
      },
      overrides: {
        ...(stored.vision === null ? {} : { vision: stored.vision }),
        ...(stored.contextTokens === null ? {} : { contextTokens: stored.contextTokens }),
      },
      keyHint: stored.keyHint,
      origin: 'console',
    };
  }
  const provider = present(config.AI_DEFAULT_PROVIDER);
  const model = present(config.AI_DEFAULT_MODEL);
  if (provider === undefined || model === undefined) return null;
  const apiKey = present(config.AI_DEFAULT_API_KEY);
  return {
    config: { provider, model, apiKey, baseUrl: present(config.AI_DEFAULT_BASE_URL) ?? null },
    overrides: {
      ...(typeof config.AI_DEFAULT_VISION === 'boolean'
        ? { vision: config.AI_DEFAULT_VISION }
        : {}),
      ...(typeof config.AI_DEFAULT_CONTEXT_TOKENS === 'number'
        ? { contextTokens: config.AI_DEFAULT_CONTEXT_TOKENS }
        : {}),
    },
    keyHint: apiKey === undefined ? null : keyHint(apiKey),
    origin: 'environment',
  };
}

/** Provider and model of the instance default, without touching its key. */
export function instanceDefault(
  config: ApiConfig,
  settings: EffectiveSettings,
): { provider: AiProvider; model: string } | null {
  if (settings.aiDefault !== null) {
    return { provider: settings.aiDefault.provider, model: settings.aiDefault.model };
  }
  const provider = present(config.AI_DEFAULT_PROVIDER);
  const model = present(config.AI_DEFAULT_MODEL);
  return provider === undefined || model === undefined ? null : { provider, model };
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
  const instance = instanceModel(context.config, await instanceSettingsOf(context).get(), secrets);
  if (instance === null) return null;
  return {
    source: 'instance',
    config: instance.config,
    capabilities: capabilitiesOf(
      instance.config.provider,
      instance.config.model,
      instance.overrides,
    ),
  };
}

/** Why the assistant is off for a project, or null when it may run. */
export function disabledReason(
  settings: EffectiveSettings,
  project: ProjectRow,
): 'instance-disabled' | 'project-disabled' | null {
  if (!settings.aiEnabled) return 'instance-disabled';
  if (!project.aiEnabled) return 'project-disabled';
  return null;
}

/** The assistant's status for a project, as the interface needs it. */
export function statusOf(
  settings: EffectiveSettings,
  project: ProjectRow,
  model: ResolvedModel | null,
): AiStatus {
  const reason = disabledReason(settings, project) ?? (model === null ? 'not-configured' : null);
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
  settings: EffectiveSettings,
  project: ProjectRow,
  model: ResolvedModel | null,
): ResolvedModel {
  if (disabledReason(settings, project) !== null) throw new ApiError('AI_DISABLED');
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

import { instanceSettings } from '@galley/db';
import {
  aiProvider,
  type InstanceQuotas,
  instanceQuotas,
  type RegistrationMode,
  registrationMode,
} from '@galley/shared';
import { eq, sql } from 'drizzle-orm';
import * as z from 'zod/mini';
import type { ApiConfig } from '../config.js';
import type { AppContext } from '../context.js';

/** The instance's default model as stored by the console; the key is sealed by the master key. */
const storedAiDefault = z.object({
  provider: aiProvider,
  model: z.string(),
  baseUrl: z.nullable(z.string()),
  /** Base64 of the sealed key; null for a provider without one (a local Ollama). */
  keyCiphertext: z.nullable(z.string()),
  keyHint: z.nullable(z.string()),
  vision: z.nullable(z.boolean()),
  contextTokens: z.nullable(z.number()),
});
export type StoredAiDefault = z.infer<typeof storedAiDefault>;

/** Context the instance key is sealed in, distinct from every user's. */
export const INSTANCE_AI_KEY_CONTEXT = 'ai:instance';

/** Every setting the console may store, with the schema its value must satisfy. */
const schemas = {
  registrationMode,
  quotas: instanceQuotas,
  aiEnabled: z.boolean(),
  aiDefault: storedAiDefault,
} as const;
export type SettingKey = keyof typeof schemas;
type SettingValue<K extends SettingKey> = z.infer<(typeof schemas)[K]>;

/** Settings in effect: the console's values over the environment's. */
export interface EffectiveSettings {
  registrationMode: RegistrationMode;
  quotas: InstanceQuotas;
  aiEnabled: boolean;
  /** The console's default model; null falls back on the environment's. */
  aiDefault: StoredAiDefault | null;
  /** Keys set in the console. */
  overridden: SettingKey[];
}

/** Empty strings from compose mean "unset". */
function present<T>(value: T | '' | undefined): T | undefined {
  return value === '' ? undefined : value;
}

/** The values of the environment, before any change made in the console. */
export function environmentSettings(config: ApiConfig): EffectiveSettings {
  return {
    registrationMode: config.REGISTRATION_MODE,
    quotas: {
      storageMb: present(config.QUOTA_STORAGE_MB) ?? null,
      compileMinutes: present(config.QUOTA_COMPILE_MINUTES) ?? null,
    },
    aiEnabled: config.AI_ENABLED,
    aiDefault: null,
    overridden: [],
  };
}

/**
 * Merges stored rows over the environment. A row that no longer satisfies its
 * schema (written by another version) is ignored rather than trusted.
 */
export function mergeSettings(
  base: EffectiveSettings,
  rows: readonly { key: string; value: unknown }[],
): EffectiveSettings {
  const result: EffectiveSettings = { ...base, overridden: [] };
  for (const row of rows) {
    if (!(row.key in schemas)) continue;
    // `in` narrowed the key to one of the schemas' names.
    const key = row.key as SettingKey;
    const parsed = schemas[key].safeParse(row.value);
    if (!parsed.success) continue;
    Object.assign(result, { [key]: parsed.data });
    result.overridden.push(key);
  }
  return result;
}

/** Long enough to spare the database on every request, short enough for replicas to agree. */
const CACHE_MS = 2_000;

/** Reads and writes the instance settings (SPEC §3.9). */
export class InstanceSettings {
  private cached: { at: number; value: EffectiveSettings } | null = null;

  constructor(private readonly context: AppContext) {}

  /** The settings in effect, cached for a moment. */
  async get(): Promise<EffectiveSettings> {
    const now = Date.now();
    if (this.cached !== null && now - this.cached.at < CACHE_MS) return this.cached.value;
    const rows = await this.context.database.db
      .select({ key: instanceSettings.key, value: instanceSettings.value })
      .from(instanceSettings);
    const value = mergeSettings(environmentSettings(this.context.config), rows);
    this.cached = { at: now, value };
    return value;
  }

  /** Stores a setting, overriding its environment variable. */
  async set<K extends SettingKey>(key: K, value: SettingValue<K>, by: string): Promise<void> {
    await this.context.database.db
      .insert(instanceSettings)
      .values({ key, value, updatedBy: by })
      .onConflictDoUpdate({
        target: instanceSettings.key,
        set: { value, updatedBy: by, updatedAt: sql`now()` },
      });
    this.cached = null;
  }

  /** Forgets a setting: its environment variable applies again. */
  async reset(key: SettingKey): Promise<void> {
    await this.context.database.db.delete(instanceSettings).where(eq(instanceSettings.key, key));
    this.cached = null;
  }
}

const byContext = new WeakMap<AppContext, InstanceSettings>();

/** The settings service of an application context, created on first use. */
export function instanceSettingsOf(context: AppContext): InstanceSettings {
  let settings = byContext.get(context);
  if (settings === undefined) {
    settings = new InstanceSettings(context);
    byContext.set(context, settings);
  }
  return settings;
}

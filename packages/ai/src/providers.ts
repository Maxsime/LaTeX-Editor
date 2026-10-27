import { createAnthropic } from '@ai-sdk/anthropic';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { AiProvider } from '@galley/shared';
import type { LanguageModel } from 'ai';

/** Everything needed to reach a model. Holds a secret: never log it. */
export interface ModelConfig {
  provider: AiProvider;
  model: string;
  /** Absent for a local endpoint that needs none. */
  apiKey?: string | undefined;
  /** Null or absent: the provider's official address. */
  baseUrl?: string | null | undefined;
}

/** Official addresses, the only ones users may reach unless the instance allows more. */
export const OFFICIAL_BASE_URLS: Record<Exclude<AiProvider, 'openai-compatible'>, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  mistral: 'https://api.mistral.ai/v1',
};

/**
 * The SDK model for a configuration. The key is always passed explicitly, so
 * that a provider never falls back to an environment variable of the server.
 */
export function createModel(config: ModelConfig, fetcher?: typeof fetch): LanguageModel {
  const apiKey = config.apiKey ?? '';
  const common = fetcher === undefined ? {} : { fetch: fetcher };
  switch (config.provider) {
    case 'anthropic':
      return createAnthropic({
        apiKey,
        baseURL: config.baseUrl ?? OFFICIAL_BASE_URLS.anthropic,
        ...common,
      })(config.model);
    case 'openai':
      return createOpenAI({
        apiKey,
        baseURL: config.baseUrl ?? OFFICIAL_BASE_URLS.openai,
        ...common,
      }).chat(config.model);
    case 'mistral':
      return createMistral({
        apiKey,
        baseURL: config.baseUrl ?? OFFICIAL_BASE_URLS.mistral,
        ...common,
      })(config.model);
    case 'openai-compatible':
      if (config.baseUrl === null || config.baseUrl === undefined) {
        throw new Error('an OpenAI-compatible provider needs a base URL');
      }
      return createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: config.baseUrl,
        ...(apiKey === '' ? {} : { apiKey }),
        includeUsage: true,
        ...common,
      })(config.model);
  }
}

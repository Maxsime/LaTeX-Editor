import type { AiCapabilities, AiProvider } from '@galley/shared';

interface CapabilityRule {
  provider: AiProvider | null;
  pattern: RegExp;
  capabilities: AiCapabilities;
}

/** Defaults for a model this table does not know: tools yes, images no, a modest window. */
export const UNKNOWN_MODEL_CAPABILITIES: AiCapabilities = {
  vision: false,
  tools: true,
  contextTokens: 32_000,
  promptCache: false,
};

// First match wins. Model names are matched loosely: providers add dates and
// suffixes, and the same family keeps its capabilities across them.
const RULES: CapabilityRule[] = [
  {
    provider: 'anthropic',
    pattern: /^claude-/,
    capabilities: { vision: true, tools: true, contextTokens: 200_000, promptCache: true },
  },
  {
    provider: 'openai',
    pattern: /^(gpt-4o|gpt-4\.1|gpt-5|o[134])/,
    capabilities: { vision: true, tools: true, contextTokens: 128_000, promptCache: true },
  },
  {
    provider: 'mistral',
    pattern: /^(pixtral|mistral-(large|medium|small)-(2[5-9]|latest))/,
    capabilities: { vision: true, tools: true, contextTokens: 128_000, promptCache: false },
  },
  {
    provider: 'mistral',
    pattern: /./,
    capabilities: { vision: false, tools: true, contextTokens: 32_000, promptCache: false },
  },
  // Local models served through an OpenAI-compatible endpoint (Ollama, vLLM, LM Studio).
  {
    provider: null,
    pattern: /(llava|vision|-vl\b|qwen2\.5vl|qwen3-vl|gemma3|llama3\.2-vision|minicpm-v)/i,
    capabilities: { vision: true, tools: true, contextTokens: 32_000, promptCache: false },
  },
];

/**
 * Capabilities of a model (SPEC §6.8), from a table of known families, then
 * the instance's overrides, then prudent defaults.
 */
export function capabilitiesOf(
  provider: AiProvider,
  model: string,
  overrides: Partial<AiCapabilities> = {},
): AiCapabilities {
  const rule = RULES.find(
    (candidate) =>
      (candidate.provider === null || candidate.provider === provider) &&
      candidate.pattern.test(model),
  );
  return { ...(rule?.capabilities ?? UNKNOWN_MODEL_CAPABILITIES), ...overrides };
}

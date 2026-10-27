import type { AiModelPrice } from '@galley/shared';

/** Tokens of one request, as the provider reported them. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Part of `inputTokens` read from the provider's prompt cache. */
  cachedInputTokens: number;
}

/**
 * Estimated cost in millionths of the price's currency. Prices are per
 * million tokens, so a token at price p costs p micro-units.
 */
export function estimateCost(
  usage: TokenUsage,
  price: Pick<AiModelPrice, 'inputPerMTok' | 'outputPerMTok' | 'cachedInputPerMTok'>,
): number {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  return Math.round(
    (usage.inputTokens - cached) * price.inputPerMTok +
      cached * (price.cachedInputPerMTok ?? price.inputPerMTok) +
      usage.outputTokens * price.outputPerMTok,
  );
}

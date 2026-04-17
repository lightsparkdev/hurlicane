/**
 * Estimate USD cost from model + token counts.
 *
 * Pricing is per million tokens. We use regular (non-cached) input pricing
 * which slightly overestimates when cache reads are involved — safe direction
 * for budget enforcement.
 */

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

// Pricing as of May 2025 — update when Anthropic changes rates.
const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7':         { inputPerMillion: 15,  outputPerMillion: 75 },
  'claude-opus-4-7[1m]':     { inputPerMillion: 15,  outputPerMillion: 75 },
  'claude-opus-4-6':         { inputPerMillion: 15,  outputPerMillion: 75 },
  'claude-opus-4-6[1m]':     { inputPerMillion: 15,  outputPerMillion: 75 },
  'claude-sonnet-4-6':       { inputPerMillion: 3,   outputPerMillion: 15 },
  'claude-sonnet-4-6[1m]':   { inputPerMillion: 3,   outputPerMillion: 15 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.80, outputPerMillion: 4 },
};

// Default fallback — Sonnet pricing
const DEFAULT_PRICING: ModelPricing = { inputPerMillion: 3, outputPerMillion: 15 };

function getPricing(model: string | null): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  return PRICING[model] ?? DEFAULT_PRICING;
}

/**
 * Estimate cost in USD given a model and accumulated token counts.
 */
export function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = getPricing(model);
  return (inputTokens / 1_000_000) * p.inputPerMillion
       + (outputTokens / 1_000_000) * p.outputPerMillion;
}

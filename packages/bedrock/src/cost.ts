import type { Config, TokenUsage } from '@pelp/domain';

/** Costo en USD de una llamada según los precios unitarios de la config (sección 16). */
export function costUsd(pricing: Config['pricing'], model: string, usage: TokenUsage): number {
  const price = pricing[model] ?? pricing[model.replace(/^(us|eu|global)\./, '')];
  if (!price) return 0;
  const input = (usage.inputTokens / 1_000_000) * price.inputPerMTok;
  const output = (usage.outputTokens / 1_000_000) * price.outputPerMTok;
  const cacheRead = (usage.cacheReadTokens / 1_000_000) * price.inputPerMTok * price.cacheReadFactor;
  const cacheWrite = (usage.cacheWriteTokens / 1_000_000) * price.inputPerMTok * price.cacheWriteFactor;
  return round6(input + output + cacheRead + cacheWrite);
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

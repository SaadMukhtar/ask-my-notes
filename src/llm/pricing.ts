import type Anthropic from "@anthropic-ai/sdk";

/**
 * USD per million tokens, Anthropic first-party API list prices (checked 2026-10).
 * Cache writes (5-minute TTL) cost 1.25x the input price; cache reads cost ~0.1x.
 * Keep this table in one place: cost-per-question numbers in the README come from it.
 */
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.2 },
  "offline-extractive": { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
};

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export function fromApiUsage(u: Anthropic.Usage): TokenUsage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead };
}

export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.cacheWrite + u.cacheRead;
}

export function costUsd(model: string, u: TokenUsage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for model ${model}; add it to src/llm/pricing.ts`);
  return (u.input * p.input + u.output * p.output + u.cacheWrite * p.cacheWrite + u.cacheRead * p.cacheRead) / 1e6;
}

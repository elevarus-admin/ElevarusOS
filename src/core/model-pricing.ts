const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "claude-opus-4-7":   { inputPer1M: 5.00,  outputPer1M: 25.00 },
  "claude-opus-4-6":   { inputPer1M: 5.00,  outputPer1M: 25.00 },
  "claude-sonnet-4-6": { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-haiku-4-5":  { inputPer1M: 1.00,  outputPer1M: 5.00  },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING["claude-opus-4-7"]!;
  return (inputTokens / 1_000_000) * p.inputPer1M + (outputTokens / 1_000_000) * p.outputPer1M;
}

export function makeUsage(model: string, inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: calcCost(model, inputTokens, outputTokens),
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens:      a.inputTokens  + b.inputTokens,
    outputTokens:     a.outputTokens + b.outputTokens,
    totalTokens:      a.totalTokens  + b.totalTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
  };
}

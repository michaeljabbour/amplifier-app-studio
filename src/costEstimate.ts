export type CostBasis = "unavailable" | "reported" | "estimated" | "mixed" | "partial";

export interface RunPodEstimate {
  model: string;
  ratePerMillion: number;
  costUsd: number;
}

interface RunPodRate {
  label: string;
  matches: RegExp;
  ratePerMillion: number;
}

// Blended planning rates for RunPod-hosted models: a fixed annual compute pool amortised across
// the active models at ~5M blended input+output tokens per endpoint-hour. They are coarse local
// estimates, never provider list prices, and the UI must always label them as such. Do not
// restate the operator's own compute budget in user-facing copy -- these numbers ship to
// everyone who installs Studio, not just the fleet owner.
export const RUNPOD_BLENDED_RATES: readonly RunPodRate[] = [
  { label: "moonshotai/Kimi-K3", matches: /(?:moonshotai\/)?kimi-k3/i, ratePerMillion: 10.53 },
  { label: "deepseek-ai/DeepSeek-V4-Flash-0731", matches: /deepseek-v4-flash(?:-0731)?/i, ratePerMillion: 3.09 },
  { label: "zai-org/GLM-5.2-FP8", matches: /glm-5\.2(?:-fp8)?/i, ratePerMillion: 0.076 },
] as const;

export function estimateRunPodCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): RunPodEstimate | undefined {
  const rate = RUNPOD_BLENDED_RATES.find((candidate) => candidate.matches.test(model));
  const tokens = nonNegativeInteger(inputTokens) + nonNegativeInteger(outputTokens);
  if (!rate || tokens <= 0) return undefined;
  return {
    model: rate.label,
    ratePerMillion: rate.ratePerMillion,
    costUsd: tokens * rate.ratePerMillion / 1_000_000,
  };
}

export function mergeCostBasis(current: CostBasis, incoming: "reported" | "estimated"): CostBasis {
  if (current === "unavailable") return incoming;
  if (current === "partial") return "partial";
  if (current === incoming) return current;
  return "mixed";
}

export function formatSessionCost(costUsd: string, basis: CostBasis, compact = false): string {
  const numeric = Number(costUsd);
  if (!Number.isFinite(numeric) || (numeric === 0 && basis === "unavailable")) {
    return compact ? "cost —" : "Cost unavailable";
  }
  const amount = `$${numeric.toFixed(numeric < 0.1 ? 4 : 2)}`;
  if (basis === "estimated") return `est. ${amount}`;
  if (basis === "mixed") return `mixed ${amount}`;
  if (basis === "partial") return `≥${amount}`;
  return amount;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

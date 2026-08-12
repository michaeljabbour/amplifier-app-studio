import { describe, expect, it } from "vitest";
import { estimateRunPodCost, formatSessionCost, mergeCostBasis } from "./costEstimate";

describe("RunPod infrastructure cost estimates", () => {
  it("uses the fleet owner's blended planning rates", () => {
    expect(estimateRunPodCost("moonshotai/Kimi-K3", 4_000_000, 1_000_000)).toMatchObject({
      ratePerMillion: 10.53,
      costUsd: 52.65,
    });
    expect(estimateRunPodCost("runpod/deepseek-ai/DeepSeek-V4-Flash-0731", 1_000_000, 0)?.costUsd).toBe(3.09);
    expect(estimateRunPodCost("zai-org/GLM-5.2-FP8", 5_000_000, 0)?.costUsd).toBeCloseTo(0.38);
  });

  it("does not invent a price for an unconfigured model", () => {
    expect(estimateRunPodCost("Qwen/Qwen3-Coder-30B-A3B-Instruct", 1_000, 100)).toBeUndefined();
  });

  it("keeps reported, estimated, and unavailable costs visibly distinct", () => {
    expect(formatSessionCost("0", "unavailable", true)).toBe("cost —");
    expect(formatSessionCost("10.53", "estimated", true)).toBe("est. $10.53");
    expect(formatSessionCost("1.25", "reported", true)).toBe("$1.25");
    expect(mergeCostBasis("reported", "estimated")).toBe("mixed");
  });
});

import { describe, expect, it } from "vitest";
import { toolContractFailure } from "./providerSafety";

describe("provider safety", () => {
  it("blocks corrupt direct experiments and admits checked matrix routes", () => {
    expect(toolContractFailure("moonshotai/Kimi-K3", "runpod-kimi")).toContain("does not pass");
    expect(toolContractFailure("zai-org/GLM-5.2-FP8", "runpod-next")).toContain("does not pass");
    expect(toolContractFailure("deepseek-ai/DeepSeek-V4-Flash-0731", "runpod")).toBeUndefined();
    expect(toolContractFailure("Qwen/Qwen3-Coder-30B-A3B-Instruct", "runpod-qwen")).toBeUndefined();
  });
});

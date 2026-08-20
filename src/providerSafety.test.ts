import { describe, expect, it } from "vitest";
import { toolContractFailure } from "./providerSafety";

describe("provider safety", () => {
  it("blocks corrupt direct experiments and admits checked matrix routes", () => {
    expect(toolContractFailure("moonshotai/Kimi-K3", "runpod-kimi")).toContain("does not pass");
    expect(toolContractFailure("zai-org/GLM-5.2-FP8", "runpod-next")).toContain("does not pass");
    expect(toolContractFailure("deepseek-ai/DeepSeek-V4-Flash-0731", "runpod")).toBeUndefined();
    expect(toolContractFailure("Qwen/Qwen3-Coder-30B-A3B-Instruct", "runpod-qwen")).toBeUndefined();
  });

  it("still blocks the unsafe models when they arrive over any RunPod route", () => {
    expect(toolContractFailure("zai-org/GLM-5.2-FP8", "runpod")).toContain("does not pass");
    expect(toolContractFailure("moonshotai/Kimi-K3", "runpod-matrix")).toContain("does not pass");
  });

  // Regression: these model patterns used to be tested against every provider, so a user running
  // the same weights on their own vLLM host or on the vendor's official API had every send in
  // that session rejected -- by an error naming RunPod routes absent from their catalog, with no
  // override anywhere in the UI.
  it("never blocks a model that is not served through RunPod", () => {
    expect(toolContractFailure("zai-org/GLM-5.2-FP8", "zai")).toBeUndefined();
    expect(toolContractFailure("glm-5.2-fp8", "vllm-local")).toBeUndefined();
    expect(toolContractFailure("moonshotai/Kimi-K3", "moonshot")).toBeUndefined();
    expect(toolContractFailure("zai-org/GLM-5.2-FP8", "")).toBeUndefined();
    expect(toolContractFailure("moonshotai/Kimi-K3")).toBeUndefined();
  });
});

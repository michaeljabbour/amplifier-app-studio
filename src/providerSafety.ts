export function toolContractFailure(model: string, provider = ""): string | undefined {
  const route = provider.trim().toLowerCase();
  const selectedModel = model.trim().toLowerCase();
  if (
    ["runpod-kimi", "runpod-glm", "runpod-next"].includes(route)
    || selectedModel.includes("kimi-k3")
    || selectedModel.includes("glm-5.2")
  ) {
    return "This RunPod route does not pass Amplifier's exact streaming tool-call contract. Start a new session with the checked runpod matrix or runpod-qwen route.";
  }
  return undefined;
}

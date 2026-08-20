/** RunPod gateway routes whose streaming tool-call framing is known to be broken. */
const UNSAFE_RUNPOD_ROUTES = ["runpod-kimi", "runpod-glm", "runpod-next"];

/** Models that break the contract *as served by these RunPod routes*. */
const UNSAFE_RUNPOD_MODELS = [/kimi-k3/, /glm-5\.2/];

/**
 * Whether a session must refuse to send because its route cannot carry Amplifier's tool calls.
 *
 * Scoped to RunPod routes on purpose. The model patterns used to be tested against every
 * provider, so anyone running e.g. `glm-5.2-fp8` on their own vLLM box or on Z.ai's official
 * API had every send rejected, in a session they could not repair, by an error naming RunPod
 * routes that do not exist in their catalog. The defect is in these specific gateway routes,
 * not in the weights.
 */
export function toolContractFailure(model: string, provider = ""): string | undefined {
  const route = provider.trim().toLowerCase();
  const selectedModel = model.trim().toLowerCase();
  if (!route.startsWith("runpod")) return undefined;
  if (UNSAFE_RUNPOD_ROUTES.includes(route) || UNSAFE_RUNPOD_MODELS.some((pattern) => pattern.test(selectedModel))) {
    return "This RunPod route does not pass Amplifier's exact streaming tool-call contract. Start a new session with the checked runpod matrix or runpod-qwen route.";
  }
  return undefined;
}

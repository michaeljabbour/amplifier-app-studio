import type { CapabilityCatalog, NewSessionInput, SessionViewState } from "./protocol";

export type StudioCapabilityId =
  | "coordinator"
  | "browser"
  | "app-use"
  | "terminal"
  | "imagen"
  | "attractor"
  | "tmux-fleet"
  | "digital-twin";

export interface StudioCapability {
  id: StudioCapabilityId;
  name: string;
  eyebrow: string;
  outcome: string;
  description: string;
  action: string;
  initialPrompt?: string;
  bundle?: string;
  catalogNames: string[];
  mode: string;
  requirements: string[];
  accent: "blue" | "green" | "amber" | "violet";
  activation: "parallel-session" | "included";
}

export type CapabilityReadiness = "native" | "composition" | "catalogued" | "on-demand" | "host-check";

export const STUDIO_CAPABILITIES: StudioCapability[] = [
  {
    id: "coordinator",
    name: "Coordinator",
    eyebrow: "CORE SESSION",
    outcome: "Organize work, build plans, and direct parallel specialists.",
    description: "The main Amplifier conversation stays open while agent workspaces and outputs develop around it.",
    action: "Start coordinating",
    catalogNames: [],
    mode: "auto",
    requirements: ["Uses the composition selected for this session."],
    accent: "blue",
    activation: "parallel-session",
  },
  {
    id: "browser",
    name: "Browser Use",
    eyebrow: "WEB OPERATOR",
    outcome: "Navigate, inspect, test, and verify real web experiences.",
    description: "Adds focused browser operators to a new Amplifier runtime with visible progress and isolated work.",
    action: "Start browser run",
    bundle: "git+https://github.com/microsoft/amplifier-bundle-browser-tester@3446c383b8a9d366b8d88f832d0f3ffb73c62dec",
    catalogNames: ["browser-tester"],
    mode: "auto",
    requirements: [
      "The bundle is prepared on the runtime host at first launch.",
      "Browser automation remains inside this independent session.",
    ],
    accent: "blue",
    activation: "parallel-session",
  },
  {
    id: "app-use",
    name: "App Use",
    eyebrow: "DESKTOP OPERATOR",
    outcome: "See and operate native Windows, macOS, or Linux applications.",
    description: "Composes Amplifier's native computer-use operator into a dedicated run. Once that tab is active, Autopilot controls the same session and never creates a replacement coordinator.",
    action: "Start desktop run",
    bundle: "git+https://github.com/microsoft/amplifier-bundle-computer-use@51f7a1d3ef8e4debdd2d0b2309b3cdfa8be6c6bc",
    catalogNames: ["computer-use"],
    mode: "auto",
    requirements: [
      "Requires a computer-use-capable model.",
      "The runtime host must grant screen recording and input-control permission; Studio does not assume those permissions are present.",
    ],
    accent: "violet",
    activation: "parallel-session",
  },
  {
    id: "terminal",
    name: "Terminal Use",
    eyebrow: "BUILT IN",
    outcome: "Run fast coding and infrastructure commands in the project boundary.",
    description: "Commands appear as visible tool activity inside the active coordinator. A long-lived interactive PTY would be a separate console drawer, not another Amplifier session.",
    action: "Included in active chat",
    catalogNames: [],
    mode: "auto",
    requirements: ["Available when the selected session composition mounts a shell or command tool."],
    accent: "green",
    activation: "included",
  },
  {
    id: "tmux-fleet",
    name: "Tmux Fleet",
    eyebrow: "SMART TOOL",
    outcome: "Find terminals that need attention and inspect their progress.",
    description: "Use the tmux-fleet CLI through Amplifier on the compute host you choose. Review the first request before starting.",
    action: "Inspect terminal fleet",
    catalogNames: [], mode: "auto", accent: "green", activation: "parallel-session",
    requirements: ["Requires tmux and tmux-fleet on the selected host.", "AI triage requires the tool's own provider configuration; Studio credentials are not copied."],
    initialPrompt: "Use Microsoft's tmux-fleet smart tool on this session's compute host. First check command availability, then run tmux-fleet doctor and tmux-fleet attention, and summarize their JSON results. Use tmux-fleet --help for its current contract. These are read-only checks: do not type into, create, rename, or kill any terminal. If missing, explain how to install from https://github.com/microsoft/amplifier-smart-tool-tmux; do not install automatically. For subsequent requests use its read, triage, or interpret commands as appropriate; model-backed commands need their own provider configuration. Never expose credentials. Send/create require explicit confirmation for the specific invocation before using --confirmed.",
  },
  {
    id: "digital-twin",
    name: "Digital Twin Universe",
    eyebrow: "SMART TOOL",
    outcome: "Check readiness for isolated test environments on your compute host.",
    description: "Use the Digital Twin Universe CLI through Amplifier to inspect prerequisites, then plan an environment for your project.",
    action: "Check environment readiness",
    catalogNames: [], mode: "auto", accent: "violet", activation: "parallel-session",
    requirements: ["Requires amplifier-digital-twin-universe; launching environments also requires Incus.", "Model-backed operations need the tool's own provider configuration."],
    initialPrompt: "Use Microsoft's amplifier-digital-twin-universe smart tool on this session's compute host. First check command availability, then run amplifier-digital-twin-universe manifest and amplifier-digital-twin-universe check. Summarize the JSON readiness results and missing prerequisites. Use --help for the current contract. Do not install software, launch, change, or destroy environments in this first check. If missing, explain installation from https://github.com/microsoft/amplifier-smart-tool-digital-twin-universe. Ask what environment the user wants before planning lifecycle actions. Later calls must follow the tool's confirmation contract; never automatically pass --confirmed or expose credentials. A passed prerequisite check is not a tested environment.",
  },
  {
    id: "imagen",
    name: "Image Studio",
    eyebrow: "IMAGEN 2",
    outcome: "Generate, edit, critique, and deliver production image assets.",
    description: "Pins the published Imagen composition and keeps concrete artifacts visible in Studio's Outputs surface.",
    action: "Open image studio",
    bundle: "git+https://github.com/michaeljabbour/amplifier-bundle-imagen@v2.0.0",
    catalogNames: ["imagen"],
    mode: "auto",
    requirements: [
      "Requires the separate imagen-mcp service on the runtime host.",
      "Requires separately configured OpenAI or Gemini image credentials; Studio does not reuse or overwrite a credential implicitly.",
    ],
    accent: "violet",
    activation: "parallel-session",
  },
  {
    id: "attractor",
    name: "Attractor",
    eyebrow: "WORKFLOW ENGINE",
    outcome: "Design and run inspectable graph-based agent workflows.",
    description: "Runs DOT pipelines with durable node, edge, retry, checkpoint, and completion events rendered in Studio's execution map.",
    action: "Start workflow run",
    bundle: "git+https://github.com/microsoft/amplifier-bundle-attractor@8d63cbe0a0135af94ad976fcfe99e9b8bdb47b0b#subdirectory=bundles/attractor-interactive.yaml",
    catalogNames: ["attractor", "attractor-interactive"],
    mode: "auto",
    requirements: [
      "Requires an Amplifier runtime that emits the typed pipeline event contract.",
      "Graph state is rendered only from recorded DOT and pipeline events, never inferred from chat text.",
    ],
    accent: "amber",
    activation: "parallel-session",
  },
];

export function capabilityReadiness(
  capability: StudioCapability,
  catalog: CapabilityCatalog,
): CapabilityReadiness {
  if (capability.initialPrompt) return "host-check";
  if (capability.id === "coordinator") return "native";
  if (capability.id === "terminal") return "composition";
  if (capability.catalogNames.some((name) => catalog.bundles.some((bundle) => bundle.name === name))) {
    return "catalogued";
  }
  return "on-demand";
}

export function capabilityStatusLabel(readiness: CapabilityReadiness): string {
  if (readiness === "host-check") return "Check on selected host";
  if (readiness === "native") return "Included";
  if (readiness === "composition") return "Standard composition";
  if (readiness === "catalogued") return "Bundle found";
  return "Available on demand";
}

export function sessionUsesCapability(
  capability: StudioCapability,
  session: Pick<SessionViewState, "bundle" | "capabilityId">,
): boolean {
  if (session.capabilityId === capability.id) return true;
  const bundle = session.bundle.trim().toLowerCase().replace(/^bundle:/, "");
  return capability.catalogNames.some((name) => bundle === name.toLowerCase())
    || Boolean(capability.bundle && bundle.includes(capability.bundle.toLowerCase()));
}

export function capabilitySessionInput(
  capability: StudioCapability,
  projectDir: string,
  current?: Pick<NewSessionInput, "provider" | "model">,
): NewSessionInput {
  return {
    projectDir,
    bundle: capability.bundle,
    provider: current?.provider,
    model: current?.model,
    mode: capability.mode,
    capabilityId: capability.id,
    capabilityName: capability.name,
  };
}

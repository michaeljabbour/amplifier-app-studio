import type { CapabilityCatalog, NewSessionInput } from "./protocol";

export type StudioCapabilityId =
  | "coordinator"
  | "browser"
  | "app-use"
  | "terminal"
  | "imagen"
  | "attractor";

export interface StudioCapability {
  id: StudioCapabilityId;
  name: string;
  eyebrow: string;
  outcome: string;
  description: string;
  action: string;
  bundle?: string;
  catalogNames: string[];
  mode: string;
  requirements: string;
  accent: "blue" | "green" | "amber" | "violet";
  activation: "parallel-session" | "included" | "post-release";
}

export type CapabilityReadiness = "native" | "catalogued" | "on-demand" | "post-release";

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
    requirements: "Uses your active Amplifier composition.",
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
    requirements: "Requires agent-browser on the runtime host; first launch may prepare the bundle.",
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
    requirements: "Requires a computer-use-capable model and the runtime host's screen-control permissions.",
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
    requirements: "Included with the standard Amplifier runtime on the selected host.",
    accent: "green",
    activation: "included",
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
    requirements: "Requires imagen-mcp plus configured OpenAI or Gemini image credentials.",
    accent: "violet",
    activation: "parallel-session",
  },
  {
    id: "attractor",
    name: "Attractor",
    eyebrow: "WORKFLOW ENGINE",
    outcome: "Design and run inspectable graph-based agent workflows.",
    description: "Planned integration for DOT pipelines, branches, retries, and human gates after Studio's dedicated workflow event transport is ready.",
    action: "Planned after v0.1",
    bundle: "git+https://github.com/microsoft/amplifier-bundle-attractor@38db3ef6f8ce785c9777d6d702421cfa8f22f80a#subdirectory=bundles/attractor-interactive.yaml",
    catalogNames: ["attractor", "attractor-interactive"],
    mode: "auto",
    requirements: "Post-release: requires dedicated node, transition, retry, and human-gate events instead of inferred transcript state.",
    accent: "amber",
    activation: "post-release",
  },
];

export function capabilityReadiness(
  capability: StudioCapability,
  catalog: CapabilityCatalog,
): CapabilityReadiness {
  if (capability.activation === "post-release") return "post-release";
  if (capability.id === "coordinator" || capability.id === "terminal") return "native";
  if (capability.catalogNames.some((name) => catalog.bundles.some((bundle) => bundle.name === name))) {
    return "catalogued";
  }
  return "on-demand";
}

export function capabilityStatusLabel(readiness: CapabilityReadiness): string {
  if (readiness === "post-release") return "Post-release";
  if (readiness === "native") return "Included";
  if (readiness === "catalogued") return "Catalogued";
  return "Loads on first use";
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

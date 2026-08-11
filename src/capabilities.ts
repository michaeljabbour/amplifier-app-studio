import type { CapabilityCatalog, NewSessionInput } from "./protocol";

export type StudioCapabilityId =
  | "coordinator"
  | "app-use"
  | "browser"
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
}

export type CapabilityReadiness = "native" | "catalogued" | "on-demand";

export const STUDIO_CAPABILITIES: StudioCapability[] = [
  {
    id: "coordinator",
    name: "Coordinator",
    eyebrow: "CORE MACHINE",
    outcome: "Organize work, build plans, and direct parallel specialists.",
    description: "The main Amplifier conversation stays open while agent workspaces and outputs develop around it.",
    action: "Start coordinating",
    catalogNames: [],
    mode: "auto",
    requirements: "Uses your active Amplifier composition.",
    accent: "blue",
  },
  {
    id: "app-use",
    name: "App Use",
    eyebrow: "AUTOPILOT",
    outcome: "Let Amplifier see and operate desktop interfaces, including Studio.",
    description: "Runs the native computer-use bundle in an isolated auto-mode session with Amplifier's normal approval boundaries.",
    action: "Launch Autopilot",
    bundle: "computer-use",
    catalogNames: ["computer-use", "computer-use-behavior"],
    mode: "auto",
    requirements: "Requires a computer-use provider and OS screen/accessibility permission.",
    accent: "green",
  },
  {
    id: "browser",
    name: "Browser Use",
    eyebrow: "WEB OPERATOR",
    outcome: "Navigate, inspect, test, and verify real web experiences.",
    description: "Adds focused browser operators to a new Amplifier runtime with visible progress and isolated work.",
    action: "Open browser machine",
    bundle: "git+https://github.com/microsoft/amplifier-bundle-browser-tester@3446c383b8a9d366b8d88f832d0f3ffb73c62dec",
    catalogNames: ["browser-tester"],
    mode: "auto",
    requirements: "Requires agent-browser on the runtime host; first launch may prepare the bundle.",
    accent: "blue",
  },
  {
    id: "terminal",
    name: "Terminal Use",
    eyebrow: "BUILT IN",
    outcome: "Run fast coding and infrastructure commands in the project boundary.",
    description: "Amplifier's standard machine already includes the bash tool. No extra plugin or terminal harness is needed for normal command work.",
    action: "Start terminal-capable session",
    catalogNames: [],
    mode: "auto",
    requirements: "Included with the standard Amplifier runtime on the selected host.",
    accent: "green",
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
  },
  {
    id: "attractor",
    name: "Attractor",
    eyebrow: "WORKFLOW ENGINE",
    outcome: "Design and run inspectable graph-based agent workflows.",
    description: "Launches an exclusive interactive Attractor runtime for DOT pipelines, branches, retries, and human gates.",
    action: "Open workflow studio",
    bundle: "git+https://github.com/microsoft/amplifier-bundle-attractor@38db3ef6f8ce785c9777d6d702421cfa8f22f80a#subdirectory=bundles/attractor-interactive.yaml",
    catalogNames: ["attractor", "attractor-interactive"],
    mode: "auto",
    requirements: "Development-grade profile: some internal dependencies still track main.",
    accent: "amber",
  },
];

export function capabilityReadiness(
  capability: StudioCapability,
  catalog: CapabilityCatalog,
): CapabilityReadiness {
  if (capability.id === "coordinator" || capability.id === "terminal") return "native";
  if (capability.catalogNames.some((name) => catalog.bundles.some((bundle) => bundle.name === name))) {
    return "catalogued";
  }
  return "on-demand";
}

export function capabilityStatusLabel(readiness: CapabilityReadiness): string {
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

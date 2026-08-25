import type { RuntimeHost } from "./transport";

export interface ComputeConnectionPrompt {
  kind: "connect" | "reconnect" | "attention";
  kicker: string;
  title: string;
  description: string;
  action: string;
  composerLabel: string;
  composerPlaceholder: string;
}

export function computeConnectionPrompt(
  host: RuntimeHost | undefined,
  accessRequired: boolean,
  runtimeMessage?: string,
): ComputeConnectionPrompt {
  if (!host?.url) {
    return {
      kind: "connect",
      kicker: "ENGINE SETUP",
      title: runtimeMessage || "Connect a compute host",
      description: "Choose the computer that will run Amplifier sessions for this device.",
      action: "Connect compute host",
      composerLabel: "Compute setup required",
      composerPlaceholder: "Connect a compute host to start",
    };
  }

  const hostName = host.name.trim() || "Saved compute";
  const hostname = safeHostname(host.url);
  if (accessRequired) {
    return {
      kind: "reconnect",
      kicker: "COMPUTE ACCESS",
      title: `Reconnect ${hostName}`,
      description: `${hostName} is still saved as Session home${hostname ? ` at ${hostname}` : ""}. Enter its access token to use it after reopening Studio.`,
      action: `Reconnect ${hostName}`,
      composerLabel: `${hostName} needs its access token`,
      composerPlaceholder: `Reconnect ${hostName} to start`,
    };
  }

  return {
    kind: "attention",
    kicker: "COMPUTE CHECK",
    title: `${hostName} needs attention`,
    description: runtimeMessage
      ? `${runtimeMessage} Review the saved connection and try again.`
      : `Studio could not verify ${hostName}${hostname ? ` at ${hostname}` : ""}. Review the saved connection and try again.`,
    action: `Review ${hostName}`,
    composerLabel: `${hostName} needs attention`,
    composerPlaceholder: `Review ${hostName} to start`,
  };
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

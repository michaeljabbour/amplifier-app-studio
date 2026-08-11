import type { SessionViewState, UserBlock } from "./protocol";

export const DEFAULT_AUTOPILOT_MAX_TURNS = 32;

function latestUserPrompt(session: Pick<SessionViewState, "blocks">): string | undefined {
  return [...session.blocks]
    .reverse()
    .find((block): block is UserBlock => block.kind === "user")
    ?.text.trim() || undefined;
}

/**
 * Autopilot is Amplifier's native goal loop, scoped to the active runtime.
 * Studio only declares/clears the goal; loop-streaming owns evaluation,
 * continuation, stall detection, and completion.
 */
export function activeSessionAutopilotOp(
  session: Pick<SessionViewState, "autopilot" | "goal" | "blocks">,
): Record<string, unknown> | undefined {
  if (session.autopilot || session.goal?.state === "continuing" || session.goal?.state === "armed") {
    return { op: "goal.clear" };
  }
  const condition = latestUserPrompt(session);
  return condition
    ? { op: "goal.set", condition, max_turns: DEFAULT_AUTOPILOT_MAX_TURNS }
    : undefined;
}

export function canEngageAutopilot(
  session: Pick<SessionViewState, "phase" | "autopilot" | "goal" | "blocks" | "autopilotPending"> | undefined,
): boolean {
  if (!session || session.phase !== "ready" || session.autopilotPending) return false;
  if (session.autopilot || session.goal?.state === "continuing" || session.goal?.state === "armed") return true;
  return Boolean(latestUserPrompt(session));
}

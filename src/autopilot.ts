import type { SessionViewState } from "./protocol";

export const ACTIVE_SESSION_AUTOPILOT_INSTRUCTION = `Autopilot this active session. Continue the current task autonomously from the existing context. Coordinate and delegate parallel work when useful, use the tools already mounted in this runtime, keep concrete progress visible, verify the result, and stop only when the goal is complete or a consequential decision genuinely requires me. Do not start or hand off to a replacement coordinator session.`;

export function activeSessionAutopilotOp(
  session: Pick<SessionViewState, "busy">,
): Record<string, unknown> {
  return {
    op: session.busy ? "steer" : "submit",
    text: ACTIVE_SESSION_AUTOPILOT_INSTRUCTION,
  };
}

export function canEngageAutopilot(
  session: Pick<SessionViewState, "phase"> | undefined,
): boolean {
  return session?.phase === "ready";
}

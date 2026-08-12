import { describe, expect, it } from "vitest";
import { activeSessionAutopilotOp, canEngageAutopilot, DEFAULT_AUTOPILOT_MAX_TURNS } from "./autopilot";

const user = (text: string) => ({ id: "b1", kind: "user" as const, text });

describe("active-session Autopilot", () => {
  it("arms the active session's goal controller from the latest user objective", () => {
    expect(activeSessionAutopilotOp({ autopilot: false, blocks: [user("Ship the cross-platform app")] })).toEqual({
      op: "goal.set",
      condition: "Ship the cross-platform app",
      max_turns: DEFAULT_AUTOPILOT_MAX_TURNS,
    });
  });

  it("turns the controller off instead of starting another session", () => {
    expect(activeSessionAutopilotOp({ autopilot: true, blocks: [] })).toEqual({ op: "goal.clear" });
    expect(activeSessionAutopilotOp({ autopilot: false, goal: {
      state: "continuing", turn: 2, continuations: 1, updatedAtMs: 1,
    }, blocks: [] })).toEqual({ op: "goal.clear" });
  });

  it("requires a ready runtime and an objective, but always allows turning off", () => {
    expect(canEngageAutopilot({ phase: "ready", autopilot: false, blocks: [user("Do it")], autopilotPending: false })).toBe(true);
    expect(canEngageAutopilot({ phase: "ready", autopilot: false, blocks: [], autopilotPending: false })).toBe(false);
    expect(canEngageAutopilot({ phase: "starting", autopilot: true, blocks: [], autopilotPending: false })).toBe(false);
    expect(canEngageAutopilot(undefined)).toBe(false);
  });
});

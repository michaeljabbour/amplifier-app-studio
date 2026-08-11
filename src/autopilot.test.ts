import { describe, expect, it } from "vitest";
import { ACTIVE_SESSION_AUTOPILOT_INSTRUCTION, activeSessionAutopilotOp, canEngageAutopilot } from "./autopilot";

describe("active-session Autopilot", () => {
  it("continues an idle coordinator without creating another session", () => {
    expect(activeSessionAutopilotOp({ busy: false })).toEqual({
      op: "submit",
      text: ACTIVE_SESSION_AUTOPILOT_INSTRUCTION,
    });
    expect(ACTIVE_SESSION_AUTOPILOT_INSTRUCTION).toContain("this active session");
    expect(ACTIVE_SESSION_AUTOPILOT_INSTRUCTION).toContain("Do not start");
  });

  it("steers the active turn when the coordinator is already working", () => {
    expect(activeSessionAutopilotOp({ busy: true }).op).toBe("steer");
  });

  it("only enables the control for a ready runtime", () => {
    expect(canEngageAutopilot({ phase: "ready" })).toBe(true);
    expect(canEngageAutopilot({ phase: "starting" })).toBe(false);
    expect(canEngageAutopilot(undefined)).toBe(false);
  });
});

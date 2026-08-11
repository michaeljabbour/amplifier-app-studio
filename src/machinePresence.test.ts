import { describe, expect, it } from "vitest";
import { machinePresence } from "./machinePresence";
import { createSessionState } from "./reducer";

describe("machinePresence", () => {
  it("distinguishes an independent runtime from its delegate workspaces", () => {
    const base = { ...createSessionState("gui", { projectDir: "/tmp/project" }), phase: "ready" as const };
    const live = machinePresence({
      ...base,
      busy: true,
      activity: "Thinking",
      lanes: {
        child: { id: "child", agent: "explorer", status: "running", activity: "Reading", tail: "", tailKind: "text", thinking: "", tools: [], events: [] },
      },
    });
    expect(live).toMatchObject({ label: "Thinking", detail: "1 agent", live: true });
  });

  it("surfaces attention ahead of generic working state", () => {
    const state = createSessionState("gui", { projectDir: "/tmp/project" });
    const presence = machinePresence({
      ...state,
      phase: "ready",
      busy: true,
      pendingApproval: { ticketId: "1", prompt: "Run it?", options: ["Allow", "Deny"] },
    });
    expect(presence.tone).toBe("attention");
    expect(presence.label).toContain("needs you");
  });
});

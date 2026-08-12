import { describe, expect, it } from "vitest";
import { createSessionState, reduceRecord } from "../reducer";
import { coordinatorExecutionLabel, runtimeProofLabel, sessionToolbarStatus } from "./SessionToolbar";

describe("session toolbar status", () => {
  it("reports restoration instead of claiming a resumed session is ready", () => {
    const state = createSessionState("resume", {
      projectDir: "/tmp/project",
      resumeId: "stored-session",
    });
    expect(sessionToolbarStatus(state)).toBe("Restoring session");
  });

  it("reports readiness only after a new runtime has started", () => {
    const state = reduceRecord(createSessionState("new", { projectDir: "/tmp/project" }), {
      schema_version: 1,
      type: "session.started",
      session_id: "runtime-session",
    });
    expect(sessionToolbarStatus(state)).toBe("Ready for the next turn");
    expect(runtimeProofLabel(state)).toBe("Amplifier runtime connected");
    expect(coordinatorExecutionLabel(state)).toBe("Coordinator idle");
  });

  it("distinguishes a connected runtime from an actively running coordinator", () => {
    const ready = reduceRecord(createSessionState("new", { projectDir: "/tmp/project" }), {
      schema_version: 1,
      type: "session.started",
      session_id: "runtime-session",
    });
    expect(coordinatorExecutionLabel({ ...ready, busy: true })).toBe("Coordinator running");
  });
});

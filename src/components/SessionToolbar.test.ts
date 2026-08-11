import { describe, expect, it } from "vitest";
import { createSessionState, reduceRecord } from "../reducer";
import { sessionToolbarStatus } from "./SessionToolbar";

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
  });
});

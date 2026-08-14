import { describe, expect, it } from "vitest";
import type { StoredSession } from "./protocol";
import { storedSessionResumeBlocker, storedSessionWarning } from "./sessionAvailability";

function stored(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId: "session-1",
    name: "Session",
    bundle: "default",
    tags: [],
    messageCount: 4,
    summary: "Ready to continue this saved run.",
    mtimeMs: 1,
    projectSlug: "project",
    projectDir: "/tmp/project",
    state: "ok",
    ...overrides,
  };
}

describe("stored session availability", () => {
  it("explains each disabled health state", () => {
    expect(storedSessionResumeBlocker(stored({ state: "recovered" }), true)).toContain("recovered metadata");
    expect(storedSessionResumeBlocker(stored({ state: "indexing" }), true)).toContain("no metadata record");
    expect(storedSessionResumeBlocker(stored({ state: "empty" }), true)).toContain("before it wrote");
    expect(storedSessionResumeBlocker(stored({ state: "corrupt" }), true)).toContain("corrupt");
  });

  it("allows the drawer to collect a missing project path but blocks one-click home resume", () => {
    const session = stored({ projectDir: undefined });
    expect(storedSessionResumeBlocker(session, false)).toBeUndefined();
    expect(storedSessionResumeBlocker(session, true)).toContain("project folder");
    expect(storedSessionWarning(session)).toContain("Choose the original project folder");
  });

  it("warns without disabling a damaged transcript", () => {
    const session = stored({ state: "transcript_lost" });
    expect(storedSessionResumeBlocker(session, true)).toBeUndefined();
    expect(storedSessionWarning(session)).toContain("Transcript history is damaged");
  });
});

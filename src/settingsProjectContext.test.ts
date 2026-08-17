import { describe, expect, it } from "vitest";
import type { SessionViewState } from "./protocol";
import { createSessionState } from "./reducer";
import { projectContextForHost } from "./settingsProjectContext";

function session(overrides: Partial<SessionViewState>): SessionViewState {
  return { ...createSessionState("gui-1", { projectDir: "/home/mjabbour/dev" }), ...overrides };
}

describe("settings project context host isolation", () => {
  it("does not reuse an active session path from a different connected host", () => {
    expect(projectContextForHost(session({
      hostId: "connected",
      hostUrl: "https://spark.example.test",
    }), {
      id: "connected",
      name: "Local test host",
      url: "http://127.0.0.1:4401",
      tokenRef: "session",
    }, "/Users/michaeljabbour/dev")).toBe("/Users/michaeljabbour/dev");
  });

  it("keeps the active project when the session and settings host match", () => {
    expect(projectContextForHost(session({
      projectDir: "/home/mjabbour/dev/amplifier",
      hostId: "connected",
      hostUrl: "https://spark.example.test/",
    }), {
      id: "connected",
      name: "Spark",
      url: "https://spark.example.test",
      tokenRef: "session",
    }, "/home/mjabbour/dev")).toBe("/home/mjabbour/dev/amplifier");
  });
});

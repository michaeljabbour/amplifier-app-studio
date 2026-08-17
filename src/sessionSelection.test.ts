import { describe, expect, it } from "vitest";
import { createSessionState } from "./reducer";
import { openGuiIdForStoredSession } from "./sessionSelection";

describe("openGuiIdForStoredSession", () => {
  it("focuses an in-flight resume instead of launching a duplicate runtime", () => {
    const session = createSessionState("gui-resume", {
      projectDir: "/home/mjabbour/dev/project",
      resumeId: "durable-123",
    });

    expect(openGuiIdForStoredSession([session], "durable-123")).toBe("gui-resume");
  });

  it("matches a session after the runtime has attached its durable id", () => {
    const session = {
      ...createSessionState("gui-attached", { projectDir: "/home/mjabbour/dev/project" }),
      runtimeSessionId: "durable-456",
    };

    expect(openGuiIdForStoredSession([session], "durable-456")).toBe("gui-attached");
  });

  it("allows a genuinely closed session to resume", () => {
    expect(openGuiIdForStoredSession([], "durable-789")).toBeUndefined();
  });
});

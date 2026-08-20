import { describe, expect, it } from "vitest";
import { createSessionState } from "./reducer";
import { openGuiIdForStoredSession, parallelSessionSummary } from "./sessionSelection";

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

  it("does not let a stopped diagnostic tab block a fresh resume", () => {
    const failed = {
      ...createSessionState("gui-failed", {
        projectDir: "/home/mjabbour/dev/project",
        resumeId: "durable-789",
      }),
      phase: "error" as const,
    };
    const exited = { ...failed, guiId: "gui-exited", phase: "exited" as const };

    expect(openGuiIdForStoredSession([failed, exited], "durable-789")).toBeUndefined();
  });

  it("does not confuse identical durable ids owned by different compute hosts", () => {
    const session = createSessionState("gui-spark-a", {
      projectDir: "/home/mjabbour/dev/project",
      hostId: "spark-a",
      hostName: "Spark A",
      hostUrl: "http://127.0.0.1:4318/",
      resumeId: "durable-shared",
    });

    expect(openGuiIdForStoredSession([session], "durable-shared", {
      hostId: "spark-b",
      hostUrl: "http://127.0.0.1:4319/",
    })).toBeUndefined();
    expect(openGuiIdForStoredSession([session], "durable-shared", {
      hostId: "spark-a",
      hostUrl: "http://127.0.0.1:4318",
    })).toBe("gui-spark-a");
  });
});

describe("parallelSessionSummary", () => {
  it("distinguishes live runtimes from stopped diagnostic tabs", () => {
    expect(parallelSessionSummary([{ phase: "ready" }, { phase: "starting" }])).toBe("2 ACTIVE");
    expect(parallelSessionSummary([{ phase: "ready" }, { phase: "error" }, { phase: "exited" }]))
      .toBe("1 ACTIVE · 2 STOPPED");
    expect(parallelSessionSummary([{ phase: "error" }])).toBe("1 STOPPED");
  });
});

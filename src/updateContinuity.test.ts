import { describe, expect, it } from "vitest";
import type { SessionViewState } from "./protocol";
import { hydrateLegacyUpdateRestoreEntry, saveUpdateRestorePlan, takeUpdateRestorePlan } from "./updateContinuity";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function session(guiId: string, runtimeSessionId?: string, phase: SessionViewState["phase"] = "ready"): SessionViewState {
  return {
    guiId,
    runtimeSessionId,
    projectDir: `/projects/${guiId}`,
    title: `Session ${guiId}`,
    bundle: "tui",
    model: "model",
    mode: "auto",
    phase,
    bootLabel: "ready",
    busy: false,
    composerDraft: "",
    composerAttachments: [],
    autopilot: false,
    autopilotPending: false,
    activity: "ready",
    replaying: false,
    context: {
      tokens: 0,
      window: 0,
      percent: 0,
      costUsd: "0",
      costBasis: "unavailable",
      inputTokens: 0,
      outputTokens: 0,
      unpricedTokens: 0,
      usageResponses: 0,
    },
    effortLevels: ["none"],
    blocks: [],
    lanes: {},
    pendingDelegateBriefs: {},
    plans: {},
    turnLoop: {
      phase: "idle",
      detail: "Waiting for a prompt",
      iteration: 0,
      modelPasses: 0,
      toolCalls: 0,
      toolResults: 0,
      toolFailures: 0,
      delegates: 0,
      completedDelegates: 0,
      responseBlocks: 0,
      awaitingModelPass: false,
      activeTools: {},
      activeDelegates: {},
      transitions: [],
      appliedEvents: {},
    },
    alerts: [],
    outputs: [],
    queuedSteers: 0,
    nextBlock: 1,
    logs: [],
  };
}

describe("update restart continuity", () => {
  it("restores every ready runtime and opens the previously active one last", () => {
    const storage = memoryStorage();
    expect(saveUpdateRestorePlan(storage, [session("active", "runtime-a"), session("other", "runtime-b")], "active", 10)).toBe(true);
    expect(takeUpdateRestorePlan(storage, 20)).toEqual([
      { projectDir: "/projects/other", mode: "auto", resumeId: "runtime-b", active: false },
      { projectDir: "/projects/active", mode: "auto", resumeId: "runtime-a", active: true },
    ]);
    expect(takeUpdateRestorePlan(storage, 20)).toEqual([]);
  });

  it("preserves the owning compute and resume expectations across an app restart", () => {
    const storage = memoryStorage();
    const remote = {
      ...session("remote", "runtime-remote"),
      hostId: "spark-288f",
      hostName: "Spark 288f",
      hostUrl: "http://127.0.0.1:4318/",
      requestedBundle: "anchors",
      requestedModel: "anthropic/claude-opus-5",
      requestedProvider: "anthropic",
      expectedHistoryMessages: 101,
    };

    expect(saveUpdateRestorePlan(storage, [remote], "remote", 10)).toBe(true);
    expect(takeUpdateRestorePlan(storage, 20)).toEqual([{
      projectDir: "/projects/remote",
      hostId: "spark-288f",
      hostName: "Spark 288f",
      hostUrl: "http://127.0.0.1:4318/",
      bundle: "anchors",
      model: "anthropic/claude-opus-5",
      provider: "anthropic",
      mode: "auto",
      resumeId: "runtime-remote",
      expectedHistoryMessages: 101,
      active: true,
    }]);
  });

  it("hydrates a legacy restore plan from one unambiguous federated session", () => {
    const legacy = {
      projectDir: "/home/mjabbour/dev/project/",
      resumeId: "runtime-remote",
      active: true,
    };
    const hydrated = hydrateLegacyUpdateRestoreEntry(legacy, [{
      sessionId: "runtime-remote",
      hostId: "spark-288f",
      hostName: "Spark 288f",
      hostUrl: "http://127.0.0.1:4318/",
      name: "Remote session",
      bundle: "anchors",
      tags: [],
      messageCount: 101,
      mtimeMs: 1,
      projectSlug: "project",
      projectDir: "/home/mjabbour/dev/project",
      state: "ok",
      summary: "Saved work",
    }]);

    expect(hydrated).toMatchObject({
      hostId: "spark-288f",
      hostName: "Spark 288f",
      hostUrl: "http://127.0.0.1:4318/",
      expectedHistoryMessages: 101,
    });
  });

  it("does not guess when a legacy durable id matches more than one compute", () => {
    const legacy = { projectDir: "/project", resumeId: "shared", active: true };
    const candidate = {
      sessionId: "shared",
      name: "Shared",
      bundle: "anchors",
      tags: [],
      messageCount: 2,
      mtimeMs: 1,
      projectSlug: "project",
      projectDir: "/project",
      state: "ok" as const,
      summary: "Saved work",
    };

    expect(hydrateLegacyUpdateRestoreEntry(legacy, [
      { ...candidate, hostId: "spark-a", hostName: "Spark A" },
      { ...candidate, hostId: "spark-b", hostName: "Spark B" },
    ])).toEqual(legacy);
  });

  it("derives a non-empty resume expectation for sessions created in this app run", () => {
    const storage = memoryStorage();
    const created = {
      ...session("created", "runtime-created"),
      blocks: [
        { id: "u1", kind: "user" as const, text: "Build it", mode: "auto" },
        { id: "a1", kind: "answer" as const, text: "Done", final: true },
      ],
    };

    expect(saveUpdateRestorePlan(storage, [created], "created", 10)).toBe(true);
    expect(takeUpdateRestorePlan(storage, 20)).toEqual([
      expect.objectContaining({ expectedHistoryMessages: 2 }),
    ]);
  });

  it("ignores incomplete, non-ready, corrupt, and stale restore data", () => {
    const storage = memoryStorage();
    expect(saveUpdateRestorePlan(storage, [session("starting", "runtime", "starting"), session("missing")], "starting", 10)).toBe(false);
    storage.setItem("amplifier-studio.update-restore.v1", "not json");
    expect(takeUpdateRestorePlan(storage, 20)).toEqual([]);
    expect(saveUpdateRestorePlan(storage, [session("old", "runtime-old")], "old", 10)).toBe(true);
    expect(takeUpdateRestorePlan(storage, 24 * 60 * 60 * 1_000 + 11)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { SessionViewState } from "./protocol";
import { saveUpdateRestorePlan, takeUpdateRestorePlan } from "./updateContinuity";

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
    autopilot: false,
    activity: "ready",
    replaying: false,
    context: { tokens: 0, window: 0, percent: 0, costUsd: "0" },
    effortLevels: ["none"],
    blocks: [],
    lanes: {},
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
      { projectDir: "/projects/other", resumeId: "runtime-b", resumeName: "Session other", active: false },
      { projectDir: "/projects/active", resumeId: "runtime-a", resumeName: "Session active", active: true },
    ]);
    expect(takeUpdateRestorePlan(storage, 20)).toEqual([]);
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

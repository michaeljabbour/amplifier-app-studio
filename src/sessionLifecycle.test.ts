import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSessionState, reduceRecord } from "./reducer";
import { adjacentTabIndex, attemptRuntimeStop, ordinaryTabCloseIntent, sessionCanDetachSafely, stopRuntimeActivity } from "./sessionLifecycle";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("./components/SessionLifecycleDialog.tsx", import.meta.url), "utf8");
const tabStripSource = readFileSync(new URL("./components/TabStrip.tsx", import.meta.url), "utf8");

describe("safe session lifecycle", () => {
  it("makes ordinary close detach durable and remote sessions", () => {
    const durable = reduceRecord(createSessionState("durable", { projectDir: "/project" }), {
      schema_version: 1,
      type: "session.started",
      session_id: "runtime-session",
    });
    const remote = createSessionState("remote", {
      projectDir: "/project",
      hostId: "spark",
      hostName: "Spark 288f",
      hostUrl: "https://spark.example",
    });

    expect(sessionCanDetachSafely(durable)).toBe(true);
    expect(ordinaryTabCloseIntent(durable)).toBe("detach");
    expect(ordinaryTabCloseIntent(remote)).toBe("detach");
  });

  it("requires an explicit decision before closing a local runtime without durable identity", () => {
    const starting = createSessionState("local", { projectDir: "/project", hostId: "local" });
    expect(sessionCanDetachSafely(starting)).toBe(false);
    expect(ordinaryTabCloseIntent(starting)).toBe("confirm-stop");
    expect(ordinaryTabCloseIntent({ ...starting, phase: "error" })).toBe("detach");
  });

  it("puts active work in the destructive confirmation", () => {
    const session = { ...createSessionState("busy", { projectDir: "/project" }), busy: true };
    expect(stopRuntimeActivity(session)).toEqual({
      label: "Active turn in progress",
      detail: "Stopping now interrupts the coordinator and any running child agents.",
      tone: "active",
    });
  });

  it("supports wrapping arrow, Home, and End keyboard navigation", () => {
    expect(adjacentTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(adjacentTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(adjacentTabIndex("Home", 2, 3)).toBe(0);
    expect(adjacentTabIndex("End", 0, 3)).toBe(2);
    expect(adjacentTabIndex("Enter", 0, 3)).toBeUndefined();
  });

  it("reports stop rejection without turning it into a successful detach", async () => {
    await expect(attemptRuntimeStop(async () => false)).resolves.toEqual({
      stopped: false,
      error: "The runtime reported that it is still running",
    });
    await expect(attemptRuntimeStop(async () => {
      throw new Error("Host did not confirm shutdown");
    })).resolves.toEqual({
      stopped: false,
      error: "Host did not confirm shutdown",
    });
    await expect(attemptRuntimeStop(async () => true)).resolves.toEqual({ stopped: true });
  });

  it("keeps tab selection and close as separate native controls with tab semantics", () => {
    expect(tabStripSource).toContain('role="tablist"');
    expect(tabStripSource).toContain('role="tab"');
    expect(tabStripSource).toContain('aria-controls={`session-panel-${session.guiId}`}');
    expect(tabStripSource).toContain('<button\n                class="tab-close"');
    expect(tabStripSource).not.toContain('role="button"');
    expect(appSource).toContain('role="tabpanel"');
  });

  it("keeps failed stops visible and recoverable instead of discarding the session", () => {
    expect(appSource).toMatch(/if \(outcome\.stopped\) \{\s*discardSessionView\(guiId\);/);
    expect(appSource).toContain("setStopRuntimeRequest({ guiId, stopping: false, error: message })");
    expect(dialogSource).toContain('role="alert"');
    expect(dialogSource).toContain('props.error ? "Retry stop"');
    expect(dialogSource).toContain("Detach view");
  });
});

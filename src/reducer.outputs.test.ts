import { describe, expect, it } from "vitest";
import { createSessionState, reduceRecord, retryRestore } from "./reducer";
import type { ProtocolRecord } from "./protocol";

function event(sequence: number, fields: Record<string, unknown>, replay = false): ProtocolRecord {
  return { type: "runtime.event", schema_version: 1, sequence, replay,
    event: { event_id: `output-${sequence}`, session_id: "root", parent_id: null, ...fields } };
}

function fresh(resume = false) {
  return createSessionState("studio", { projectDir: "/project", ...(resume ? { resumeId: "root" } : {}) });
}

describe("live and restored output inventory", () => {
  it("hydrates explicit runtime artifact writes without a tool_post, preserving child and host provenance", () => {
    let state = fresh(true);
    state = reduceRecord(state, { type: "history.begin", since: 0, source: "ui-events" });
    const write = event(1, { kind: "artifact_write", path: "/project/chart.png", bytes_written: 51,
      session_id: "child", parent_id: "root", runtime_host: "remote-host" }, true);
    state = reduceRecord(state, write);
    state = reduceRecord(state, write);
    expect(state.outputs).toEqual([expect.objectContaining({ path: "/project/chart.png", kind: "image",
      laneId: "child", eventId: "output-1", runtimeHost: "remote-host", provenance: "artifact-write" })]);
    expect(state.blocks).toEqual([]);
  });

  it("correlates input-omitting completions across independent parent and child tool calls", () => {
    let state = fresh();
    state = reduceRecord(state, event(1, { kind: "tool_pre", tool_name: "write_file", tool_call_id: "shared",
      tool_input: { path: "root.html", content: "Do not retain file contents in pending output bookkeeping" } }));
    state = reduceRecord(state, event(2, { kind: "tool_pre", tool_name: "write_file", tool_call_id: "shared",
      session_id: "child", parent_id: "root", tool_input: { path: "child.csv" } }));
    expect(state.pendingOutputTools?.["root:shared"].input).toEqual({ path: "root.html" });
    state = reduceRecord(state, event(3, { kind: "tool_post", tool_call_id: "shared", tool_input: {},
      result: { value: JSON.stringify({ success: true, output: { bytes_written: 10 } }) } }));
    state = reduceRecord(state, event(4, { kind: "tool_post", tool_call_id: "shared", session_id: "child", parent_id: "root",
      result: { success: true, output: { bytes_written: 10 } } }));
    expect(state.outputs).toEqual([
      expect.objectContaining({ path: "root.html", toolCallId: "shared", provenance: "write-target" }),
      expect.objectContaining({ path: "child.csv", laneId: "child", toolCallId: "shared", provenance: "write-target" }),
    ]);
    expect(state.pendingOutputTools).toEqual({});
  });

  it("replays tool-reported outputs idempotently and ignores failed writes", () => {
    let state = fresh(true);
    state = reduceRecord(state, event(1, { kind: "tool_pre", tool_name: "write_file", tool_call_id: "failed",
      tool_input: { path: "never-created.html" } }, true));
    state = reduceRecord(state, event(2, { kind: "tool_post", tool_name: "write_file", tool_call_id: "failed",
      result: { value: JSON.stringify({ success: false, error: "permission denied" }) } }, true));
    const shell = event(3, { kind: "tool_post", tool_name: "bash", tool_call_id: "generated",
      result: { success: true, output: { returncode: 0, stdout: "wrote reports/report.html\n" } } }, true);
    state = reduceRecord(state, shell);
    state = reduceRecord(state, shell);
    expect(state.outputs).toEqual([expect.objectContaining({ path: "reports/report.html",
      source: "bash · reported output", provenance: "tool-report" })]);
    expect(state.blocks.find((block) => block.kind === "tool" && block.toolCallId === "failed")).toMatchObject({ status: "failed" });
  });

  it("retains the full restored inventory instead of silently dropping outputs after eighty files", () => {
    let state = fresh(true);
    for (let index = 1; index <= 90; index++) {
      state = reduceRecord(state, event(index, { kind: "artifact_write", path: `reports/${index}.html` }, true));
    }
    expect(state.outputs).toHaveLength(90);
    expect(state.outputs[0].path).toBe("reports/1.html");
    state = reduceRecord(state, event(91, { kind: "tool_pre", tool_name: "write_file", tool_call_id: "pending",
      tool_input: { path: "pending.html" } }, true));
    state = retryRestore(state);
    expect(state.outputs).toEqual([]);
    expect(state.pendingOutputTools).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import { delegateRecoveryInstruction } from "./delegateRecovery";
import { createSessionState, reduceRecord } from "./reducer";
import { isLaneHistorical } from "./agentLanes";

function delegateState(replay: boolean) {
  let state = createSessionState("gui", { projectDir: "/project" });
  state = { ...state, runtimeSessionId: "parent", runtimeCapabilities: { protocolVersion: 1, features: ["delegates.resume"], operations: {} } };
  for (const event of [
    { kind: "agent_spawned", event_id: "s", session_id: "parent", parent_session_id: "parent", sub_session_id: "child", agent: "Researcher" },
    { kind: "agent_completed", event_id: "c", session_id: "parent", parent_session_id: "parent", sub_session_id: "child", incomplete: true, success: false, result: "Partial work (not final): two findings", ts: 1 },
  ]) state = reduceRecord(state, { type: "runtime.event", replay, event });
  return state;
}

describe("delegate recovery presentation", () => {
  it.each([false, true])("preserves incomplete partial work and parent ownership (replay=%s)", (replay) => {
    const state = delegateState(replay);
    const lane = state.lanes.child;
    expect(lane.status).toBe("incomplete");
    expect(lane.partialResult).toContain("two findings");
    expect(lane.events.at(-1)?.title).toBe("Agent incomplete");
    expect(delegateRecoveryInstruction(state, lane)).toContain("parent session (parent)");
    expect(delegateRecoveryInstruction(state, { ...lane, parentId: "other-parent" })).toBeUndefined();
    expect(delegateRecoveryInstruction({ ...state, runtimeCapabilities: undefined }, lane)).toBeUndefined();
  });

  it("reopens a resumed lane as live and removes its stale partial result", () => {
    let state = delegateState(false);
    expect(isLaneHistorical(state.lanes.child)).toBe(true);
    state = reduceRecord(state, { type: "runtime.event", event: { kind: "agent_resumed", event_id: "r", session_id: "child", parent_session_id: "parent" } });
    expect(state.lanes.child.status).toBe("running");
    expect(state.lanes.child.partialResult).toBeUndefined();
    expect(isLaneHistorical(state.lanes.child)).toBe(false);
  });
});

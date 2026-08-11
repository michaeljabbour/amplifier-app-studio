import { describe, expect, it } from "vitest";
import { laneLivePreview, liveAgentCount, orderAgentLanes } from "./agentLanes";
import type { LaneState } from "./protocol";

function lane(id: string, status: LaneState["status"], overrides: Partial<LaneState> = {}): LaneState {
  return {
    id,
    agent: id,
    status,
    activity: "working",
    tail: "",
    tailKind: "text",
    thinking: "",
    tools: [],
    events: [],
    ...overrides,
  };
}

describe("agent lane presentation", () => {
  it("puts live work ahead of attention and completed history without reordering peers", () => {
    const lanes = [lane("detached", "detached"), lane("done-1", "completed"), lane("live-1", "running"), lane("done-2", "completed"), lane("attention", "attention"), lane("live-2", "running")];
    expect(orderAgentLanes(lanes).map((item) => item.id)).toEqual(["live-1", "live-2", "attention", "done-1", "done-2", "detached"]);
    expect(liveAgentCount(lanes)).toBe(2);
  });

  it("prefers the mutable live tail and falls back to durable thinking", () => {
    expect(laneLivePreview(lane("live", "running", { tail: "Writing the answer", thinking: "Earlier thought" }))).toEqual({ kind: "text", text: "Writing the answer" });
    expect(laneLivePreview(lane("thinking", "running", { thinking: "Checking the dependency graph" }))).toEqual({ kind: "thinking", text: "Checking the dependency graph" });
    expect(laneLivePreview(lane("quiet", "running"))).toBeUndefined();
  });
});

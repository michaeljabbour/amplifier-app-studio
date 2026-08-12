// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSessionState } from "../reducer";
import type { PipelineState } from "../protocol";
import { observedExecutionStages, sanitizeAndAnnotateSvg } from "./ExecutionMap";

function pipeline(): PipelineState {
  return {
    graphName: "Resolve",
    goal: "Ship safely",
    dotSource: "digraph { inspect -> verify }",
    declaredNodeCount: 2,
    declaredEdgeCount: 1,
    status: "running",
    nodes: {
      inspect: { id: "inspect", status: "completed", attempt: 1, executionIndex: 1 },
      verify: { id: "verify", status: "running", attempt: 1, executionIndex: 2 },
    },
    edges: {
      selected: { id: "selected", from: "inspect", to: "verify", selected: true },
    },
    totalNodesExecuted: 1,
    appliedEvents: {},
  };
}

describe("execution map", () => {
  it("sanitizes untrusted SVG and annotates live node and edge status", () => {
    const rendered = sanitizeAndAnnotateSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <a href="javascript:alert(1)"><text>bad</text></a>
        <g class="node"><title>inspect</title><polygon points="0,0 1,1" /></g>
        <g class="node"><title>verify</title><polygon points="0,0 1,1" /></g>
        <g class="edge"><title>inspect-&gt;verify</title><path d="M0 0" /></g>
      </svg>
    `, pipeline());

    expect(rendered).not.toContain("script");
    expect(rendered).not.toContain("onload");
    expect(rendered).not.toContain("javascript:");
    expect(rendered).toContain("pipeline-completed");
    expect(rendered).toContain("pipeline-running");
    expect(rendered).toContain("pipeline-selected");
    expect(rendered).toContain('role="img"');
  });

  it("labels generic stages only from observed session evidence", () => {
    const state = createSessionState("gui", { projectDir: "/tmp/project" });
    const empty = observedExecutionStages(state);
    expect(empty.map((stage) => stage.status)).toEqual(["pending", "not_observed", "not_observed", "not_observed", "not_observed"]);

    const observed = observedExecutionStages({
      ...state,
      busy: true,
      liveTail: { blockType: "text", text: "Almost done" },
      blocks: [
        { id: "u1", kind: "user", text: "Fix it" },
        { id: "t1", kind: "tool", toolName: "bash", toolCallId: "c1", status: "completed", summary: "npm test", detail: "" },
      ],
    });
    expect(observed.find((stage) => stage.id === "prompt")?.status).toBe("completed");
    expect(observed.find((stage) => stage.id === "verify")?.status).toBe("completed");
    expect(observed.find((stage) => stage.id === "respond")?.status).toBe("running");
  });
});

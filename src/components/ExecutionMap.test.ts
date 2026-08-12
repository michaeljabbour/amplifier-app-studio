// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSessionState } from "../reducer";
import type { PipelineState } from "../protocol";
import { renderTurnLoopSvg, sanitizeAndAnnotateSvg, sanitizeAndAnnotateTurnLoopSvg, turnLoopNodeStatuses } from "./ExecutionMap";

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

  it("keeps the Amplifier loop pending before a turn and highlights its live runtime phase", () => {
    const state = createSessionState("gui", { projectDir: "/tmp/project" });
    expect(turnLoopNodeStatuses(state.turnLoop)).toEqual({
      prompt: "pending",
      model: "pending",
      tools: "pending",
      delegates: "pending",
      response: "pending",
      complete: "pending",
    });

    expect(turnLoopNodeStatuses({
      ...state.turnLoop,
      phase: "tools",
      modelPasses: 1,
      toolCalls: 1,
    })).toMatchObject({ prompt: "completed", model: "completed", tools: "active" });
  });

  it("marks optional branches skipped when a tool-free turn completes", () => {
    const state = createSessionState("gui", { projectDir: "/tmp/project" });
    expect(turnLoopNodeStatuses({
      ...state.turnLoop,
      phase: "complete",
      modelPasses: 1,
      responseBlocks: 1,
    })).toEqual({
      prompt: "completed",
      model: "completed",
      tools: "skipped",
      delegates: "skipped",
      response: "completed",
      complete: "active",
    });
  });

  it("sanitizes and annotates the active loop node and edge", () => {
    const state = createSessionState("gui", { projectDir: "/tmp/project" });
    const rendered = sanitizeAndAnnotateTurnLoopSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <g class="node"><title>prompt</title><polygon points="0,0 1,1" /></g>
        <g class="node"><title>model</title><polygon points="0,0 1,1" /></g>
        <g class="node"><title>tools</title><polygon points="0,0 1,1" /></g>
        <g class="edge"><title>model-&gt;tools</title><path d="M0 0" /></g>
      </svg>
    `, { ...state.turnLoop, phase: "tools", modelPasses: 1, toolCalls: 1 });

    expect(rendered).not.toContain("script");
    expect(rendered).not.toContain("onload");
    expect(rendered).toContain("loop-completed");
    expect(rendered).toContain("loop-active");
    expect(rendered).toContain("loop-active-edge");
  });

  it("lays out the built-in Amplifier loop as an annotated SVG", async () => {
    const state = createSessionState("gui", { projectDir: "/tmp/project" });
    const rendered = await renderTurnLoopSvg({
      ...state.turnLoop,
      phase: "complete",
      modelPasses: 3,
      toolCalls: 4,
      toolResults: 4,
      delegates: 2,
      completedDelegates: 2,
    });
    expect(rendered).toContain("<svg");
    expect(rendered).toContain("loop-active");
    expect(rendered).toContain("Amplifier turn loop");
  });
});

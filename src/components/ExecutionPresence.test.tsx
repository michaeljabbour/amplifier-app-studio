// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { expect, it } from "vitest";
import { createSessionState } from "../reducer";
import { ExecutionMap, ExecutionPresence } from "./ExecutionMap";

it("keeps the selected pipeline and live step visible when topology is unavailable", () => {
  const initial = createSessionState("loop-review", { projectDir: "/tmp/qa" });
  initial.pipeline = {
    graphName: "Resolve", goal: "Verify the release", dotSource: "", status: "running",
    declaredNodeCount: 2, declaredEdgeCount: 1, totalNodesExecuted: 1, edges: {}, appliedEvents: {},
    nodes: {
      inspect: { id: "inspect", status: "completed", attempt: 1, executionIndex: 1 },
      verify: { id: "verify", status: "running", attempt: 1, executionIndex: 2 },
    },
  };
  const [state, setState] = createSignal(initial);
  const root = document.createElement("div");
  const dispose = render(() => <><ExecutionPresence state={state()} onOpen={() => {}} /><ExecutionMap state={state()} /></>, root);
  expect(root.textContent).toContain("Resolve");
  expect(root.textContent).toContain("Now: verify · 1/2 steps complete");
  expect(root.textContent).toContain("without its graph");
  expect(root.textContent).not.toContain("could not be rendered");
  setState({ ...state(), pipeline: { ...state().pipeline!, status: "completed", nodes: { ...state().pipeline!.nodes, verify: { ...state().pipeline!.nodes.verify, status: "completed" } } } });
  expect(root.textContent).toContain("completed · 2/2 steps complete");
  expect(root.textContent).not.toContain("Now: verify");
  dispose();
});

// @vitest-environment jsdom
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import { createSessionState, reduceRecord } from "../reducer";
import { DelegateRecovery } from "./DelegateRecovery";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.restoreAllMocks(); });

it("copies a parent-scoped instruction without executing recovery and hides it without capability", async () => {
  let state = createSessionState("gui", { projectDir: "/project" });
  state = { ...state, runtimeSessionId: "parent", runtimeCapabilities: { protocolVersion: 1, features: ["delegates.resume"], operations: {} } };
  state = reduceRecord(state, { type: "runtime.event", event: { kind: "agent_completed", session_id: "parent", parent_session_id: "parent", sub_session_id: "child", incomplete: true, success: false, result: "Partial findings retained" } });
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  dispose = render(() => <DelegateRecovery state={state} lane={state.lanes.child} />, document.body);
  expect(document.body.textContent).toContain("Partial findings retained");
  (document.querySelector("button") as HTMLButtonElement).click();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText.mock.calls[0][0]).toContain("child");
  expect(writeText.mock.calls[0][0]).toContain("parent session (parent)");
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Instruction copied");
  dispose();
  dispose = render(() => <DelegateRecovery state={{ ...state, runtimeCapabilities: undefined }} lane={state.lanes.child} />, document.body);
  expect(document.body.textContent).toContain("Partial findings retained");
  expect(document.querySelector("button")).toBeNull();
});

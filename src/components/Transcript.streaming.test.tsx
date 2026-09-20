// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionViewState } from "../protocol";
import { createSessionState, setThinkingExpanded } from "../reducer";
import { Transcript } from "./Transcript";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mount(blockType: string) {
  vi.useFakeTimers();
  const [state, setState] = createSignal<SessionViewState>({
    ...createSessionState("stream", { projectDir: "/tmp" }),
    phase: "ready", busy: true,
    liveTail: { blockType, text: "First" },
  });
  const root = document.createElement("div");
  document.body.append(root);
  const noop = () => {};
  disposers.push(render(() => <Transcript state={state()} onInterrupt={noop}
    onRetryRestore={noop} onOpenRestoreAnyway={noop} onThinkingExpanded={(id, expanded) => setState((state) => setThinkingExpanded(state, id, expanded))}
    onExport={noop} />, root));
  return { root, setState };
}

describe("streaming transcript identity", () => {
  it("preserves the reasoning disclosure and scroll container across deltas", () => {
    const { root, setState } = mount("thinking");
    const details = root.querySelector<HTMLDetailsElement>(".live-reasoning")!;
    const scroll = details.querySelector("div")!;
    details.open = false;
    scroll.scrollTop = 25;
    setState((state) => ({ ...state, liveTail: { blockType: "thinking", text: "First second" } }));
    expect(root.querySelector(".live-reasoning")).toBe(details);
    expect(details.open).toBe(false);
    expect(details.querySelector("div")).toBe(scroll);
    expect(scroll.scrollTop).toBe(25);
    vi.advanceTimersByTime(80);
    expect(details.textContent).toContain("First second");
  });

  it("preserves the live answer node so each delta does not restart its entrance animation", () => {
    const { root, setState } = mount("text");
    const answer = root.querySelector(".live-response");
    setState((state) => ({ ...state, liveTail: { blockType: "text", text: "First second" } }));
    expect(root.querySelector(".live-response")).toBe(answer);
    vi.advanceTimersByTime(80);
    expect(answer?.textContent).toContain("First second");
  });
  it("does not show sampled reasoning as the answer when the block type changes", () => {
    const { root, setState } = mount("thinking");
    setState((state) => ({ ...state, liveTail: { blockType: "text", text: "Final answer" } }));
    expect(root.querySelector(".live-response")?.textContent).toContain("Final answer");
    expect(root.querySelector(".live-response")?.textContent).not.toContain("First");
  });

  it("retains durable thinking controls when their content settles", () => {
    const { root, setState } = mount("thinking");
    setState((state) => ({ ...state, liveTail: undefined, blocks: [{ kind: "thinking", id: "thought", text: "", expanded: true }] }));
    const details = root.querySelector<HTMLDetailsElement>(".thinking-row details")!;
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    setState((state) => ({ ...state, blocks: state.blocks.map((block) => ({ ...block, text: "Completed reasoning" })) }));
    expect(root.querySelector(".thinking-row details")).toBe(details);
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Completed reasoning");
  });

  it("shows an actionable empty-response state without restarting the session", () => {
    const { root, setState } = mount("thinking");
    setState((state) => ({ ...state, liveTail: undefined, busy: false, responseIssue: "empty" }));
    const recovery = root.querySelector(".response-recovery");
    expect(recovery?.getAttribute("role")).toBe("alert");
    expect(recovery?.textContent).toContain("No final answer received");
    expect(recovery?.textContent).toContain("Export diagnostics");
  });

  it("flushes the last chunk and stops the caret when the stream ends", () => {
    const { root, setState } = mount("text");
    setState((state) => ({ ...state, liveTail: { blockType: "text", text: "First second", ended: true } }));
    expect(root.querySelector(".live-response")?.textContent).toContain("First second");
    expect(root.querySelector(".stream-caret")).toBeNull();
  });

});

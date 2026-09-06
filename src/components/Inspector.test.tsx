// @vitest-environment jsdom

import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneState, SessionViewState } from "../protocol";
import { createSessionState } from "../reducer";
import { Inspector, type InspectorTab } from "./Inspector";

const disposers: Array<() => void> = [];
const originalWidth = window.innerWidth;
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
});

function mount(initialTab: InspectorTab = "run", width = 1280) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const lane: LaneState = {
    id: "reviewer", agent: "Source reviewer", status: "running", activity: "Checking **complete** source coverage",
    tail: "", tailKind: "text", thinking: "", tools: [], events: [], instruction: "Check every source boundary",
  };
  const [state, setState] = createSignal<SessionViewState>({
    ...createSessionState("inspector-fixture", { projectDir: "/project", hostId: "local" }),
    runtimeSessionId: "runtime-fixture", phase: "ready", busy: true, activity: "Fixture coordinator activity",
    model: "fixture-model", bundle: "fixture-bundle", effort: "medium", effortLevels: ["low", "medium", "high"],
    lanes: { reviewer: lane },
    plans: { coordinator: { ownerId: "runtime-fixture", ownerKind: "coordinator", toolCallId: "plan-call",
      updateStatus: "applied", items: [{ content: "Verify fixture source boundary", status: "in_progress" }] } },
    outputs: [{ id: "output-fixture", kind: "file", title: "Review notes", path: "review-notes.md", source: "write_file" }],
  });
  const [tab, setTab] = createSignal<InspectorTab>(initialTab);
  const [selectedLane, setSelectedLane] = createSignal<LaneState>();
  const [open, setOpen] = createSignal(true);
  const [loading, setLoading] = createSignal(false);
  const [catalogError, setCatalogError] = createSignal<string>();
  const refresh = vi.fn(async () => undefined);
  const close = vi.fn(() => setOpen(false));
  const effort = vi.fn();
  const output = vi.fn(async () => undefined);
  const context = vi.fn();
  const root = document.createElement("div");
  document.body.appendChild(root);
  disposers.push(render(() => (
    <Show when={open()}>
      <Inspector
        state={state()} lane={selectedLane()} tab={tab()} transport="Fixture transport"
        bundles={[{ name: "review-bundle", location: "/bundle.md", active: true, status: "available" }]}
        providers={[]} catalogError={catalogError()} catalogLoading={loading()}
        onTab={setTab} onSelectLane={(id) => { setSelectedLane(state().lanes[id]); setTab("agent"); }}
        onDismissAlert={() => undefined} onCycleEffort={() => undefined} onSetEffort={effort}
        onStartSibling={() => undefined} onAddBundle={async () => undefined} onRefreshBundles={refresh}
        onCapabilities={() => undefined} onStartCapability={() => undefined} onRequestContext={context}
        onOpenOutput={output} onClose={close}
      />
    </Show>
  ), root));
  return { root, tab, setTab, state, setState, setLoading, setCatalogError, refresh, close, effort, output, context };
}

function button(root: ParentNode, selector: string): HTMLButtonElement {
  const element = root.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing button: ${selector}`);
  return element;
}

function primary(root: ParentNode, name: string): HTMLButtonElement {
  const result = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((element) => element.querySelector("span")?.textContent === name);
  if (!result) throw new Error(`Missing primary tab: ${name}`);
  return result;
}

function subsection(root: ParentNode, name: string): HTMLButtonElement {
  const result = [...root.querySelectorAll<HTMLButtonElement>(".inspector-subnav button")]
    .find((element) => element.textContent?.trim().startsWith(name));
  if (!result) throw new Error(`Missing subsection: ${name}`);
  return result;
}

async function click(element: HTMLButtonElement) {
  element.click();
  await Promise.resolve();
}

function assertSelection(root: ParentNode, name: string) {
  const selected = primary(root, name);
  expect(selected.getAttribute("aria-selected")).toBe("true");
  expect(selected.tabIndex).toBe(0);
  expect(root.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(1);
  expect(root.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
  const panel = root.querySelector('[role="tabpanel"]');
  expect(panel?.getAttribute("id")).toBe(selected.getAttribute("aria-controls"));
  expect(panel?.getAttribute("aria-labelledby")).toBe(selected.id);
  expect(root.querySelector("button button")).toBeNull();
}

describe("session inspector navigation and controls", () => {
  it("keeps Agents and Plan buttons mounted while runtime events stream", async () => {
    const ui = mount();
    const agents = subsection(ui.root, "Agents");
    const plan = subsection(ui.root, "Plan");
    agents.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    ui.setState((state) => ({ ...state, activity: "Another live event" }));
    expect(subsection(ui.root, "Agents")).toBe(agents);
    expect(subsection(ui.root, "Plan")).toBe(plan);
    await click(agents);
    expect(ui.tab()).toBe("agents");
    ui.setState((state) => ({ ...state, activity: "Still streaming" }));
    await click(plan);
    expect(ui.tab()).toBe("plan");
  });

  it("does not report an earlier final response as completion of a running turn", () => {
    const ui = mount();
    ui.setState((state) => ({ ...state, blocks: [{ id: "old-answer", kind: "answer", text: "Earlier turn", final: true }] }));
    const final = [...ui.root.querySelectorAll(".progress-row")].find((row) => row.textContent?.includes("Final response"));
    expect(final?.classList.contains("done")).toBe(false);
    expect(final?.textContent).toContain("Waiting on the run");
  });
  it("makes every section and selected agent reachable through five primary views", async () => {
    const ui = mount();
    expect(ui.root.querySelectorAll('[role="tab"]')).toHaveLength(5);
    assertSelection(ui.root, "Activity");
    expect(ui.root.textContent).toContain("Fixture coordinator activity");

    await click(subsection(ui.root, "Agents"));
    assertSelection(ui.root, "Activity");
    await click(button(ui.root, ".inspector-agent-list button"));
    expect(ui.tab()).toBe("agent");
    expect(ui.root.textContent).toContain("Check every source boundary");
    expect(subsection(ui.root, "Selected agent").getAttribute("aria-pressed")).toBe("true");
    assertSelection(ui.root, "Activity");

    await click(subsection(ui.root, "Plan"));
    expect(ui.root.querySelector('[aria-label="Session plan"]')?.textContent).toContain("Verify fixture source boundary");
    assertSelection(ui.root, "Activity");
    await click(primary(ui.root, "Loop"));
    expect(ui.root.querySelector('[aria-label="Amplifier model and tool execution loop"]')).not.toBeNull();
    assertSelection(ui.root, "Loop");
    await click(primary(ui.root, "Activity"));
    expect(ui.root.textContent).toContain("Fixture coordinator activity");

    await click(primary(ui.root, "Setup"));
    expect(ui.root.querySelector('[aria-label="Session effort"]')).not.toBeNull();
    assertSelection(ui.root, "Setup");
    await click(subsection(ui.root, "Bundles"));
    expect(ui.root.querySelector('[aria-label="Filter available bundles"]')).not.toBeNull();
    expect(ui.root.textContent).toContain("review-bundle");
    assertSelection(ui.root, "Setup");
    await click(subsection(ui.root, "Configuration"));
    expect(ui.root.textContent).toContain("fixture-model");

    await click(primary(ui.root, "Outputs"));
    expect(ui.root.textContent).toContain("review-notes.md");
    assertSelection(ui.root, "Outputs");
    await click(button(ui.root, ".output-open-button"));
    expect(ui.output).toHaveBeenCalledOnce();
    expect(ui.output).toHaveBeenCalledWith(ui.state().outputs[0]);

    await click(primary(ui.root, "Context"));
    expect(ui.root.textContent).toContain("runtime-fixture");
    assertSelection(ui.root, "Context");
    await click(button(ui.root, ".inspector-refresh"));
    expect(ui.context).toHaveBeenCalledOnce();
  });


  it("keeps late output failures and pending state with their owning session", async () => {
    const ui = mount("outputs");
    let fail!: (error: Error) => void;
    ui.output.mockImplementationOnce(() => new Promise<undefined>((_, reject) => { fail = reject; }));
    await click(button(ui.root, ".output-open-button"));
    expect(button(ui.root, ".output-open-button").disabled).toBe(true);
    ui.setState((state) => ({ ...state, guiId: "another-session" }));
    await Promise.resolve();
    expect(button(ui.root, ".output-open-button").disabled).toBe(false);
    fail(new Error("The previous computer disconnected"));
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.root.querySelector('[role="alert"]')).toBeNull();
    expect(ui.root.textContent).not.toContain("previous computer disconnected");
  });
  it("supports roving arrow, Home, and End navigation with focus and panel ownership", async () => {
    const ui = mount("plan");
    assertSelection(ui.root, "Activity");
    primary(ui.root, "Activity").focus();
    for (const [key, expected] of [["ArrowRight", "Outputs"], ["ArrowRight", "Setup"], ["End", "Context"],
      ["ArrowRight", "Loop"], ["ArrowLeft", "Context"], ["Home", "Loop"]]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(event);
      await Promise.resolve();
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(primary(ui.root, expected));
      assertSelection(ui.root, expected);
    }
    const unrelated = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.activeElement?.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
    assertSelection(ui.root, "Loop");
  });

  it("keeps subsection selection while recorded run status updates", async () => {
    const ui = mount("agents");
    expect(subsection(ui.root, "Agents").getAttribute("aria-pressed")).toBe("true");
    ui.setState((state) => ({ ...state, busy: false, lanes: { reviewer: { ...state.lanes.reviewer, status: "completed", activity: "Source review complete" } } }));
    await Promise.resolve();
    assertSelection(ui.root, "Activity");
    expect(subsection(ui.root, "Agents").getAttribute("aria-pressed")).toBe("true");
    expect(ui.root.querySelector(".mini-state")?.textContent).toBe("completed");
    expect(ui.root.textContent).toContain("Source review complete");
    await click(primary(ui.root, "Setup"));
    await click(subsection(ui.root, "Bundles"));
    ui.setCatalogError("Fixture host catalog unavailable");
    await Promise.resolve();
    assertSelection(ui.root, "Setup");
    expect(subsection(ui.root, "Bundles").getAttribute("aria-pressed")).toBe("true");
    expect(ui.root.querySelector('[role="status"]')?.textContent).toContain("Fixture host catalog unavailable");
  });

  it("retries once per activation and disables retry while a request is running", async () => {
    const ui = mount("build");
    ui.setCatalogError("Fixture host could not load the catalog");
    await Promise.resolve();
    await click(button(ui.root, '[aria-label="Retry catalog discovery"]'));
    expect(ui.refresh).toHaveBeenCalledOnce();
    ui.setLoading(true);
    await Promise.resolve();
    const retry = button(ui.root, '[aria-label="Retry catalog discovery"]');
    expect(retry.disabled).toBe(true);
    await click(retry);
    expect(ui.refresh).toHaveBeenCalledOnce();
    expect(ui.root.textContent).toContain("fixture-model");
  });

  it("offers runtime effort levels and waits for confirmation before another change", async () => {
    const ui = mount("build");
    const select = ui.root.querySelector<HTMLSelectElement>('[aria-label="Session effort"]')!;
    expect([...select.options].map((option) => option.value)).toEqual(["low", "medium", "high"]);
    select.value = "high";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(ui.effort).toHaveBeenCalledExactlyOnceWith("high");
    ui.setState((state) => ({ ...state, effortPending: "high" }));
    await Promise.resolve();
    expect(select.disabled).toBe(true);
    ui.setState((state) => ({ ...state, effortPending: undefined, effort: "high" }));
    await Promise.resolve();
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("high");
  });

  it.each([390, 1280])("closes the inspector at viewport width %i", async (width) => {
    const ui = mount("context", width);
    await Promise.resolve();
    if (width <= 760) expect(document.activeElement).toBe(button(ui.root, '[aria-label="Back to session"]'));
    await click(button(ui.root, '[aria-label="Close Work"]'));
    expect(ui.close).toHaveBeenCalledOnce();
    expect(ui.root.querySelector('[aria-label="Session inspector"]')).toBeNull();
  });
});

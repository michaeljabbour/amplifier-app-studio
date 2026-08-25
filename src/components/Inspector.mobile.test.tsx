// @vitest-environment jsdom

import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import type { LaneState } from "../protocol";
import { createSessionState } from "../reducer";
import { Inspector, type InspectorTab } from "./Inspector";

const lane: LaneState = {
  id: "explorer",
  agent: "Explorer",
  status: "running",
  activity: "Reviewing the mobile flow",
  tail: "",
  tailKind: "text",
  thinking: "",
  tools: [],
  events: [],
};

const state = {
  ...createSessionState("mobile-work", { projectDir: "/home/mjabbour/dev/studio" }),
  title: "Mobile usability",
  phase: "ready" as const,
  lanes: { explorer: lane },
};

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  document.body.replaceChildren();
});

function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) throw new Error("Expected an interactive element");
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function mountInspector(): HTMLElement {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const [open, setOpen] = createSignal(true);
  const [tab, setTab] = createSignal<InspectorTab>("run");
  const [selectedLane, setSelectedLane] = createSignal<LaneState>();
  disposers.push(render(() => (
    <Show when={open()}>
      <Inspector
        state={state}
        lane={selectedLane()}
        tab={tab()}
        transport="Remote compute"
        bundles={[]}
        providers={[]}
        onTab={setTab}
        onSelectLane={(id) => {
          setSelectedLane(id === lane.id ? lane : undefined);
          setTab("agent");
        }}
        onDismissAlert={() => undefined}
        onCycleEffort={() => undefined}
        onStartSibling={() => undefined}
        onAddBundle={async () => undefined}
        onRefreshBundles={async () => undefined}
        onCapabilities={() => undefined}
        onStartCapability={() => undefined}
        onRequestContext={() => undefined}
        onClose={() => setOpen(false)}
      />
    </Show>
  ), root));
  return root;
}

describe("mobile Work navigation", () => {
  it("keeps every primary view reachable and exposes agents directly", async () => {
    const root = mountInspector();
    await Promise.resolve();

    const labels = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.textContent?.trim());
    expect(labels).toEqual(["Run", "Agents", "Loop", "Plan", "Setup", "Bundles", "Outputs", "Context"]);

    click([...root.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Agents") || null);
    await Promise.resolve();
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Agents");
    expect(root.textContent).toContain("Explorer");

    click([...root.querySelectorAll(".inspector-agent-list button")][0]);
    await Promise.resolve();
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Agent detail");
    expect(root.textContent).toContain("Reviewing the mobile flow");

    click([...root.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Setup") || null);
    await Promise.resolve();
    expect(root.textContent).toContain("Active composition");
  });

  it("returns to the conversation from both mobile close controls", async () => {
    const backRoot = mountInspector();
    await Promise.resolve();
    click(backRoot.querySelector('[aria-label="Back to session"]'));
    await Promise.resolve();
    expect(backRoot.querySelector(".machine-inspector")).toBeNull();

    disposers.pop()?.();
    backRoot.remove();

    const closeRoot = mountInspector();
    await Promise.resolve();
    click(closeRoot.querySelector('[aria-label="Close Work"]'));
    await Promise.resolve();
    expect(closeRoot.querySelector(".machine-inspector")).toBeNull();
  });
});

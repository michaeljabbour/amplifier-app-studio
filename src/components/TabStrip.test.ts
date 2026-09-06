// @vitest-environment jsdom

import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appUpdateButtonTitle } from "../appUpdateCopy";
import { createSessionState } from "../reducer";
import { TabStrip } from "./TabStrip";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  document.body.replaceChildren();
});

function mountStrip() {
  const sessions = ["first", "second"].map((id) => ({
    ...createSessionState(id, { projectDir: `/project/${id}`, hostId: "local" }),
    title: `${id} session`, phase: "ready" as const,
  }));
  const [active, setActive] = createSignal("first");
  const select = vi.fn((id: string) => setActive(id));
  const close = vi.fn();
  const inspector = vi.fn();
  const terminal = vi.fn();
  const root = document.createElement("div");
  document.body.appendChild(root);
  disposers.push(render(() => createComponent(TabStrip, {
    sessions,
    get activeId() { return active(); },
    onSelect: select, onClose: close, onNew: vi.fn(), onDrawer: vi.fn(), onSettings: vi.fn(),
    inspectorOpen: false, inspectorAvailable: true, onToggleInspector: inspector,
    terminalAvailable: true, terminalOpen: false, onToggleTerminal: terminal,
    update: { status: "current" }, updateBlocked: false, onUpdate: vi.fn(),
  }), root));
  return { root, active, select, close, inspector, terminal };
}

describe("compact session strip", () => {
  it("provides one desktop inspector control and terminal control without duplicate section navigation", () => {
    const ui = mountStrip();
    const actions = ui.root.querySelector(".top-workbench-actions")!;
    expect(actions.querySelectorAll("button")).toHaveLength(2);
    const inspect = actions.querySelector<HTMLButtonElement>('[aria-label="Show session inspector"]')!;
    const terminal = actions.querySelector<HTMLButtonElement>('[aria-label="Open terminal sessions"]')!;
    expect(inspect).not.toBeNull();
    expect(terminal).not.toBeNull();
    inspect.click();
    terminal.click();
    expect(ui.inspector).toHaveBeenCalledOnce();
    expect(ui.terminal).toHaveBeenCalledOnce();
    expect(ui.root.querySelector("button button")).toBeNull();
  });

  it("keeps close actions separate from session selection", () => {
    const ui = mountStrip();
    const shell = ui.root.querySelector(".session-tab-shell")!;
    const tab = shell.querySelector<HTMLButtonElement>('[role="tab"]')!;
    const close = shell.querySelector<HTMLButtonElement>(".tab-close")!;
    expect(tab.contains(close)).toBe(false);
    expect(close.getAttribute("aria-label")).toContain("first session");
    close.click();
    expect(ui.close).toHaveBeenCalledExactlyOnceWith("first");
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("moves session focus with arrows and Home/End while maintaining one tab stop", async () => {
    const ui = mountStrip();
    const tabs = [...ui.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0].focus();
    for (const [key, index] of [["ArrowRight", 1], ["ArrowRight", 0], ["End", 1], ["Home", 0]] as const) {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await Promise.resolve();
      expect(document.activeElement).toBe(tabs[index]);
      expect(tabs[index].getAttribute("aria-selected")).toBe("true");
      expect(tabs[index].tabIndex).toBe(0);
      expect(ui.root.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
      expect(ui.active()).toBe(index === 0 ? "first" : "second");
    }
  });
});

describe("Studio updater status copy", () => {
  it("shows the actual install failure before release notes", () => {
    expect(appUpdateButtonTitle({
      status: "error",
      notes: "Feature notes",
      message: "Signature verification failed",
    }, false)).toBe("Signature verification failed");
  });

  it("keeps the active-turn blocker authoritative", () => {
    expect(appUpdateButtonTitle({ status: "available", notes: "Feature notes" }, true))
      .toContain("Finish or interrupt active turns");
  });
});

// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionViewState } from "../protocol";
import { ModeControl } from "./ModeControl";
import { createSessionState, reduceRecord } from "../reducer";
const disposeAll: Array<() => void> = [];
afterEach(() => { disposeAll.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); });
function mount(maxActive = 1, supported = true) {
  const [state, setState] = createSignal<SessionViewState>({ ...createSessionState("modes", { projectDir: "/tmp" }), runtimeCapabilities: { protocolVersion: 1, features: [], operations: supported ? { "modes.get": "read", "modes.set": "write" } : {} }, nativeModes: { modes: [{ name: "review", description: "Review only", source: "mj", advertised: false }, { name: "plan", description: "Plan the work", source: "modes", advertised: true }], active: ["review"], maxActive } });
  const root = document.createElement("div"); document.body.append(root);
  const onSet = vi.fn();
  disposeAll.push(render(() => <ModeControl state={state()} onSet={onSet} />, root));
  root.querySelector<HTMLButtonElement>("button")!.click();
  return { root, state, setState, onSet };
}
it("shows human-only modes, applies one selection, and waits for confirmed active state", () => {
  const ui = mount();
  expect(ui.root.textContent).toContain("human-only");
  const inputs = ui.root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  inputs[1].click();
  [...ui.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Apply modes")!.click();
  expect(ui.onSet).toHaveBeenCalledWith(["plan"]);
  expect(ui.state().nativeModes!.active).toEqual(["review"]);
  const confirmed = reduceRecord(ui.state(), { type: "modes.state", modes: ui.state().nativeModes!.modes, active: ["plan"], max_active: 1, ok: true });
  expect(confirmed.nativeModes?.active).toEqual(["plan"]);
});
it("supports multiple selection only when the host advertises it", () => {
  const ui = mount(2);
  ui.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click();
  [...ui.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Apply modes")!.click();
  expect(ui.onSet).toHaveBeenCalledWith(["review", "plan"]);
});
it("does not offer unsupported operations on older runtimes", () => {
  const ui = mount(1, false);
  expect(ui.root.textContent).toContain("runtime update is needed");
  expect(ui.root.querySelector("input")).toBeNull();
  expect(ui.onSet).not.toHaveBeenCalled();
});

it("blocks combinations containing an individual-only mode", () => {
  const ui = mount(8);
  ui.setState((state) => ({ ...state, nativeModes: { ...state.nativeModes!, modes: state.nativeModes!.modes.map((mode) => ({ ...mode, combinable: mode.name !== "plan" })) } }));
  ui.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click();
  expect(ui.root.textContent).toContain("must run on their own");
  const apply = [...ui.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Apply modes")!;
  expect(apply.disabled).toBe(true);
});

it("keeps Apply mounted through WebKit null blur, but dismisses outside interaction", () => {
  const ui = mount(2);
  ui.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click();
  const search = ui.root.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.focus();
  search.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  const apply = [...ui.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Apply modes")!;
  expect(apply).toBeDefined();
  apply.click();
  expect(ui.onSet).toHaveBeenCalledWith(["review", "plan"]);
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(ui.root.querySelector('[role="dialog"]')).toBeNull();
});

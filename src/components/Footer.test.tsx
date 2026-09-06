// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import type { SessionViewState } from "../protocol";
import { Footer } from "./Footer";
import { createSessionState, reduceRecord } from "../reducer";
it("shows available models and routes selection to explicit new-session setup", () => {
  const root = document.createElement("div"); document.body.append(root);
  const onSelectModel = vi.fn(); const noop = () => undefined;
  const provider = { name: "sample", module: "sample", model: "another-model", active: false, toolCompatible: true };
  const state = { ...createSessionState("model", { projectDir: "/tmp" }), model: "current-model" };
  const dispose = render(() => <Footer state={state} providers={[provider]} onSelectModel={onSelectModel} onCycleEffort={noop} onSetEffort={noop} onContext={noop} onBuild={noop} onOutputs={noop} onToggleWorkspace={noop} />, root);
  root.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')!.click();
  expect(root.textContent).toContain("new session in this directory");
  root.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click();
  expect(onSelectModel).toHaveBeenCalledWith(provider);
  expect(state.model).toBe("current-model");
  dispose(); root.remove();
});

it("offers live model changes and reflects only runtime confirmation", () => {
  const root = document.createElement("div"); document.body.append(root);
  const [state, setState] = createSignal<SessionViewState>({ ...createSessionState("model", { projectDir: "/tmp" }), model: "sample/current", runtimeCapabilities: { protocolVersion: 1, features: [], operations: { "model.set": "write" } } });
  const noop = () => undefined; const select = vi.fn();
  const provider = { name: "sample", module: "sample", model: "next", active: true, toolCompatible: true };
  const dispose = render(() => <Footer state={state()} providers={[provider]} onSelectModel={select} onCycleEffort={noop} onSetEffort={noop} onContext={noop} onBuild={noop} onOutputs={noop} onToggleWorkspace={noop} />, root);
  root.querySelector<HTMLButtonElement>('[aria-label="Choose model"]')!.click();
  expect(root.textContent).toContain("next turn in this session");
  root.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click();
  expect(select).toHaveBeenCalledWith(provider);
  expect(state().model).toBe("sample/current");
  setState((previous) => ({ ...previous, ...reduceRecord(previous, { type: "model.state", ok: true, model: "sample/next" }) }));
  expect(root.querySelector('[aria-label="Choose model"]')!.textContent).toContain("sample/next");
  setState((previous) => ({ ...previous, ...reduceRecord(previous, { type: "model.state", ok: false, model: "wrong", detail: "Unavailable" }) }));
  expect(state().model).toBe("sample/next");
  expect(root.textContent).toContain("Unavailable");
  dispose(); root.remove();
});

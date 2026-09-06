// @vitest-environment jsdom
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import { EffortControl } from "./EffortControl";
import { createSessionState } from "../reducer";
it("opens all supported effort choices on a normal click without cycling", () => {
  const root = document.createElement("div"); document.body.append(root);
  const onSet = vi.fn(), onCycle = vi.fn();
  const state = { ...createSessionState("effort", { projectDir: "/tmp" }), effort: "low", effortLevels: ["low", "high", "xhigh"] };
  const dispose = render(() => <EffortControl state={state} onSet={onSet} onCycle={onCycle} />, root);
  root.querySelector<HTMLButtonElement>("button")!.click();
  const choices = [...root.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
  expect(choices.map((choice) => choice.textContent?.trim())).toEqual(["low ✓", "high", "xhigh"]);
  expect(onCycle).not.toHaveBeenCalled();
  choices[2].click(); expect(onSet).toHaveBeenCalledWith("xhigh");
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  dispose(); root.remove();
});

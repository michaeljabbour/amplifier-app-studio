// @vitest-environment jsdom
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import type { TerminalCoordinatorContract, TerminalSession } from "../terminal";
import { TerminalWorkSurface } from "./TerminalWorkSurface";
vi.mock("./TerminalEmulator", () => ({ TerminalEmulator: () => <div /> }));
it("creates in the chosen directory with an automatic name and no required typing", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const existing = { id: "existing", name: "chosen", cwd: "/dev/chosen", host: { id: "local", label: "This computer" }, connection: { status: "detached" }, attention: { needsAttention: false } } as TerminalSession;
  const create = vi.fn(async () => ({ ...existing, id: "new" }));
  const attach = vi.fn(async () => undefined);
  const coordinator = { snapshot: () => ({ sessions: [existing], refreshing: false }), subscribe: () => () => undefined, create, attach } as unknown as TerminalCoordinatorContract;
  const dispose = render(() => <TerminalWorkSurface coordinator={coordinator} project={{ id: "original", root: "/dev/original", label: "original" }} onPickProjectDir={async () => "/dev/chosen"} />, root);
  root.querySelector<HTMLButtonElement>('[aria-label="New terminal"]')!.click();
  const choose = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Choose directory…")!;
  choose.click();
  await vi.waitFor(() => expect(root.textContent).toContain("Terminal name: chosen-2"));
  root.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ name: "chosen-2", project: { id: "/dev/chosen", root: "/dev/chosen", label: "chosen" } }));
  expect(attach).toHaveBeenCalledWith("new");
  dispose(); root.remove();
});

// @vitest-environment jsdom
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import { NewSessionDialog } from "./NewSessionDialog";

it("launches the edited smart-tool request on the selected host and directory", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const start = vi.fn(async () => {});
  const dispose = render(() => <NewSessionDialog initial={{ projectDir: "/work/project", hostId: "remote", capabilityId: "tmux-fleet" }} initialPrompt="Inspect the fleet" catalog={{ bundles: [], providers: [] }} hosts={[{ id: "remote", name: "Test host", url: "https://host.example", tokenRef: "test" }]} nativeProjectPicker={false} onCancel={() => {}} onPickProjectDir={async () => undefined} canCloneRepository={() => false} onCloneRepository={vi.fn()} onHostChange={async () => undefined} onStart={start} />, root);
  const input = root.querySelector<HTMLTextAreaElement>(".smart-tool-request textarea")!;
  input.value = "Run tmux-fleet doctor only"; input.dispatchEvent(new Event("input", { bubbles: true }));
  root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectDir: "/work/project", hostId: "remote", hostUrl: "https://host.example", capabilityId: "tmux-fleet" }), "Run tmux-fleet doctor only"));
  dispose(); root.remove();
});

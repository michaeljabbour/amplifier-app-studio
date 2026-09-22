// @vitest-environment jsdom
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import { capabilitySessionInput, STUDIO_CAPABILITIES } from "../capabilities";
import { NewSessionDialog } from "./NewSessionDialog";

it("launches Fast Decisions on the selected compute host with its main model intact", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const start = vi.fn(async () => {});
  const capability = STUDIO_CAPABILITIES.find((item) => item.id === "fast-decisions")!;
  const initial = { ...capabilitySessionInput(capability, "/work/project", { model: "qwen-main", provider: "vllm-local" }), hostId: "spark" };
  const dispose = render(() => <NewSessionDialog
    initial={initial} catalog={{ bundles: [], providers: [] }}
    hosts={[{ id: "spark", name: "Spark", url: "https://spark.example", tokenRef: "test" }]}
    nativeProjectPicker={false} onCancel={() => {}} onPickProjectDir={async () => undefined}
    canCloneRepository={() => false} onCloneRepository={vi.fn()}
    onHostChange={async () => undefined} onStart={start}
  />, root);
  try {
    const setup = root.querySelector('[aria-label="Fast Decisions setup"]')!;
    expect(setup.textContent).toContain("Local judge on Spark");
    expect(setup.textContent).toContain("ollama pull qwen3:0.6b");
    expect(setup.textContent).toContain("fall back to the main model");
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: "/work/project", hostId: "spark", hostUrl: "https://spark.example",
      bundle: capability.bundle, model: "qwen-main", provider: "vllm-local", capabilityId: "fast-decisions",
    }), undefined));
  } finally {
    dispose();
    root.remove();
  }
});

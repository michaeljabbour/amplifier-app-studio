// @vitest-environment jsdom

import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceInputButton } from "./VoiceInputButton";

const capture = vi.hoisted(() => ({
  abort: vi.fn(),
  stop: vi.fn(async () => ({ mediaType: "audio/mp4", data: "recording" })),
}));

vi.mock("../transcription", async (load) => {
  const actual = await load<typeof import("../transcription")>();
  return {
    ...actual,
    audioCaptureAvailable: () => true,
    startAudioCapture: async () => capture,
  };
});

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  capture.abort.mockClear();
  capture.stop.mockClear();
});

describe("mobile voice draft flow", () => {
  it("keeps recording visible and returns speech to the editable draft before send", async () => {
    const onDraft = vi.fn();
    const onActiveChange = vi.fn();
    const root = document.createElement("div");
    document.body.appendChild(root);
    dispose = render(() => (
      <VoiceInputButton
        draft="Existing"
        available
        onDraft={onDraft}
        onTranscribe={async () => "spoken words"}
        onActiveChange={onActiveChange}
      />
    ), root);

    const button = root.querySelector("button");
    if (!button) throw new Error("Voice button did not render");
    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(root.textContent).toContain("Listening");
    expect(onActiveChange).toHaveBeenCalledWith(true, "listening");

    button.click();
    await vi.waitFor(() => {
      expect(capture.stop).toHaveBeenCalledOnce();
      expect(onDraft).toHaveBeenCalledWith("Existing spoken words");
    });
    expect(onActiveChange).toHaveBeenCalledWith(true, "transcribing");
    expect(onActiveChange).toHaveBeenLastCalledWith(false, "idle");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });
});

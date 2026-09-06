// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { appendTranscript, audioCaptureAvailable } from "./transcription";
import { promiseWithTimeout } from "./components/VoiceInputButton";

describe("speech-to-text", () => {
  it("appends speech to an editable draft without submitting it", () => {
    expect(appendTranscript("", "  Build the release  ")).toBe("Build the release");
    expect(appendTranscript("Review this", "repository carefully")).toBe("Review this repository carefully");
    expect(appendTranscript("Keep this newline\n", "and continue")).toBe("Keep this newline and continue");
  });

  it("reports unsupported environments honestly", () => {
    expect(audioCaptureAvailable(undefined)).toBe(false);
    expect(audioCaptureAvailable({} as Window & typeof globalThis)).toBe(false);
  });

  it("bounds a stalled transcription request instead of hanging forever", async () => {
    await expect(promiseWithTimeout(new Promise(() => undefined), 1, "timed out"))
      .rejects.toThrow("timed out");
  });
});

it("waits for recorder readiness and retains every audio chunk including the final one", async () => {
  const { startAudioCapture } = await import("./transcription");
  const { Blob: NodeBlob } = await import("node:buffer");
  const { vi } = await import("vitest");
  const stopTrack = vi.fn();
  let recorder: FakeRecorder;
  class FakeRecorder {
    static isTypeSupported(type: string) { return type === "audio/mp4"; }
    mimeType = "audio/mp4"; state = "inactive";
    onstart?: () => void; onstop?: () => void; ondataavailable?: (event: { data: Blob }) => void;
    constructor() { recorder = this; }
    start(timeslice: number) { expect(timeslice).toBe(250); this.state = "recording"; }
    stop() { this.ondataavailable?.({ data: new Blob(["last"]) }); this.state = "inactive"; this.onstop?.(); }
  }
  vi.stubGlobal("Blob", NodeBlob);
  try {
    let ready = false;
    const scope = { navigator: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [{ stop: stopTrack }] }) } }, MediaRecorder: FakeRecorder } as unknown as Window & typeof globalThis;
    const starting = startAudioCapture(scope).then((value) => { ready = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(ready).toBe(false);
    recorder!.onstart!();
    const capture = await starting;
    recorder!.ondataavailable!({ data: new Blob(["first"]) });
    const audio = await capture.stop();
    expect(atob(audio.data)).toBe("firstlast");
    expect(stopTrack).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

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

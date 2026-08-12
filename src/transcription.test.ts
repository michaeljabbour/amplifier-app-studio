import { describe, expect, it } from "vitest";
import { appendDictation, audioCaptureAvailable } from "./transcription";

describe("system dictation", () => {
  it("appends speech to an editable draft without submitting it", () => {
    expect(appendDictation("", "  Build the release  ")).toBe("Build the release");
    expect(appendDictation("Review this", "repository carefully")).toBe("Review this repository carefully");
    expect(appendDictation("Keep this newline\n", "and continue")).toBe("Keep this newline and continue");
  });

  it("reports unsupported environments honestly", () => {
    expect(audioCaptureAvailable(undefined)).toBe(false);
    expect(audioCaptureAvailable({} as Window & typeof globalThis)).toBe(false);
  });
});

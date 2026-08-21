// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { microphoneFailureMessage } from "./components/VoiceInputButton";

describe("microphone failure reporting", () => {
  // Regression: a denied microphone surfaced as "Microphone recording could not start", which
  // gave no hint that the fix is one checkbox in System Settings.
  it("names the System Settings remedy when access is denied", () => {
    const message = microphoneFailureMessage(new DOMException("denied", "NotAllowedError"));
    expect(message).toContain("System Settings");
    expect(message).toContain("Microphone");
  });

  it("treats a WebKit SecurityError as a denial too", () => {
    expect(microphoneFailureMessage(new DOMException("blocked", "SecurityError")))
      .toContain("System Settings");
  });

  it("distinguishes no-device from denied", () => {
    expect(microphoneFailureMessage(new DOMException("none", "NotFoundError")))
      .toContain("No microphone was found");
  });

  it("keeps the error name for anything unrecognised, instead of flattening it", () => {
    const message = microphoneFailureMessage(new DOMException("boom", "AbortError"));
    expect(message).toContain("AbortError");
    expect(message).toContain("boom");
  });

  it("still produces something for a non-Error rejection", () => {
    expect(microphoneFailureMessage("nope")).toBe("nope");
    expect(microphoneFailureMessage(undefined)).toContain("could not start");
  });
});

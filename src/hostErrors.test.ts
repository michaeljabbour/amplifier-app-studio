import { describe, expect, it } from "vitest";
import { hostRequestFailureMessage } from "./transport";

describe("host request failure reporting", () => {
  // Regression: every rejected fetch produced "Could not reach Amplifier Host at X. Check the
  // SSH/Tailscale connection and make sure the host allows the native Studio origin." That
  // asserts a cause the client cannot know. Reproduced against a real Spark host that was
  // listening, CORS-correct for tauri://localhost, and answering curl while Studio displayed it.
  it("does not assert a cause it cannot know", () => {
    const message = hostRequestFailureMessage("http://127.0.0.1:4318", new TypeError("Load failed"));
    expect(message).toContain("http://127.0.0.1:4318");
    expect(message).toContain("No response");
    // It must not claim the host is unreachable, nor blame one specific link in the chain.
    expect(message).not.toMatch(/Could not reach/i);
    expect(message).toMatch(/check that/i);
  });

  it("carries the underlying error so the next failure is diagnosable", () => {
    const message = hostRequestFailureMessage("http://127.0.0.1:4318", new TypeError("Origin null is not allowed"));
    expect(message).toContain("TypeError");
    expect(message).toContain("Origin null is not allowed");
  });

  // "Load failed" is WebKit's opaque catch-all and adds nothing; it should not be echoed.
  it("omits WebKit's contentless failure string", () => {
    expect(hostRequestFailureMessage("http://127.0.0.1:4318", new TypeError("Load failed")))
      .not.toContain("Load failed");
  });
});

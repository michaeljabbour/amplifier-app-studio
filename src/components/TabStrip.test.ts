import { describe, expect, it } from "vitest";
import { appUpdateButtonTitle } from "./TabStrip";

describe("Studio updater status copy", () => {
  it("shows the actual install failure before release notes", () => {
    expect(appUpdateButtonTitle({
      status: "error",
      notes: "Feature notes",
      message: "Signature verification failed",
    }, false)).toBe("Signature verification failed");
  });

  it("keeps the active-turn blocker authoritative", () => {
    expect(appUpdateButtonTitle({ status: "available", notes: "Feature notes" }, true))
      .toContain("Finish or interrupt active turns");
  });
});

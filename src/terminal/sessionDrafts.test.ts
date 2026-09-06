import { describe, expect, it } from "vitest";
import {
  clearCommandDraft,
  commandDraftFor,
  commandDraftSubmission,
  renameDraftFor,
  renameDraftSubmission,
  setCommandDraft,
  type TerminalRenameDraft,
} from "./sessionDrafts";

describe("terminal session drafts", () => {
  it("keeps command text scoped to its terminal across selection changes", () => {
    const drafts = setCommandDraft({}, "local::alpha", "rm -rf important-alpha-data");

    expect(commandDraftFor(drafts, "local::beta")).toBe("");
    expect(commandDraftSubmission(drafts, "local::beta")).toBeUndefined();
    expect(commandDraftSubmission(drafts, "local::alpha")).toEqual({
      terminalId: "local::alpha",
      value: "rm -rf important-alpha-data",
    });
    expect(clearCommandDraft(drafts, "local::alpha")).toEqual({});
  });

  it("refuses to submit a rename draft through a different terminal", () => {
    const draft: TerminalRenameDraft = { terminalId: "local::alpha", value: " alpha-safe " };

    expect(renameDraftFor(draft, "local::beta")).toBeUndefined();
    expect(renameDraftSubmission(draft, "local::beta")).toBeUndefined();
    expect(renameDraftSubmission(draft, "local::alpha")).toEqual({
      terminalId: "local::alpha",
      value: "alpha-safe",
    });
  });
});

describe("automatic terminal names", () => {
  it("uses the directory and avoids existing names", async () => {
    const { suggestedTerminalName } = await import("./sessionDrafts");
    expect(suggestedTerminalName("/dev/Studio", [])).toBe("Studio");
    expect(suggestedTerminalName("/dev/Studio", ["Studio", "Studio-2"])).toBe("Studio-3");
    expect(suggestedTerminalName("/dev/Project with spaces!", [])).toBe("Project-with-spaces");
    expect(suggestedTerminalName("/", [])).toBe("terminal");
    expect(suggestedTerminalName("/" + "x".repeat(100), [])).toHaveLength(56);
  });
});

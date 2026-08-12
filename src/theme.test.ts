import { describe, expect, it } from "vitest";
import { loadStudioTheme } from "./theme";

describe("Studio theme", () => {
  it("uses the MADE paper direction by default", () => {
    expect(loadStudioTheme({ getItem: () => null })).toBe("made");
  });

  it("preserves the original Studio night option", () => {
    expect(loadStudioTheme({ getItem: () => "studio" })).toBe("studio");
  });
});

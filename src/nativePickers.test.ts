import { describe, expect, it } from "vitest";
import { normalizePickerPaths } from "./nativePickers";

describe("native picker selection normalization", () => {
  it("accepts the single-path and multi-path shapes returned by Tauri", () => {
    expect(normalizePickerPaths("/tmp/project")).toEqual(["/tmp/project"]);
    expect(normalizePickerPaths(["/tmp/a.png", "/tmp/b.webp"])).toEqual([
      "/tmp/a.png",
      "/tmp/b.webp",
    ]);
  });

  it("treats cancellation and invalid values as no selection", () => {
    expect(normalizePickerPaths(null)).toEqual([]);
    expect(normalizePickerPaths(undefined)).toEqual([]);
    expect(normalizePickerPaths(["", 42, null])).toEqual([]);
  });
});

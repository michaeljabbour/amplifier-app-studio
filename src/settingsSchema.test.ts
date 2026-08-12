import { describe, expect, it } from "vitest";
import { RUNTIME_SETTINGS_FIELDS, RUNTIME_SETTINGS_SECTIONS, settingsFieldsInSection } from "./settingsSchema";

describe("runtime settings schema", () => {
  it("matches the 29-field amplifier-tui registry", () => {
    expect(RUNTIME_SETTINGS_SECTIONS).toHaveLength(6);
    expect(RUNTIME_SETTINGS_FIELDS).toHaveLength(29);
    expect(new Set(RUNTIME_SETTINGS_FIELDS.map((field) => field.path)).size).toBe(29);
  });

  it("keeps each field in a known section", () => {
    const sections = new Set(RUNTIME_SETTINGS_SECTIONS.map((section) => section.id));
    expect(RUNTIME_SETTINGS_FIELDS.every((field) => sections.has(field.section))).toBe(true);
    expect(settingsFieldsInSection("providers")).toHaveLength(7);
    expect(settingsFieldsInSection("behavior")).toHaveLength(8);
  });
});

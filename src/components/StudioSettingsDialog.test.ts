// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { preferredSettingsContext, settingsContextKey } from "./StudioSettingsDialog";

describe("Settings project context", () => {
  it("starts a connected host from the project root already discovered by Studio", () => {
    expect(preferredSettingsContext({
      id: "connected",
      name: "Connected host",
      url: "https://spark.example.test",
      tokenRef: "session",
    }, undefined, "/home/mjabbour/dev")).toBe("/home/mjabbour/dev");
  });

  it("replaces a remembered path from the wrong operating system with the host default", () => {
    expect(preferredSettingsContext({
      id: "connected",
      name: "Connected host",
      url: "https://spark.example.test",
      tokenRef: "session",
      defaultProjectRoot: "/home/mjabbour/dev",
    }, "/Users/michaeljabbour/dev", "")).toBe("/home/mjabbour/dev");
  });

  it("uses the discovered host root when a generic connected-host key remembered another machine", () => {
    expect(preferredSettingsContext({
      id: "connected",
      name: "Connected host",
      url: "http://127.0.0.1:4401",
      tokenRef: "session",
    }, "/home/mjabbour/dev", "/Users/michaeljabbour/dev")).toBe("/Users/michaeljabbour/dev");
  });

  it("keeps connected-host contexts isolated by URL", () => {
    expect(settingsContextKey({
      id: "connected",
      name: "Connected host",
      url: "https://spark.example.test/",
      tokenRef: "session",
    })).toBe("connected@https://spark.example.test");
  });
});

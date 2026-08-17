import { describe, expect, it } from "vitest";
import { directoryBreadcrumbs, isPathInsideRoot, remoteProjectDefault, shouldRememberProjectLocally } from "./projectFolders";

describe("project folder defaults", () => {
  it("prefers the host-configured project home over a previously saved project", () => {
    expect(remoteProjectDefault({
      id: "spark",
      name: "Spark",
      url: "https://spark.example.test",
      tokenRef: "session",
      defaultProjectRoot: "/home/mjabbour/amplifier",
    }, "/home/mjabbour/dev")).toBe("/home/mjabbour/dev");
  });

  it("does not let a remote project overwrite the local picker default", () => {
    expect(shouldRememberProjectLocally({ hostId: "connected", hostUrl: "https://spark.example.test" })).toBe(false);
    expect(shouldRememberProjectLocally({ hostId: "local", hostUrl: undefined })).toBe(true);
  });
});

describe("project folder breadcrumbs", () => {
  it("makes every level back to the allowed workspace root navigable", () => {
    expect(directoryBreadcrumbs({
      path: "/home/mjabbour/dev/amplifier-app-studio",
      roots: ["/home/mjabbour/dev"],
    })).toEqual([
      { label: "dev", path: "/home/mjabbour/dev" },
      { label: "amplifier-app-studio", path: "/home/mjabbour/dev/amplifier-app-studio" },
    ]);
  });

  it("uses the most specific allowed root and supports Windows host paths", () => {
    expect(directoryBreadcrumbs({
      path: "C:\\Users\\Michael\\dev\\studio",
      roots: ["C:\\Users\\Michael", "C:\\Users\\Michael\\dev"],
    })).toEqual([
      { label: "dev", path: "C:\\Users\\Michael\\dev" },
      { label: "studio", path: "C:\\Users\\Michael\\dev\\studio" },
    ]);
  });

  it("treats filesystem roots as real path boundaries", () => {
    expect(isPathInsideRoot("/home/mjabbour/dev", "/")).toBe(true);
    expect(isPathInsideRoot("C:\\Users\\Michael\\dev", "C:\\")).toBe(true);
    expect(isPathInsideRoot("/home/mjabbour/development", "/home/mjabbour/dev")).toBe(false);
  });
});

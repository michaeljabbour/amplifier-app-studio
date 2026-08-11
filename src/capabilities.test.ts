import { describe, expect, it } from "vitest";
import { capabilityReadiness, capabilitySessionInput, STUDIO_CAPABILITIES } from "./capabilities";

describe("Studio capabilities", () => {
  it("pins the image studio and launches app use in auto mode", () => {
    const imagen = STUDIO_CAPABILITIES.find((item) => item.id === "imagen")!;
    const appUse = STUDIO_CAPABILITIES.find((item) => item.id === "app-use")!;
    expect(imagen.bundle).toContain("@v2.0.0");
    expect(capabilitySessionInput(appUse, "/tmp/project")).toMatchObject({
      projectDir: "/tmp/project",
      bundle: "computer-use",
      mode: "auto",
      capabilityId: "app-use",
    });
  });

  it("does not claim an on-demand bundle is installed", () => {
    const browser = STUDIO_CAPABILITIES.find((item) => item.id === "browser")!;
    expect(capabilityReadiness(browser, { bundles: [], providers: [] })).toBe("on-demand");
    expect(capabilityReadiness(browser, {
      bundles: [{ name: "browser-tester", active: false, location: "cache", status: "available" }],
      providers: [],
    })).toBe("catalogued");
  });
});

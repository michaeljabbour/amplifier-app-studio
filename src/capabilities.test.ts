import { describe, expect, it } from "vitest";
import { capabilityReadiness, capabilitySessionInput, STUDIO_CAPABILITIES } from "./capabilities";

describe("Studio capabilities", () => {
  it("pins the image studio without presenting Autopilot as another machine", () => {
    const imagen = STUDIO_CAPABILITIES.find((item) => item.id === "imagen")!;
    expect(imagen.bundle).toContain("@v2.0.0");
    expect(capabilitySessionInput(imagen, "/tmp/project")).toMatchObject({
      projectDir: "/tmp/project",
      bundle: imagen.bundle,
      mode: "auto",
      capabilityId: "imagen",
    });
    expect(STUDIO_CAPABILITIES.some((item) => item.id === ("app-use" as never))).toBe(false);
    expect(STUDIO_CAPABILITIES.find((item) => item.id === "terminal")?.activation).toBe("included");
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

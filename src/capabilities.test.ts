import { describe, expect, it } from "vitest";
import {
  capabilityReadiness,
  capabilitySessionInput,
  capabilityStatusLabel,
  sessionUsesCapability,
  STUDIO_CAPABILITIES,
} from "./capabilities";

describe("Studio capabilities", () => {
  it("pins the image studio and composes App Use as a real runtime", () => {
    const imagen = STUDIO_CAPABILITIES.find((item) => item.id === "imagen")!;
    expect(imagen.bundle).toContain("@v2.0.0");
    expect(capabilitySessionInput(imagen, "/tmp/project")).toMatchObject({
      projectDir: "/tmp/project",
      bundle: imagen.bundle,
      mode: "auto",
      capabilityId: "imagen",
    });
    const appUse = STUDIO_CAPABILITIES.find((item) => item.id === "app-use")!;
    expect(appUse.activation).toBe("parallel-session");
    expect(appUse.bundle).toMatch(
      /^git\+https:\/\/github\.com\/microsoft\/amplifier-bundle-computer-use@[0-9a-f]{40}$/,
    );
    expect(STUDIO_CAPABILITIES.find((item) => item.id === "terminal")?.activation).toBe("included");
    const attractor = STUDIO_CAPABILITIES.find((item) => item.id === "attractor")!;
    expect(attractor.activation).toBe("parallel-session");
    expect(attractor.bundle).toMatch(
      /^git\+https:\/\/github\.com\/microsoft\/amplifier-bundle-attractor@[0-9a-f]{40}#subdirectory=bundles\/attractor-interactive\.yaml$/,
    );
    expect(capabilityReadiness(attractor, { bundles: [], providers: [] })).toBe("on-demand");
    expect(attractor.requirements.join(" ")).toContain("typed pipeline event contract");
  });

  it("does not claim an on-demand bundle is installed", () => {
    const browser = STUDIO_CAPABILITIES.find((item) => item.id === "browser")!;
    expect(capabilityReadiness(browser, { bundles: [], providers: [] })).toBe("on-demand");
    expect(capabilityReadiness(browser, {
      bundles: [{ name: "browser-tester", active: false, location: "cache", status: "available" }],
      providers: [],
    })).toBe("catalogued");
    const terminal = STUDIO_CAPABILITIES.find((item) => item.id === "terminal")!;
    expect(capabilityReadiness(terminal, { bundles: [], providers: [] })).toBe("composition");
    expect(capabilityStatusLabel("on-demand")).toBe("Available on demand");
  });

  it("distinguishes a capability mounted in this tab from one available in Studio", () => {
    const imagen = STUDIO_CAPABILITIES.find((item) => item.id === "imagen")!;
    expect(sessionUsesCapability(imagen, { bundle: "tui", capabilityId: undefined })).toBe(false);
    expect(sessionUsesCapability(imagen, { bundle: "imagen", capabilityId: undefined })).toBe(true);
    expect(sessionUsesCapability(imagen, { bundle: "tui", capabilityId: "imagen" })).toBe(true);
  });
});

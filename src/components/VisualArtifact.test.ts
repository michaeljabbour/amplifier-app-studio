// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildSandboxedHtmlDocument,
  sanitizeVisualSvg,
  visualArtifactSourceError,
  visualArtifactTitle,
  VISUAL_ARTIFACT_SANDBOX,
} from "./VisualArtifact";

describe("visual artifacts", () => {
  it("runs interactive HTML only inside a unique-origin, network-disabled sandbox", () => {
    const document = buildSandboxedHtmlDocument("<h1>Architecture</h1><script>document.body.dataset.ready='yes'</script>");
    expect(VISUAL_ARTIFACT_SANDBOX).toBe("allow-scripts");
    expect(VISUAL_ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("<script>document.body.dataset.ready='yes'</script>");
  });

  it("removes active SVG content, remote links, and fixed sizing", () => {
    const svg = sanitizeVisualSvg('<svg width="900" height="400"><title>Safe map</title><script>alert(1)</script><image href="https://example.com/x.png"/><rect onclick="alert(1)"/></svg>');
    expect(svg).toContain('aria-label="Safe map"');
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("onclick");
    expect(svg).not.toContain('width="900"');
  });

  it("derives inert titles and rejects empty or oversized payloads", () => {
    expect(visualArtifactTitle("html", "<h1>System <em>map</em></h1>")).toBe("System map");
    expect(visualArtifactTitle("dot", "digraph Runtime { a -> b }")).toBe("Runtime");
    expect(visualArtifactSourceError(" ")).toContain("empty");
    expect(visualArtifactSourceError("x".repeat(300_001))).toContain("too large");
  });
});

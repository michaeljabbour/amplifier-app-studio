// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { extractVisualSegments, renderMarkdown } from "./Markdown";

describe("renderMarkdown", () => {
  it("renders common model markdown as document structure", () => {
    const html = renderMarkdown("## Result\n\nA **strong** result with `code`.\n\n- one\n- two");
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("sanitizes active content and makes links safe", () => {
    const html = renderMarkdown("[safe](https://example.com) <script>alert(1)</script> [bad](javascript:alert(1))");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("does not fetch model-authored remote images", () => {
    const html = renderMarkdown("![Architecture](https://example.com/private.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("Image reference · Architecture");
  });

  it("extracts only explicit Amplifier visual fences", () => {
    const source = "Before\n\n```html\n<div>ordinary code</div>\n```\n\n```amplifier-svg\n<svg><title>Map</title></svg>\n```\n\nAfter";
    const segments = extractVisualSegments(source);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: "markdown" });
    expect(segments[0].source).toContain("```html");
    expect(segments[1]).toEqual({ kind: "artifact", format: "svg", source: "<svg><title>Map</title></svg>" });
    expect(segments[2]).toEqual({ kind: "markdown", source: "\n\nAfter" });
  });

  it("leaves an incomplete visual fence as ordinary markdown while streaming", () => {
    expect(extractVisualSegments("```amplifier-html\n<div>partial"))
      .toEqual([{ kind: "markdown", source: "```amplifier-html\n<div>partial" }]);
  });
});

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { inlineVisualId, svgRasterDimensions, visualPngName } from "./visualExport";

describe("visual export", () => {
  it("gives replayed response visuals stable distinct output identities", () => {
    expect(inlineVisualId("dot", "digraph map { a -> b }")).toBe(
      inlineVisualId("dot", "digraph map { a -> b }"),
    );
    expect(inlineVisualId("dot", "digraph map { a -> b }")).not.toBe(
      inlineVisualId("svg", "digraph map { a -> b }"),
    );
  });

  it("derives safe PNG names without double extensions", () => {
    expect(visualPngName("Runtime map")).toBe("Runtime map.png");
    expect(visualPngName("Runtime map.png")).toBe("Runtime map.png");
    expect(visualPngName("../../")).toBe("Amplifier diagram.png");
  });

  it("uses SVG viewBox dimensions and bounds very large exports", () => {
    expect(svgRasterDimensions('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320"/>'))
      .toEqual({ width: 1280, height: 640 });
    const large = svgRasterDimensions('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20000 10000"/>');
    expect(large.width).toBeLessThanOrEqual(8192);
    expect(large.width * large.height).toBeLessThanOrEqual(40_000_000);
  });
});

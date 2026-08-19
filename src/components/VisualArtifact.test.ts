// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  ARTIFACT_RESIZE_MESSAGE,
  buildSandboxedHtmlDocument,
  clampArtifactHeight,
  dotArtifactFailureMessage,
  dotArtifactIsPending,
  isArtifactResizeMessage,
  renderDotArtifact,
  sanitizeVisualSvg,
  visualArtifactSourceError,
  visualArtifactTitle,
  VISUAL_ARTIFACT_SANDBOX,
} from "./VisualArtifact";

describe("visual artifacts", () => {
  it("runs interactive HTML only inside a unique-origin, network-disabled sandbox", () => {
    const document = buildSandboxedHtmlDocument("<h1>Architecture</h1><script>document.body.dataset.ready='yes'</script>", "frame-7");
    expect(VISUAL_ARTIFACT_SANDBOX).toBe("allow-scripts");
    expect(VISUAL_ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("<script>document.body.dataset.ready='yes'</script>");
    expect(document).toContain(ARTIFACT_RESIZE_MESSAGE);
    expect(document).toContain('const frameId = "frame-7"');
    expect(document).toContain("ResizeObserver");
    expect(document).toContain("overflow: hidden");
  });

  it("accepts correlated resize messages and bounds pathological document heights", () => {
    expect(isArtifactResizeMessage({ type: ARTIFACT_RESIZE_MESSAGE, frameId: "frame-1", height: 940 }, "frame-1")).toBe(true);
    expect(isArtifactResizeMessage({ type: ARTIFACT_RESIZE_MESSAGE, frameId: "other", height: 940 }, "frame-1")).toBe(false);
    expect(clampArtifactHeight(940.2)).toBe(941);
    expect(clampArtifactHeight(-1)).toBe(300);
    expect(clampArtifactHeight(99_000)).toBe(12_000);
  });

  it("removes active SVG content, remote links, and fixed sizing", () => {
    const svg = sanitizeVisualSvg('<svg width="900" height="400"><title>Safe map</title><script>alert(1)</script><image href="https://example.com/x.png"/><rect onclick="alert(1)"/></svg>');
    expect(svg).toContain('aria-label="Safe map"');
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("onclick");
    expect(svg).not.toContain('width="900"');
  });

  it("accepts Graphviz XML wrappers and renders the Spark topology used by remote compute", async () => {
    const wrapped = sanitizeVisualSvg('<?xml version="1.0"?><!DOCTYPE svg><svg width="20" height="10"><title>Spark</title><rect width="20" height="10"/></svg>');
    expect(wrapped).toContain('aria-label="Spark"');

    const dot = `digraph spark {
      rankdir=TB;
      bgcolor="transparent";
      node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=11, color="#444444", fontcolor="#111111"];
      subgraph cluster_soc {
        label="GB10 Superchip";
        X [label="10× Cortex-X925\\ncpu 5-9, 15-19\\n3.9–4.0 GHz", fillcolor="#d9f0c2"];
        A [label="10× Cortex-A725\\ncpu 0-4, 10-14\\n2.8 GHz", fillcolor="#eef7e3"];
        G [label="GB10 GPU\\nBlackwell, CUDA 13.0", fillcolor="#c9e6f5"];
        M [label="119 GiB LPDDR5X — UNIFIED\\nno copies, but also no isolation", fillcolor="#ffe9b8", shape=box3d];
        X -> M [label=" coherent"];
        A -> M [label=" coherent"];
        G -> M [label=" coherent"];
      }
      D [label="Desktop stack\\nGNOME · snaps · cups · bluetooth", fillcolor="#f7d4d4"];
      S [label="16 GiB swapfile\\nswappiness = 60", fillcolor="#f7d4d4"];
      D -> M [label=" ~2-3 GiB", color="#c04040"];
      M -> S [label=" page-out = GPU stall", color="#c04040"];
    }`;
    const result = await renderDotArtifact(dot);
    expect(result.error).toBeUndefined();
    expect(result.svg).toContain("<svg");
    expect(result.svg).toContain("GB10 Superchip");
    expect(result.svg).toContain('aria-label="spark"');
  });

  it("reports why a DOT graph failed instead of silently rendering nothing", async () => {
    // `->` inside an undirected `graph` is a Graphviz syntax error, and the most
    // common way a generated diagram fails. The reason must reach the user.
    const result = await renderDotArtifact("graph broken { a -> b }");
    expect(result.svg).toBe("");
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("Graphviz rejected it");
    expect(result.error).toMatch(/syntax/i);
    expect(dotArtifactFailureMessage(result)).toMatch(/Graphviz rejected it.*syntax/i);
  });

  it("never leaves a failed diagram as a generic blank panel", () => {
    expect(dotArtifactFailureMessage(undefined, new Error("WASM module unavailable"))).toContain("WASM module unavailable");
    expect(dotArtifactFailureMessage()).toContain("did not finish loading");
  });

  it("keeps an unresolved Graphviz resource in its loading state", () => {
    expect(dotArtifactIsPending(false, "unresolved")).toBe(true);
    expect(dotArtifactIsPending(true, "pending")).toBe(true);
    expect(dotArtifactIsPending(false, "ready")).toBe(false);
  });

  it("derives inert titles and rejects empty or oversized payloads", () => {
    expect(visualArtifactTitle("html", "<h1>System <em>map</em></h1>")).toBe("System map");
    expect(visualArtifactTitle("dot", "digraph Runtime { a -> b }")).toBe("Runtime");
    expect(visualArtifactSourceError(" ")).toContain("empty");
    expect(visualArtifactSourceError("x".repeat(300_001))).toContain("too large");
  });
});

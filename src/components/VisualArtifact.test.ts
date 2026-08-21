// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSandboxedHtmlDocument,
  dotArtifactFailureMessage,
  dotArtifactIsPending,
  renderDotArtifact,
  sanitizeVisualSvg,
  visualArtifactSourceError,
  visualArtifactTitle,
  VISUAL_ARTIFACT_SANDBOX,
} from "./VisualArtifact";

describe("visual artifacts", () => {
  // Graphviz writes a leading or trailing space in a label as the numeric reference `&#160;`.
  // The sanitiser used to serialise through DOMPurify's HTML serialiser, which rewrites U+00A0 as
  // the named `&nbsp;`, and then re-parse that as XML -- where only five named entities exist. The
  // diagram was discarded with "its SVG output was rejected by the sanitizer", which is how this
  // reached a user. Three of four graphs in local session history hit it.
  it("keeps a diagram whose labels contain the non-breaking spaces Graphviz emits for padded labels", () => {
    const svg = sanitizeVisualSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20">'
      + "<text>&#160;this session&#160;</text></svg>",
    );
    expect(svg).not.toBe("");
    expect(svg).toContain("this session");
    expect(svg).not.toContain("&nbsp;");
    // The survivor must still be well-formed XML: it is injected into an XML-parsed sandbox.
    const reparsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(reparsed.querySelector("parsererror")).toBeNull();
  });

  it("still strips active content from an SVG that also carries non-breaking spaces", () => {
    const svg = sanitizeVisualSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>&#160;pad&#160;</text>'
      + "<script>alert(1)</script>"
      + '<a xlink:href="javascript:alert(2)"><text>link</text></a>'
      + '<image href="https://example.com/x.png"/><use href="#x"/>'
      + "<foreignObject><span>html</span></foreignObject>"
      + '<rect onload="alert(3)" style="fill:red"/></svg>',
    );
    expect(svg).toContain("pad");
    for (const forbidden of ["<script", "<a ", "<image", "<use", "foreignObject", "onload", "style=", "href=", "javascript:"]) {
      expect(svg).not.toContain(forbidden);
    }
  });

  it("renders artifact HTML only inside a unique-origin, network-disabled sandbox", () => {
    const document = buildSandboxedHtmlDocument("<h1>Architecture</h1><script>document.body.dataset.ready='yes'</script>");
    expect(VISUAL_ARTIFACT_SANDBOX).toBe("allow-scripts");
    expect(VISUAL_ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("form-action 'none'");
    // The artifact's own markup and scripts survive into the document verbatim. Whether that
    // script EXECUTES is decided by the inherited policy, not by us -- see the test below.
    expect(document).toContain("<script>document.body.dataset.ready='yes'</script>");
    expect(document).toContain("overflow: auto");
  });

  // Studio no longer injects any script into artifact frames, so `script-src` needs no hash.
  //
  // The hash only ever bought one thing. A srcdoc frame inherits the embedder's policy container,
  // and under that policy the ARTIFACT's own inline scripts are blocked regardless -- verified in
  // WKWebView and Chrome: with the hash present only Studio's own hashed script ran, the
  // artifact's did not. So hash-allowlisting restored Studio's sizing script, never author
  // interactivity. Sizing is now pure CSS, and this asserts the machinery stays gone.
  it("injects no host script into the artifact frame and pins no hash", () => {
    const document = buildSandboxedHtmlDocument("<h1>Chart</h1>");
    expect(document).not.toContain("postMessage");
    expect(document).not.toContain("ResizeObserver");
    expect(document).not.toContain("requestAnimationFrame");
    // The only <script> in the document is whatever the artifact itself supplied -- here, none.
    expect(document).not.toContain("<script>");

    const csp = JSON.parse(readFileSync(join(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8")).app.security.csp as string;
    const scriptSrc = csp.split(";").map((directive) => directive.trim()).find((directive) => directive.startsWith("script-src "));
    expect(scriptSrc).toBe("script-src 'self' 'wasm-unsafe-eval'");
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

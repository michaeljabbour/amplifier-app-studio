# Inline visualization protocol

Amplifier Studio renders explicit visual-artifact fences inside coordinator Markdown. The model or a bundle chooses the smallest format that fits the result:

```text
amplifier-dot   Graphviz source for flows, graphs, and execution topology
amplifier-svg   static vector figures that need precise custom drawing
amplifier-html  self-contained interactive HTML, CSS, SVG, and local JavaScript
```

Use a fenced block named `amplifier-dot`, `amplifier-svg`, or `amplifier-html`. Ordinary `html`, `svg`, and `dot` code blocks remain source code; they are never promoted into a visual surface implicitly.

## Security boundary

- DOT is rendered locally with Viz.js and the resulting SVG is sanitized.
- SVG removes scripts, styles, event handlers, links, remote media, `foreignObject`, and reusable external references.
- HTML runs in an iframe with `sandbox="allow-scripts"`. It has a unique origin, cannot access Studio or Tauri APIs, and receives an inner Content Security Policy with network, forms, frames, workers, objects, and base URLs disabled.
- **Author JavaScript does not execute.** A `srcdoc` frame inherits the embedder's CSP policy
  container rather than replacing it, so Studio's own `script-src 'self' 'wasm-unsafe-eval'`
  applies inside the frame and blocks the artifact's inline scripts. This was verified in both
  WKWebView and Chrome. It is true of every packaged desktop build and of the browser host; it is
  NOT true under `npm run dev`, whose Vite server sends no CSP, so an artifact that works in dev
  can be inert in a release. Author HTML, CSS, SVG and Canvas markup — not behaviour.
- Artifact source is capped at 300 KB. The preview is a fixed-height panel (420 px) that scrolls
  internally, with an Expand control that grows it to `min(80vh, 1000px)`. Studio injects no
  script of its own into the frame; sizing is pure CSS.

The outer Studio CSP permits only the sandboxed local frame. The artifact CSP is stricter than Studio itself and is part of the rendered document, so a model-authored artifact cannot inherit Studio network access.

## Bundle guidance

Visualization-oriented agents should emit one complete fence followed by a short prose interpretation. Prefer DOT for topology, SVG for publication-style static figures, and HTML only when interaction or animation materially improves understanding. The composer starter teaches this contract without coupling the runtime to any presentation format: `amplifier-runtime` carries text and events; Studio owns safe rendering.

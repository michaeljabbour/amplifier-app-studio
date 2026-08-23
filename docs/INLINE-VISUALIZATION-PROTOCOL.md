# Inline visualization protocol

Amplifier Studio renders explicit visual-artifact fences inside coordinator Markdown. The model or a bundle chooses the smallest format that fits the result:

```text
amplifier-dot   Graphviz source for flows, graphs, and execution topology
amplifier-svg   static vector figures that need precise custom drawing
amplifier-html  self-contained HTML, CSS, SVG and Canvas markup (no author JavaScript)
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
  internally and can open as a true edge-to-edge surface; Escape returns to the transcript.
  Studio injects no script of its own into the frame; sizing is pure CSS.

## Output and export behavior

Once a DOT or SVG fence has a sanitized SVG render, Studio registers it as a
diagram in the owning session's Outputs view. The visual card and Outputs row
both offer **Save PNG**. Desktop saves always use the OS-native destination
picker; the Rust boundary accepts only an absolute `.png` destination, a valid
PNG signature, and at most 64 MB. Rasterization is capped at 8,192 pixels per
edge and 40 million pixels, with a white background for reliable Finder,
Preview, and document rendering. Browser-hosted Studio uses the browser's
download surface. HTML artifacts can open full screen but are not promoted to
PNG because their unique-origin sandbox is intentionally not readable by the
host canvas.

The outer Studio CSP permits only the sandboxed local frame. The artifact's own CSP is part of the
rendered document and is stricter than Studio's on the directives that matter here -- `default-src`,
`connect-src` and `frame-src` are all `'none'` -- so a model-authored artifact cannot reach the
network. It is not stricter on every directive: its `script-src 'unsafe-inline'` is looser than
Studio's, which is precisely why the frame inheriting Studio's policy is what blocks author scripts.

## Bundle guidance

Visualization-oriented agents should emit one complete fence followed by a short prose interpretation. Prefer DOT for topology, SVG for publication-style static figures, and HTML when layout, tables or CSS styling carry the meaning. Do not reach for HTML expecting interactivity: author scripts do not run, so a chart that needs a click handler should be a DOT or SVG figure instead. The composer starter teaches this contract without coupling the runtime to any presentation format: `amplifier-runtime` carries text and events; Studio owns safe rendering.

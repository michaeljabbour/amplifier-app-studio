import DOMPurify from "dompurify";
import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { renderGraphvizSvg } from "../dotRenderer";

export type VisualArtifactFormat = "html" | "svg" | "dot";

interface Props {
  format: VisualArtifactFormat;
  source: string;
}

const MAX_ARTIFACT_SOURCE = 300_000;
const MIN_ARTIFACT_HEIGHT = 300;
const MAX_ARTIFACT_HEIGHT = 12_000;
export const ARTIFACT_RESIZE_MESSAGE = "amplifier-studio:artifact-resize";
export const VISUAL_ARTIFACT_SANDBOX = "allow-scripts";
let artifactSequence = 0;

export function VisualArtifact(props: Props) {
  const frameId = `artifact-${++artifactSequence}`;
  let frame: HTMLIFrameElement | undefined;
  const [expanded, setExpanded] = createSignal(false);
  const [showSource, setShowSource] = createSignal(false);
  const [frameHeight, setFrameHeight] = createSignal(420);
  const sourceError = createMemo(() => visualArtifactSourceError(props.source));
  const [dotSvg] = createResource(
    () => props.format === "dot" && !sourceError() ? props.source : undefined,
    renderDotArtifact,
  );
  const staticSvg = createMemo(() => props.format === "svg" && !sourceError() ? sanitizeVisualSvg(props.source) : undefined);
  const title = createMemo(() => visualArtifactTitle(props.format, props.source));

  onMount(() => {
    const resize = (event: MessageEvent) => {
      if (event.source !== frame?.contentWindow || !isArtifactResizeMessage(event.data, frameId)) return;
      setFrameHeight(clampArtifactHeight(event.data.height));
    };
    window.addEventListener("message", resize);
    onCleanup(() => window.removeEventListener("message", resize));
  });

  return (
    <section class="visual-artifact" classList={{ expanded: expanded() }} aria-label={`${title()} visual artifact`}>
      <header>
        <div>
          <span>{artifactFormatLabel(props.format)}</span>
          <strong>{title()}</strong>
          <small>{props.format === "html" ? "Sandboxed · scripts local · network off" : "Sanitized · links and remote media removed"}</small>
        </div>
        <nav aria-label="Visual artifact controls">
          <button type="button" aria-pressed={showSource()} onClick={() => setShowSource((value) => !value)}>{showSource() ? "Preview" : "Source"}</button>
          <button type="button" aria-pressed={expanded()} onClick={() => setExpanded((value) => !value)}>{expanded() ? "Collapse" : "Expand"}</button>
        </nav>
      </header>
      <Show when={!sourceError()} fallback={<p class="visual-artifact-error">{sourceError()}</p>}>
        <Show when={!showSource()} fallback={<pre class="visual-artifact-source"><code>{props.source}</code></pre>}>
          <div class="visual-artifact-stage">
            <Show when={props.format === "html"}>
              <iframe
                title={title()}
                sandbox={VISUAL_ARTIFACT_SANDBOX}
                referrerPolicy="no-referrer"
                scrolling="no"
                style={{ height: `${frameHeight()}px` }}
                ref={(element) => { frame = element; }}
                srcdoc={buildSandboxedHtmlDocument(props.source, frameId)}
              />
            </Show>
            <Show when={props.format === "svg"}>
              <Show when={staticSvg()} fallback={<p class="visual-artifact-error">This SVG could not be rendered safely.</p>}>
                <div class="visual-artifact-svg" innerHTML={staticSvg() || ""} />
              </Show>
            </Show>
            <Show when={props.format === "dot"}>
              <Show when={!dotSvg.loading} fallback={<p class="visual-artifact-loading">Laying out diagram…</p>}>
                <Show when={dotSvg()} fallback={<p class="visual-artifact-error">This DOT graph could not be rendered.</p>}>
                  <div class="visual-artifact-svg" innerHTML={dotSvg() || ""} />
                </Show>
              </Show>
            </Show>
          </div>
        </Show>
      </Show>
    </section>
  );
}

export function visualArtifactSourceError(source: string): string | undefined {
  if (!source.trim()) return "This visual artifact is empty.";
  if (source.length > MAX_ARTIFACT_SOURCE) return "This visual artifact is too large to render safely. Open its source or output file instead.";
  return undefined;
}

export function buildSandboxedHtmlDocument(source: string, frameId = "artifact-preview"): string {
  const error = visualArtifactSourceError(source);
  if (error) return `<!doctype html><html><body><p>${escapeHtml(error)}</p></body></html>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data: blob:; media-src 'none'; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="referrer" content="no-referrer">
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body { overflow: hidden; padding: 18px; background: #0b1118; color: #e7eef7; }
    svg, canvas { max-width: 100%; }
    @media (prefers-color-scheme: light) { body { background: #f8f6f3; color: #24211e; } }
  </style>
  <script>
    (() => {
      const frameId = ${JSON.stringify(frameId)};
      let lastHeight = 0;
      let scheduled = false;
      const measure = () => {
        scheduled = false;
        const root = document.documentElement;
        const body = document.body;
        if (!body) return;
        const childBottom = Array.from(body.children).reduce((bottom, child) => {
          const rect = child.getBoundingClientRect();
          return Math.max(bottom, rect.bottom + window.scrollY);
        }, 0);
        const height = Math.ceil(Math.max(root.scrollHeight, body.scrollHeight, childBottom));
        if (height > 0 && height !== lastHeight) {
          lastHeight = height;
          parent.postMessage({ type: ${JSON.stringify(ARTIFACT_RESIZE_MESSAGE)}, frameId, height }, "*");
        }
      };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(measure);
      };
      addEventListener("load", schedule);
      addEventListener("resize", schedule);
      document.addEventListener("DOMContentLoaded", () => {
        new ResizeObserver(schedule).observe(document.documentElement);
        new ResizeObserver(schedule).observe(document.body);
        schedule();
      });
    })();
  </script>
</head>
<body>${source}</body>
</html>`;
}

export function clampArtifactHeight(height: unknown): number {
  const numeric = typeof height === "number" && Number.isFinite(height) ? Math.ceil(height) : MIN_ARTIFACT_HEIGHT;
  return Math.min(MAX_ARTIFACT_HEIGHT, Math.max(MIN_ARTIFACT_HEIGHT, numeric));
}

export function isArtifactResizeMessage(value: unknown, frameId: string): value is { type: string; frameId: string; height: number } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === ARTIFACT_RESIZE_MESSAGE
    && record.frameId === frameId
    && typeof record.height === "number"
    && Number.isFinite(record.height);
}

export function sanitizeVisualSvg(source: string): string {
  const svgSource = extractSvgDocument(source);
  if (!svgSource) return "";
  const clean = DOMPurify.sanitize(svgSource, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "style", "foreignObject", "a", "image", "use"],
    FORBID_ATTR: ["href", "xlink:href", "style", "onload", "onclick"],
  });
  const documentNode = new DOMParser().parseFromString(clean, "image/svg+xml");
  const svg = documentNode.documentElement;
  if (svg.tagName.toLowerCase() !== "svg" || documentNode.querySelector("parsererror")) return "";
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", visualArtifactTitle("svg", source));
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  return new XMLSerializer().serializeToString(svg);
}

export async function renderDotArtifact(source: string): Promise<string> {
  try {
    return sanitizeVisualSvg(await renderGraphvizSvg(source));
  } catch {
    return "";
  }
}

export function visualArtifactTitle(format: VisualArtifactFormat, source: string): string {
  if (format === "html") {
    const match = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    return match ? stripMarkup(match[1]).slice(0, 100) || "Interactive visual" : "Interactive visual";
  }
  if (format === "svg") {
    const match = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? stripMarkup(match[1]).slice(0, 100) || "SVG visual" : "SVG visual";
  }
  const match = source.match(/(?:di)?graph\s+(?:"([^"]+)"|([A-Za-z_][\w-]*))/i);
  return (match?.[1] || match?.[2] || "DOT diagram").slice(0, 100);
}

function artifactFormatLabel(format: VisualArtifactFormat): string {
  return format === "html" ? "INTERACTIVE HTML" : format === "svg" ? "INLINE SVG" : "GRAPHVIZ DOT";
}

function stripMarkup(value: string): string {
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(value, { ALLOWED_TAGS: [] });
  return (template.content.textContent || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function extractSvgDocument(source: string): string {
  const start = source.search(/<svg(?:\s|>)/i);
  const end = source.toLowerCase().lastIndexOf("</svg>");
  return start >= 0 && end >= start ? source.slice(start, end + 6) : "";
}

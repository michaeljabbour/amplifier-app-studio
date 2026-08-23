import DOMPurify from "dompurify";
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { renderGraphvizSvg } from "../dotRenderer";
import type { InlineVisualArtifact } from "../protocol";
import { inlineVisualId, saveInlineVisualPng } from "../visualExport";

export type VisualArtifactFormat = "html" | "svg" | "dot";

/** A failed DOT render carries why it failed: silent empty output made this bug undiagnosable. */
export interface DotArtifactResult {
  svg: string;
  error?: string;
}

interface Props {
  format: VisualArtifactFormat;
  source: string;
  onReady?: (artifact: InlineVisualArtifact) => void;
}

const MAX_ARTIFACT_SOURCE = 300_000;
export const VISUAL_ARTIFACT_SANDBOX = "allow-scripts";

export function VisualArtifact(props: Props) {
  const [fullScreen, setFullScreen] = createSignal(false);
  const [showSource, setShowSource] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saveMessage, setSaveMessage] = createSignal("");
  const sourceError = createMemo(() => visualArtifactSourceError(props.source));
  const [dotSvg, { refetch: refetchDot }] = createResource(
    () => props.format === "dot" && !sourceError() ? props.source : undefined,
    renderDotArtifact,
  );
  const dotPending = createMemo(() => dotArtifactIsPending(dotSvg.loading, dotSvg.state));
  const dotFailure = createMemo(() => dotArtifactFailureMessage(dotSvg(), dotSvg.error));
  const staticSvg = createMemo(() => props.format === "svg" && !sourceError() ? sanitizeVisualSvg(props.source) : undefined);
  const title = createMemo(() => visualArtifactTitle(props.format, props.source));
  const renderedSvg = createMemo(() => props.format === "svg" ? staticSvg() : props.format === "dot" ? dotSvg()?.svg : undefined);
  const readyArtifact = createMemo<InlineVisualArtifact | undefined>(() => {
    const svg = renderedSvg();
    if (!svg || props.format === "html") return undefined;
    return {
      id: inlineVisualId(props.format, props.source),
      title: title(),
      format: props.format,
      source: props.source,
      svg,
    };
  });

  createEffect(() => {
    const artifact = readyArtifact();
    if (artifact) props.onReady?.(artifact);
  });

  createEffect(() => {
    document.documentElement.classList.toggle("visual-artifact-open", fullScreen());
  });

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && fullScreen()) setFullScreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      document.documentElement.classList.remove("visual-artifact-open");
    });
  });

  const savePng = async () => {
    const artifact = readyArtifact();
    if (!artifact || saving()) return;
    setSaving(true);
    setSaveMessage("");
    try {
      const path = await saveInlineVisualPng(artifact);
      if (path) setSaveMessage(`Saved ${path}`);
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="visual-artifact" classList={{ "full-screen": fullScreen() }} aria-label={`${title()} visual artifact`}>
      <header>
        <div>
          <span>{artifactFormatLabel(props.format)}</span>
          <strong>{title()}</strong>
          <small>{props.format === "html" ? "Sandboxed · no scripts · network off" : "Sanitized · links and remote media removed"}</small>
        </div>
        <nav aria-label="Visual artifact controls">
          <button type="button" aria-pressed={showSource()} onClick={() => setShowSource((value) => !value)}>{showSource() ? "Preview" : "Source"}</button>
          <Show when={readyArtifact()}><button type="button" disabled={saving()} onClick={() => void savePng()}>{saving() ? "Saving…" : "Save PNG"}</button></Show>
          <button type="button" aria-pressed={fullScreen()} onClick={() => setFullScreen((value) => !value)}>{fullScreen() ? "Exit full screen" : "Full screen"}</button>
        </nav>
      </header>
      <Show when={saveMessage()}><p class="visual-artifact-save-message" role="status">{saveMessage()}</p></Show>
      <Show when={!sourceError()} fallback={<p class="visual-artifact-error">{sourceError()}</p>}>
        <Show when={!showSource()} fallback={<pre class="visual-artifact-source"><code>{props.source}</code></pre>}>
          <div class="visual-artifact-stage">
            <Show when={props.format === "html"}>
              <iframe
                title={title()}
                sandbox={VISUAL_ARTIFACT_SANDBOX}
                referrerPolicy="no-referrer"
                srcdoc={buildSandboxedHtmlDocument(props.source)}
              />
            </Show>
            <Show when={props.format === "svg"}>
              <Show when={staticSvg()} fallback={<p class="visual-artifact-error">This SVG could not be rendered safely.</p>}>
                <div class="visual-artifact-svg" innerHTML={staticSvg() || ""} />
              </Show>
            </Show>
            <Show when={props.format === "dot"}>
              <Show when={!dotPending()} fallback={<p class="visual-artifact-loading">Laying out diagram…</p>}>
                <Show when={dotSvg()?.svg} fallback={
                  <div class="visual-artifact-error-actions">
                    <p class="visual-artifact-error">{dotFailure()}</p>
                    <button type="button" onClick={() => void refetchDot()}>Retry diagram</button>
                  </div>
                }>
                  <div class="visual-artifact-svg" innerHTML={dotSvg()?.svg || ""} />
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

export function buildSandboxedHtmlDocument(source: string): string {
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
    /* The host gives the frame a definite height and the artifact scrolls inside it, so the
       document must be scrollable rather than clipped. */
    body { overflow: auto; padding: 18px; background: #0b1118; color: #e7eef7; }
    svg, canvas { max-width: 100%; }
    @media (prefers-color-scheme: light) { body { background: #f8f6f3; color: #24211e; } }
  </style>
</head>
<body>${source}</body>
</html>`;
}

/**
 * Sanitise an SVG document, keeping the DOM rather than re-parsing a serialised string.
 *
 * This used to hand DOMPurify's output back to `DOMParser` as `image/svg+xml`, which quietly
 * discarded most real diagrams. DOMPurify parses as HTML and serialises with the HTML serialiser,
 * and that serialiser writes U+00A0 as `&nbsp;`. XML predefines exactly five named entities, so
 * re-parsing hit "undefined entity" and the whole graph was dropped. Graphviz emits `&#160;` for
 * every leading or trailing space in a label -- ordinary padding like `label="  stage  "` -- so a
 * single padded label anywhere was enough to lose the diagram. Three of the four graphs in local
 * session history failed this way.
 *
 * Taking `RETURN_DOM` skips the lossy round trip entirely. The sanitiser configuration is
 * unchanged, so the same tags and attributes are stripped; only the handoff differs.
 */
export function sanitizeVisualSvg(source: string): string {
  const svgSource = extractSvgDocument(source);
  if (!svgSource) return "";
  const sanitizedRoot = DOMPurify.sanitize(svgSource, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "style", "foreignObject", "a", "image", "use"],
    FORBID_ATTR: ["href", "xlink:href", "style", "onload", "onclick"],
    RETURN_DOM: true,
  });
  // RETURN_DOM hands back the containing element; DOMPurify types it as the wider Node.
  const svg = sanitizedRoot instanceof Element ? sanitizedRoot.firstElementChild : null;
  if (!svg || svg.tagName.toLowerCase() !== "svg" || svg.nextElementSibling) return "";
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", visualArtifactTitle("svg", source));
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  return new XMLSerializer().serializeToString(svg);
}

export async function renderDotArtifact(source: string): Promise<DotArtifactResult> {
  let raw: string;
  try {
    raw = await renderGraphvizSvg(source);
  } catch (error) {
    console.error("DOT artifact: Graphviz failed", error);
    const detail = error instanceof Error ? error.message : String(error);
    return { svg: "", error: isEngineFailure(detail) ? `the diagram engine could not start (${detail})` : `Graphviz rejected it (${detail})` };
  }
  const svg = sanitizeVisualSvg(raw);
  if (svg) return { svg };
  console.error("DOT artifact: sanitizer produced no SVG", raw.slice(0, 500));
  return { svg: "", error: raw.includes("<svg") ? "its SVG output was rejected by the sanitizer." : "Graphviz returned no SVG for this graph." };
}

export function dotArtifactFailureMessage(result?: DotArtifactResult, resourceError?: unknown): string {
  if (result?.error) return `This DOT graph could not be rendered: ${result.error}`;
  if (resourceError !== undefined && resourceError !== null) {
    const detail = resourceError instanceof Error ? resourceError.message : String(resourceError);
    return `This DOT graph could not be rendered: the diagram engine failed (${detail.replace(/^Error:\s*/, "")}).`;
  }
  return "This DOT graph did not finish loading. Retry the diagram or open Source to inspect it.";
}

export function dotArtifactIsPending(loading: boolean, state: string): boolean {
  return loading || state === "unresolved";
}

function isEngineFailure(detail: string): boolean {
  return /wasm|webassembly|dynamically imported module|failed to fetch|importing a module script/i.test(detail);
}

export function visualArtifactTitle(format: VisualArtifactFormat, source: string): string {
  if (format === "html") {
    const match = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    return match ? stripMarkup(match[1]).slice(0, 100) || "HTML visual" : "HTML visual";
  }
  if (format === "svg") {
    const match = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? stripMarkup(match[1]).slice(0, 100) || "SVG visual" : "SVG visual";
  }
  const match = source.match(/(?:di)?graph\s+(?:"([^"]+)"|([A-Za-z_][\w-]*))/i);
  return (match?.[1] || match?.[2] || "DOT diagram").slice(0, 100);
}

function artifactFormatLabel(format: VisualArtifactFormat): string {
  return format === "html" ? "RENDERED HTML" : format === "svg" ? "INLINE SVG" : "GRAPHVIZ DOT";
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

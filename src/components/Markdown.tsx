import DOMPurify from "dompurify";
import { marked } from "marked";
import { createMemo, For, Show } from "solid-js";
import type { InlineVisualArtifact } from "../protocol";
import { VisualArtifact, type VisualArtifactFormat } from "./VisualArtifact";

interface Props {
  text: string;
  class?: string;
  compact?: boolean;
  onVisualArtifact?: (artifact: InlineVisualArtifact) => void;
}

marked.use({
  gfm: true,
  breaks: false,
});

export function Markdown(props: Props) {
  const html = createMemo(() => renderMarkdown(props.text));
  const segments = createMemo(() => extractVisualSegments(props.text));
  const hasArtifacts = createMemo(() => segments().some((segment) => segment.kind !== "markdown"));
  return (
    <Show
      when={hasArtifacts()}
      fallback={
        <div
          class={`markdown ${props.compact ? "markdown-compact" : ""} ${props.class || ""}`.trim()}
          innerHTML={html()}
        />
      }
    >
      <div class={`markdown markdown-artifact-document ${props.compact ? "markdown-compact" : ""} ${props.class || ""}`.trim()}>
        <For each={segments()}>{(segment) => (
          <Show when={segment.kind !== "markdown"} fallback={<div class="markdown-fragment" innerHTML={renderMarkdown(segment.source)} />}>
            <Show
              when={segment.kind === "artifact" ? segment : undefined}
              keyed
              fallback={<PendingVisualArtifact format={segment.kind === "pending-artifact" ? segment.format : "html"} source={segment.source} />}
            >
              {(artifact) => <VisualArtifact format={artifact.format} source={artifact.source} onReady={props.onVisualArtifact} />}
            </Show>
          </Show>
        )}</For>
      </div>
    </Show>
  );
}

export type MarkdownVisualSegment =
  | { kind: "markdown"; source: string }
  | { kind: "artifact"; format: VisualArtifactFormat; source: string }
  | { kind: "pending-artifact"; format: VisualArtifactFormat; source: string };

const VISUAL_FENCE = /```amplifier-(html|svg|dot)[^\n]*\n([\s\S]*?)```/gi;

export function extractVisualSegments(source: string): MarkdownVisualSegment[] {
  const segments: MarkdownVisualSegment[] = [];
  let cursor = 0;
  for (const match of (source || "").matchAll(VISUAL_FENCE)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: "markdown", source: source.slice(cursor, index) });
    segments.push({ kind: "artifact", format: match[1].toLowerCase() as VisualArtifactFormat, source: match[2].trim() });
    cursor = index + match[0].length;
  }
  if (cursor < source.length) {
    const tail = source.slice(cursor);
    const pending = tail.match(/```amplifier-(html|svg|dot)[^\n]*\n([\s\S]*)$/i);
    if (pending?.index !== undefined) {
      if (pending.index > 0) segments.push({ kind: "markdown", source: tail.slice(0, pending.index) });
      segments.push({
        kind: "pending-artifact",
        format: pending[1].toLowerCase() as VisualArtifactFormat,
        source: pending[2],
      });
    } else {
      segments.push({ kind: "markdown", source: tail });
    }
  }
  return segments.length ? segments : [{ kind: "markdown", source: source || "" }];
}

function PendingVisualArtifact(props: { format: VisualArtifactFormat; source: string }) {
  const lines = () => props.source ? props.source.split("\n").length : 0;
  return (
    <section class="visual-artifact visual-artifact-pending" role="status" aria-live="polite">
      <div class="visual-artifact-building-mark" aria-hidden="true"><i /><i /><i /></div>
      <div>
        <span>BUILDING {props.format === "html" ? "INTERACTIVE VISUAL" : props.format === "svg" ? "SVG VISUAL" : "DOT DIAGRAM"}</span>
        <strong>Composing the presentation…</strong>
        <small>{lines()} line{lines() === 1 ? "" : "s"} received · preview appears when complete</small>
      </div>
    </section>
  );
}

export function renderMarkdown(source: string): string {
  const parsed = marked.parse(source || "", { async: false }) as string;
  const sanitized = DOMPurify.sanitize(parsed, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "option"],
    FORBID_ATTR: ["style"],
  });
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  // Agent output is untrusted: a model that reads a hostile repo can be prompt-injected. Keeping
  // `class`/`role` let it reuse Studio's own chrome classes (fatal-card, user-avatar, ...) and
  // render convincing fake UI inside the transcript. Only syntax-highlight hooks survive.
  template.content.querySelectorAll("[class], [role]").forEach((element) => {
    const className = element.getAttribute("class");
    const preserved = (className || "")
      .split(/\s+/)
      .filter((name) => /^language-[\w+-]+$/.test(name));
    if (preserved.length > 0) element.setAttribute("class", preserved.join(" "));
    else element.removeAttribute("class");
    element.removeAttribute("role");
  });
  template.content.querySelectorAll("img").forEach((image) => {
    const reference = document.createElement("span");
    reference.className = "markdown-image-reference";
    reference.textContent = `Image reference · ${image.getAttribute("alt") || image.getAttribute("src") || "unnamed image"}`;
    image.replaceWith(reference);
  });
  template.content.querySelectorAll("a[href]").forEach((link) => {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  });
  return template.innerHTML;
}

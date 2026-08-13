import DOMPurify from "dompurify";
import { marked } from "marked";
import { createMemo, For, Show } from "solid-js";
import { VisualArtifact, type VisualArtifactFormat } from "./VisualArtifact";

interface Props {
  text: string;
  class?: string;
  compact?: boolean;
}

marked.use({
  gfm: true,
  breaks: false,
});

export function Markdown(props: Props) {
  const html = createMemo(() => renderMarkdown(props.text));
  const segments = createMemo(() => extractVisualSegments(props.text));
  const hasArtifacts = createMemo(() => segments().some((segment) => segment.kind === "artifact"));
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
          <Show
            when={segment.kind === "artifact" ? segment : undefined}
            keyed
            fallback={<div class="markdown-fragment" innerHTML={renderMarkdown(segment.source)} />}
          >
            {(artifact) => <VisualArtifact format={artifact.format} source={artifact.source} />}
          </Show>
        )}</For>
      </div>
    </Show>
  );
}

export type MarkdownVisualSegment =
  | { kind: "markdown"; source: string }
  | { kind: "artifact"; format: VisualArtifactFormat; source: string };

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
  if (cursor < source.length) segments.push({ kind: "markdown", source: source.slice(cursor) });
  return segments.length ? segments : [{ kind: "markdown", source: source || "" }];
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

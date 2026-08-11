import DOMPurify from "dompurify";
import { marked } from "marked";
import { createMemo } from "solid-js";

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
  return (
    <div
      class={`markdown ${props.compact ? "markdown-compact" : ""} ${props.class || ""}`.trim()}
      innerHTML={html()}
    />
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

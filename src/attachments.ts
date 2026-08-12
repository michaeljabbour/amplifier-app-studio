import type {
  ComposerAttachment,
  ComposerDocumentAttachment,
  ComposerImageAttachment,
} from "./protocol";

export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_IMAGE_COUNT = 4;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 200_000;
export const MAX_DOCUMENT_TOTAL_CHARS = 300_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml", "toml", "xml", "html", "htm",
  "css", "scss", "less", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go", "java", "kt", "swift",
  "c", "cc", "cpp", "h", "hpp", "sh", "bash", "zsh", "fish", "ps1", "log", "sql", "rtf", "env", "ini", "cfg",
  "conf", "properties", "dockerfile", "gitignore",
]);

const BINARY_DOCUMENT_EXTENSIONS = new Set(["pdf", "docx"]);
const DOCUMENT_START = "<<<AMPLIFIER_STUDIO_DOCUMENT ";
const DOCUMENT_END = "<<<END_AMPLIFIER_STUDIO_DOCUMENT ";
const ATTACHMENT_SECTION = "\n\n<<<AMPLIFIER_STUDIO_ATTACHMENTS>>>\n";
const ATTACHMENT_SECTION_END = "<<<END_AMPLIFIER_STUDIO_ATTACHMENTS>>>";

export function hasAttachmentFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes("Files");
}

export function isSupportedBrowserFile(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.has(file.type) || isTextDocument(file.name, file.type);
}

export async function appendAttachmentFiles(
  existing: ComposerAttachment[],
  files: File[],
): Promise<ComposerAttachment[]> {
  if (!files.length) throw new Error("Drop an image, PDF, Word document, or text/code file.");
  const unsupported = files.find((file) => !SUPPORTED_IMAGE_TYPES.has(file.type) && !isDocumentName(file.name));
  if (unsupported) throw new Error(`${unsupported.name || "This file"} is not a supported image or document.`);
  const added = await Promise.all(files.map(toComposerAttachment));
  return appendComposerAttachments(existing, added);
}

export function appendComposerAttachments(
  existing: ComposerAttachment[],
  added: ComposerAttachment[],
): ComposerAttachment[] {
  const all = [...existing, ...added];
  if (all.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`Attach up to ${MAX_ATTACHMENT_COUNT} files per turn.`);
  }
  const images = all.filter((item): item is ComposerImageAttachment => item.kind === "image");
  if (images.length > MAX_IMAGE_COUNT) throw new Error(`Attach up to ${MAX_IMAGE_COUNT} images per turn.`);
  if (images.some((image) => image.size === 0 || image.size > MAX_IMAGE_BYTES || !SUPPORTED_IMAGE_TYPES.has(image.mediaType))) {
    throw new Error("Each image must be a supported, non-empty file no larger than 20 MB.");
  }
  if (images.reduce((sum, image) => sum + image.size, 0) > MAX_IMAGE_TOTAL_BYTES) {
    throw new Error("Image attachments can total up to 32 MB per turn.");
  }
  const documents = all.filter((item): item is ComposerDocumentAttachment => item.kind === "document");
  if (documents.some((document) => document.size === 0 || document.size > MAX_DOCUMENT_BYTES || !document.text.trim())) {
    throw new Error("Each document must contain readable text and be no larger than 20 MB.");
  }
  if (documents.reduce((sum, document) => sum + document.text.length, 0) > MAX_DOCUMENT_TOTAL_CHARS) {
    throw new Error("Document attachments can contain up to 300,000 extracted characters per turn.");
  }
  return all;
}

export function imageAttachments(attachments: ComposerAttachment[]): ComposerImageAttachment[] {
  return attachments.filter((item): item is ComposerImageAttachment => item.kind === "image");
}

export function documentAttachments(attachments: ComposerAttachment[]): ComposerDocumentAttachment[] {
  return attachments.filter((item): item is ComposerDocumentAttachment => item.kind === "document");
}

export function promptWithDocumentAttachments(text: string, attachments: ComposerAttachment[]): string {
  const documents = documentAttachments(attachments);
  if (!documents.length) return text;
  const encoded = documents.map((document) => {
    const metadata = JSON.stringify({
      id: document.id,
      name: document.name,
      mediaType: document.mediaType,
      size: document.size,
      truncated: document.truncated,
    });
    return `${DOCUMENT_START}${metadata}>>>\n${document.text}\n${DOCUMENT_END}${document.id}>>>`;
  }).join("\n");
  return `${text.trim()}${ATTACHMENT_SECTION}${encoded}\n${ATTACHMENT_SECTION_END}`;
}

export function splitDocumentAttachments(text: string): { text: string; attachments: ComposerDocumentAttachment[] } {
  const sectionStart = text.lastIndexOf(ATTACHMENT_SECTION);
  if (sectionStart < 0 || !text.endsWith(ATTACHMENT_SECTION_END)) return { text, attachments: [] };
  const bodyStart = sectionStart + ATTACHMENT_SECTION.length;
  const body = text.slice(bodyStart, -ATTACHMENT_SECTION_END.length).trimEnd();
  const attachments: ComposerDocumentAttachment[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(DOCUMENT_START, cursor);
    if (start < 0) break;
    const headerEnd = body.indexOf(">>>\n", start + DOCUMENT_START.length);
    if (headerEnd < 0) return { text, attachments: [] };
    let metadata: unknown;
    try {
      metadata = JSON.parse(body.slice(start + DOCUMENT_START.length, headerEnd));
    } catch {
      return { text, attachments: [] };
    }
    if (!isDocumentMetadata(metadata)) return { text, attachments: [] };
    const endMarker = `\n${DOCUMENT_END}${metadata.id}>>>`;
    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(endMarker, contentStart);
    if (contentEnd < 0) return { text, attachments: [] };
    attachments.push({ kind: "document", ...metadata, text: body.slice(contentStart, contentEnd) });
    cursor = contentEnd + endMarker.length;
  }
  if (!attachments.length) return { text, attachments: [] };
  return { text: text.slice(0, sectionStart).trimEnd(), attachments };
}

export function formatAttachmentBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function attachmentKindLabel(attachment: ComposerAttachment): string {
  if (attachment.kind === "image") return "IMAGE";
  const extension = extensionOf(attachment.name);
  return (extension || "DOC").slice(0, 5).toUpperCase();
}

async function toComposerAttachment(file: File, index: number): Promise<ComposerAttachment> {
  const id = globalThis.crypto?.randomUUID?.() || `attachment-${Date.now()}-${index}`;
  if (SUPPORTED_IMAGE_TYPES.has(file.type)) {
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      throw new Error("Each image must be non-empty and no larger than 20 MB.");
    }
    return {
      kind: "image",
      id,
      name: file.name || `Image ${index + 1}`,
      mediaType: file.type as ComposerImageAttachment["mediaType"],
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      size: file.size,
    };
  }
  if (BINARY_DOCUMENT_EXTENSIONS.has(extensionOf(file.name))) {
    throw new Error("PDF and Word extraction requires the native Amplifier Studio app.");
  }
  if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) {
    throw new Error("Each document must be non-empty and no larger than 20 MB.");
  }
  const fullText = await file.text();
  if (!fullText.trim()) throw new Error(`${file.name || "This document"} does not contain readable text.`);
  const truncated = fullText.length > MAX_DOCUMENT_CHARS;
  return {
    kind: "document",
    id,
    name: file.name || `Document ${index + 1}`,
    mediaType: file.type || mediaTypeForName(file.name),
    text: truncated
      ? `${fullText.slice(0, MAX_DOCUMENT_CHARS)}\n\n[Amplifier Studio truncated this attachment after ${MAX_DOCUMENT_CHARS.toLocaleString()} characters.]`
      : fullText,
    size: file.size,
    truncated,
  };
}

function isDocumentName(name: string): boolean {
  const extension = extensionOf(name);
  return TEXT_EXTENSIONS.has(extension) || BINARY_DOCUMENT_EXTENSIONS.has(extension);
}

function isTextDocument(name: string, mediaType: string): boolean {
  return mediaType.startsWith("text/") || TEXT_EXTENSIONS.has(extensionOf(name));
}

function mediaTypeForName(name: string): string {
  const extension = extensionOf(name);
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "json" || extension === "jsonl") return "application/json";
  if (extension === "csv") return "text/csv";
  if (extension === "html" || extension === "htm") return "text/html";
  if (extension === "xml") return "application/xml";
  return "text/plain";
}

function extensionOf(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === "dockerfile" || normalized === ".gitignore") return normalized.replace(/^\./, "");
  const index = normalized.lastIndexOf(".");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function isDocumentMetadata(value: unknown): value is Omit<ComposerDocumentAttachment, "kind" | "text"> {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return typeof metadata.id === "string"
    && typeof metadata.name === "string"
    && typeof metadata.mediaType === "string"
    && typeof metadata.size === "number"
    && typeof metadata.truncated === "boolean";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

import type { InlineVisualArtifact } from "./protocol";
import { savePngFile } from "./nativePickers";

const MAX_RASTER_EDGE = 8_192;
const MAX_RASTER_PIXELS = 40_000_000;

export function inlineVisualId(format: "svg" | "dot", source: string): string {
  // FNV-1a keeps the ID deterministic across replay without retaining a second
  // copy of the whole source in a DOM key. Length makes accidental short-input
  // collisions still less likely.
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `inline-visual:${format}:${(hash >>> 0).toString(16).padStart(8, "0")}:${source.length}`;
}

export function visualPngName(title: string): string {
  const stem = title
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._ -]+/g, "")
    .trim()
    .replace(/[ .]+$/g, "")
    .slice(0, 120) || "Amplifier diagram";
  return `${stem.replace(/\.png$/i, "")}.png`;
}

export async function saveInlineVisualPng(artifact: InlineVisualArtifact): Promise<string | undefined> {
  return savePngFile(visualPngName(artifact.title), await svgToPngBlob(artifact.svg));
}

export async function svgToPngBlob(svg: string): Promise<Blob> {
  if (!svg.trim().startsWith("<svg")) throw new Error("The diagram has no exportable SVG render.");
  const dimensions = svgRasterDimensions(svg);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This WebView cannot create a PNG canvas.");
    // Graphviz commonly uses a transparent page; give saved diagrams an
    // opaque white ground so Finder/Preview and documents remain legible.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The WebView could not encode this diagram as PNG.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function svgRasterDimensions(svg: string): { width: number; height: number } {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (root.tagName.toLowerCase() !== "svg" || document.querySelector("parsererror")) {
    throw new Error("The diagram SVG is not valid XML.");
  }
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const width = numericSvgLength(root.getAttribute("width"))
    || (viewBox?.length === 4 && Number.isFinite(viewBox[2]) ? Math.abs(viewBox[2]!) : 0)
    || 1_200;
  const height = numericSvgLength(root.getAttribute("height"))
    || (viewBox?.length === 4 && Number.isFinite(viewBox[3]) ? Math.abs(viewBox[3]!) : 0)
    || 800;
  const scale = Math.min(2, MAX_RASTER_EDGE / Math.max(width, height), Math.sqrt(MAX_RASTER_PIXELS / (width * height)));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function numericSvgLength(value: string | null): number {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The WebView could not rasterize this diagram."));
    image.src = url;
  });
}

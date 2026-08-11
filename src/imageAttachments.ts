import type { ComposerImage } from "./protocol";

export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGE_COUNT = 4;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 32 * 1024 * 1024;

export function hasImageFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes("Files");
}

export async function appendImageFiles(existing: ComposerImage[], files: File[]): Promise<ComposerImage[]> {
  const candidates = files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
  if (!candidates.length) throw new Error("Drop a PNG, JPEG, GIF, or WebP image.");
  if (candidates.length !== files.length) throw new Error("Only PNG, JPEG, GIF, and WebP files can be attached.");
  if (candidates.some((file) => file.size === 0 || file.size > MAX_IMAGE_BYTES)) {
    throw new Error("Each image must be non-empty and no larger than 20 MB.");
  }
  const added = await Promise.all(candidates.map(toComposerImage));
  return appendComposerImages(existing, added);
}

export function appendComposerImages(existing: ComposerImage[], added: ComposerImage[]): ComposerImage[] {
  if (existing.length + added.length > MAX_IMAGE_COUNT) throw new Error(`Attach up to ${MAX_IMAGE_COUNT} images per turn.`);
  if (added.some((image) => image.size === 0 || image.size > MAX_IMAGE_BYTES || !SUPPORTED_IMAGE_TYPES.has(image.mediaType))) {
    throw new Error("Each image must be a supported, non-empty file no larger than 20 MB.");
  }
  const total = [...existing, ...added].reduce((sum, image) => sum + image.size, 0);
  if (total > MAX_IMAGE_TOTAL_BYTES) throw new Error("Image attachments can total up to 32 MB per turn.");
  return [...existing, ...added];
}

export function formatImageBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function toComposerImage(file: File, index: number): Promise<ComposerImage> {
  const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  return {
    id: globalThis.crypto?.randomUUID?.() || `image-${Date.now()}-${index}`,
    name: file.name || `Image ${index + 1}`,
    mediaType: file.type as ComposerImage["mediaType"],
    data,
    size: file.size,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

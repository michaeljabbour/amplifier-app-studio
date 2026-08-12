import { describe, expect, it } from "vitest";
import {
  appendAttachmentFiles,
  appendComposerAttachments,
  promptWithDocumentAttachments,
  splitDocumentAttachments,
} from "./attachments";

function testFile(name: string, type: string, bytes: number[]): File {
  const body = Uint8Array.from(bytes);
  return {
    name,
    type,
    size: body.byteLength,
    arrayBuffer: async () => body.buffer,
    text: async () => new TextDecoder().decode(body),
  } as File;
}

describe("file attachments", () => {
  it("encodes supported images for the typed runtime wire payload", async () => {
    const [image] = await appendAttachmentFiles([], [testFile("diagram.png", "image/png", [137, 80, 78, 71])]);

    expect(image).toMatchObject({
      kind: "image",
      name: "diagram.png",
      mediaType: "image/png",
      data: "iVBORw==",
      size: 4,
    });
  });

  it("extracts browser text files into visible document attachments", async () => {
    const [document] = await appendAttachmentFiles([], [testFile("notes.md", "text/markdown", [35, 32, 78, 111, 116, 101, 115])]);
    expect(document).toMatchObject({
      kind: "document",
      name: "notes.md",
      mediaType: "text/markdown",
      text: "# Notes",
      truncated: false,
    });
  });

  it("rejects unsupported or excessive attachments before sending", async () => {
    await expect(appendAttachmentFiles([], [testFile("archive.zip", "application/zip", [1])]))
      .rejects.toThrow("not a supported image or document");
    await expect(appendAttachmentFiles([], Array.from({ length: 5 }, (_, index) => testFile(`${index}.png`, "image/png", [1]))))
      .rejects.toThrow("up to 4 images");
  });

  it("applies turn limits to native image payloads", () => {
    const image = {
      kind: "image" as const,
      id: "native-1",
      name: "diagram.png",
      mediaType: "image/png" as const,
      data: "iVBORw0KGgo=",
      size: 20 * 1024 * 1024,
    };
    expect(appendComposerAttachments([], [image])).toEqual([image]);
    expect(() => appendComposerAttachments([image], [{ ...image, id: "native-2", size: 13 * 1024 * 1024 }]))
      .toThrow("32 MB");
  });

  it("round-trips document context without exposing its body as chat text", () => {
    const document = {
      kind: "document" as const,
      id: "doc-1",
      name: "plan.md",
      mediaType: "text/markdown",
      text: "# Project plan\n\nShip it.",
      size: 24,
      truncated: false,
    };
    const runtimeText = promptWithDocumentAttachments("Review this", [document]);
    const decoded = splitDocumentAttachments(runtimeText);
    expect(decoded.text).toBe("Review this");
    expect(decoded.attachments).toEqual([document]);
  });
});

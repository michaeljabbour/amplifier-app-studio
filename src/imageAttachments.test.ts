import { describe, expect, it } from "vitest";
import { appendComposerImages, appendImageFiles } from "./imageAttachments";

function imageFile(name: string, type: string, bytes: number[]): File {
  const body = Uint8Array.from(bytes);
  return {
    name,
    type,
    size: body.byteLength,
    arrayBuffer: async () => body.buffer,
  } as File;
}

describe("image attachments", () => {
  it("encodes supported files for the runtime wire payload", async () => {
    const [image] = await appendImageFiles([], [imageFile("diagram.png", "image/png", [137, 80, 78, 71])]);

    expect(image).toMatchObject({
      name: "diagram.png",
      mediaType: "image/png",
      data: "iVBORw==",
      size: 4,
    });
  });

  it("rejects unsupported or excessive attachments before reading them", async () => {
    await expect(appendImageFiles([], [imageFile("notes.txt", "text/plain", [1])]))
      .rejects.toThrow("PNG, JPEG, GIF, or WebP");
    await expect(appendImageFiles([], Array.from({ length: 5 }, (_, index) => imageFile(`${index}.png`, "image/png", [1]))))
      .rejects.toThrow("up to 4 images");
  });

  it("applies turn limits to native image payloads", () => {
    const image = {
      id: "native-1",
      name: "diagram.png",
      mediaType: "image/png" as const,
      data: "iVBORw0KGgo=",
      size: 20 * 1024 * 1024,
    };
    expect(appendComposerImages([], [image])).toEqual([image]);
    expect(() => appendComposerImages([image], [{ ...image, id: "native-2", size: 13 * 1024 * 1024 }]))
      .toThrow("32 MB");
  });
});

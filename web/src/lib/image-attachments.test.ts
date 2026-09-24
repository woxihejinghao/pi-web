import { describe, expect, it } from "vitest";
import { translator } from "./i18n/index.ts";

const zh = translator("zh-CN");
const refusalNotice = (
  refusals: Parameters<typeof refusalNoticeOf>[0],
  overflow: number,
): ReturnType<typeof refusalNoticeOf> => refusalNoticeOf(refusals, overflow, zh);
import {
  MAX_IMAGES_PER_MESSAGE,
  addImages,
  imageBlocksOf,
  imageDataUrl,
  isAcceptedImageType,
  isImageBlock,
  refusalNotice as refusalNoticeOf,
} from "./image-attachments.ts";
import type { ContentBlock, ImageBlock } from "./types.ts";

function image(data: string, mimeType = "image/png"): ImageBlock {
  return { type: "image", data, mimeType };
}

describe("isImageBlock", () => {
  it("accepts a well-formed image block", () => {
    expect(isImageBlock({ type: "image", data: "AAAA", mimeType: "image/png" })).toBe(true);
  });

  it("rejects blocks an older session file may have left half-written", () => {
    // The transcript comes off disk, so the check is structural rather than a
    // cast: an empty `data` would render as a broken <img>.
    expect(isImageBlock({ type: "image", data: "", mimeType: "image/png" })).toBe(false);
    expect(isImageBlock({ type: "image", data: "AAAA" })).toBe(false);
    expect(isImageBlock({ type: "image", mimeType: "image/png" })).toBe(false);
    expect(isImageBlock({ type: "text", text: "hi" })).toBe(false);
    expect(isImageBlock(null)).toBe(false);
  });
});

describe("imageBlocksOf", () => {
  it("returns nothing for a text-only message", () => {
    expect(imageBlocksOf("hello")).toEqual([]);
  });

  it("picks the images out of a mixed block array, in order", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "看这两张" },
      image("one"),
      { type: "toolCall", id: "t1", name: "read" },
      image("two", "image/jpeg"),
    ];
    expect(imageBlocksOf(content).map((block) => block.data)).toEqual(["one", "two"]);
  });
});

describe("imageDataUrl", () => {
  it("adds the prefix the <img> needs and nothing else", () => {
    expect(imageDataUrl(image("AAAA", "image/webp"))).toBe("data:image/webp;base64,AAAA");
  });
});

describe("isAcceptedImageType", () => {
  it("takes the formats every provider reads", () => {
    expect(isAcceptedImageType("image/png")).toBe(true);
    expect(isAcceptedImageType("image/jpeg")).toBe(true);
    expect(isAcceptedImageType("image/webp")).toBe(true);
    expect(isAcceptedImageType("image/gif")).toBe(true);
  });

  it("refuses everything else, including svg and non-images", () => {
    expect(isAcceptedImageType("image/svg+xml")).toBe(false);
    expect(isAcceptedImageType("application/pdf")).toBe(false);
    expect(isAcceptedImageType("")).toBe(false);
  });
});

describe("addImages", () => {
  it("appends what fits and reports the rest", () => {
    const current = [image("a"), image("b")];
    const { images, overflow } = addImages(current, [image("c")]);
    expect(images.map((block) => block.data)).toEqual(["a", "b", "c"]);
    expect(overflow).toBe(0);
  });

  it("stops at the ceiling without dropping what is already there", () => {
    const current = Array.from({ length: MAX_IMAGES_PER_MESSAGE - 1 }, (_, i) => image(`e${String(i)}`));
    const { images, overflow } = addImages(current, [image("first"), image("second")]);
    expect(images).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(images.at(-1)?.data).toBe("first");
    expect(overflow).toBe(1);
  });

  it("is a no-op when the draft is already full", () => {
    const current = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, i) => image(`e${String(i)}`));
    const { images, overflow } = addImages(current, [image("x"), image("y")]);
    expect(images).toEqual(current);
    expect(overflow).toBe(2);
  });
});

describe("refusalNotice", () => {
  it("is silent when nothing was refused", () => {
    expect(refusalNotice([], 0)).toBeNull();
  });

  it("names the files and the reason for each", () => {
    expect(refusalNotice([{ name: "a.pdf", reason: "不支持的格式 application/pdf" }], 0)).toBe(
      "a.pdf：不支持的格式 application/pdf",
    );
  });

  it("counts the overflow separately from the refusals", () => {
    expect(refusalNotice([], 2)).toBe(`2 张超出 ${String(MAX_IMAGES_PER_MESSAGE)} 张上限`);
  });

  it("joins both kinds into one line", () => {
    expect(refusalNotice([{ name: "a.svg", reason: "不支持的格式 image/svg+xml" }], 1)).toBe(
      `a.svg：不支持的格式 image/svg+xml；1 张超出 ${String(MAX_IMAGES_PER_MESSAGE)} 张上限`,
    );
  });
});

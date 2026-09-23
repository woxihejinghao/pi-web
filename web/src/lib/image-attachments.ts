import type { ContentBlock, ImageBlock } from "./types.ts";

/**
 * Images, in the one shape every layer already agrees on.
 *
 * pi calls it `ImageContent { type, data, mimeType }`: bare base64, no `data:`
 * prefix. The same object is what the model receives, what the RPC layer
 * serializes, and what a session file stores — so nothing here converts
 * anything. An image read off the clipboard is an `ImageBlock`, goes out as
 * one, and comes back after a reload as the identical object. The only
 * conversion that ever happens is to a `data:` URL, and that lives at the
 * single point of rendering (see `imageDataUrl`).
 *
 * The file reads use `FileReader`, so this module is browser-only; the
 * decisions around them are pure so they can be tested without a DOM.
 */

/** Every image in one message's content, in order. */
export function imageBlocksOf(content: string | ContentBlock[]): ImageBlock[] {
  if (typeof content === "string") return [];
  return content.filter(isImageBlock);
}

/**
 * A structural check rather than a `type` comparison.
 *
 * The transcript arrives from a session file that any version of pi may have
 * written, so an image block is only worth rendering if it actually carries the
 * two strings the `<img>` needs. A half-written block is skipped instead of
 * producing a broken element.
 */
export function isImageBlock(value: unknown): value is ImageBlock {
  if (typeof value !== "object" || value === null) return false;
  const block = value as { type?: unknown; data?: unknown; mimeType?: unknown };
  return (
    block.type === "image" &&
    typeof block.data === "string" &&
    block.data.length > 0 &&
    typeof block.mimeType === "string"
  );
}

/**
 * What a provider will accept.
 *
 * Not a browser-wide list: pi forwards these to the model untouched, and a
 * format no provider decodes would turn a successful prompt into an API error.
 * GIF and WebP are on it because the major providers read both; SVG is not,
 * because it is a document (and a script host) rather than a picture, and the
 * providers that do take it are the exception.
 */
export const ACCEPTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** Ceiling for one image, measured on the encoded file the browser handed over. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * How many images one message may carry.
 *
 * The ceiling is what keeps a paste of a whole folder from becoming a request
 * no model will take — and a prompt that fails at the API is a worse answer
 * than one the input refuses up front.
 */
export const MAX_IMAGES_PER_MESSAGE = 8;

export function isAcceptedImageType(mimeType: string): boolean {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** The `src` for an image block. The only place the prefix is ever added. */
export function imageDataUrl(image: ImageBlock): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** Why an image was refused, in the words the composer shows. */
export interface ImageRefusal {
  name: string;
  reason: string;
}

export interface ImageReadResult {
  image: ImageBlock | null;
  refusal: ImageRefusal | null;
}

/**
 * Read one clipboard or dropped file into an `ImageBlock`.
 *
 * A refusal is an answer, not a throw: dropping five files where one is a PDF
 * should attach the four images, and the caller needs to know which one was
 * left out and why. Read failures (a revoked file handle, say) answer the same
 * way rather than rejecting, so one bad file cannot abort a paste.
 */
export async function readImageFile(file: File): Promise<ImageReadResult> {
  const name = file.name.length > 0 ? file.name : "图片";
  if (!isAcceptedImageType(file.type)) {
    return {
      image: null,
      refusal: { name, reason: file.type.length > 0 ? `不支持的格式 ${file.type}` : "不是图片文件" },
    };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { image: null, refusal: { name, reason: `超过 ${megabytes(MAX_IMAGE_BYTES)}MB` } };
  }
  try {
    const url = await readAsDataUrl(file);
    const comma = url.indexOf(",");
    if (comma < 0) return { image: null, refusal: { name, reason: "读取失败" } };
    return { image: { type: "image", data: url.slice(comma + 1), mimeType: file.type }, refusal: null };
  } catch {
    return { image: null, refusal: { name, reason: "读取失败" } };
  }
}

/**
 * Merge freshly read images into the draft, stopping at the ceiling.
 *
 * Overflow is reported as a count rather than per image: past the ceiling the
 * composer is simply full, and naming the tenth screenshot adds nothing the
 * user needs to decide what to do next. Duplicates are kept — two identical
 * screenshots of two different states is a normal paste, and de-duplicating by
 * bytes would silently drop one of them.
 */
export function addImages(
  current: ImageBlock[],
  incoming: ImageBlock[],
): { images: ImageBlock[]; overflow: number } {
  const room = Math.max(0, MAX_IMAGES_PER_MESSAGE - current.length);
  const accepted = incoming.slice(0, room);
  return { images: [...current, ...accepted], overflow: incoming.length - accepted.length };
}

/** One line for the composer's refusal notice. */export function refusalNotice(refusals: ImageRefusal[], overflow: number): string | null {
  const parts = refusals.map((refusal) => `${refusal.name}：${refusal.reason}`);
  if (overflow > 0) parts.push(`${String(overflow)} 张超出 ${String(MAX_IMAGES_PER_MESSAGE)} 张上限`);
  return parts.length > 0 ? parts.join("；") : null;
}

/**
 * The image files carried by a paste or a drop.
 *
 * `items` is the only place a clipboard screenshot reliably shows up: macOS puts
 * the PNG there and leaves `files` empty, so a reader that only looks at
 * `dataTransfer.files` sees a paste that "did nothing". The `files` list is
 * still the fallback, because a drop of a Finder selection is exactly the
 * opposite — present there and absent from `items` in some browsers.
 */
export function imageFilesFrom(data: DataTransfer): File[] {
  const fromItems: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file !== null) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("read failed"));
    };
    reader.readAsDataURL(file);
  });
}

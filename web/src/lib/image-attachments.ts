import type { ContentBlock, ImageBlock } from "./types.ts";
import type { Translate } from "./i18n/index.ts";

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
 * Longest edge an image keeps before it is scaled down.
 *
 * 1568px is what the major providers downsample to anyway, so anything larger
 * is bytes spent on detail the model never sees. It is also the right ceiling
 * for what a session file has to carry: images live inline in the JSONL as
 * base64, and every later read of that session drags them along.
 */
export const MAX_IMAGE_DIMENSION = 1568;

/**
 * Quality for the lossy re-encode. High enough that UI text in a screenshot
 * stays crisp, low enough to undo the bloat of an untended phone photo.
 */
export const IMAGE_QUALITY = 0.82;

/**
 * Under this size, and already inside `MAX_IMAGE_DIMENSION`, an image is left
 * alone — re-encoding a small file only trades quality for noise.
 */
export const REENCODE_THRESHOLD_BYTES = 512 * 1024;

/**
 * How much an image has to shrink so its longest edge fits `max`.
 *
 * Never enlarges — an image already inside the bound keeps scale 1 — and treats
 * a zero dimension as nothing to do, so a decoded frame without a size cannot
 * produce a divide-by-zero canvas.
 */
export function fitScale(width: number, height: number, max = MAX_IMAGE_DIMENSION): number {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) return 1;
  return max / longest;
}

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
export async function readImageFile(file: File, t: Translate): Promise<ImageReadResult> {
  const name = file.name.length > 0 ? file.name : t("attach.nameFallback");
  if (!isAcceptedImageType(file.type)) {
    return {
      image: null,
      refusal: {
        name,
        reason:
          file.type.length > 0
            ? t("attach.unsupportedType", { type: file.type })
            : t("attach.notAnImage"),
      },
    };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      image: null,
      refusal: { name, reason: t("attach.overLimit", { size: megabytes(MAX_IMAGE_BYTES) }) },
    };
  }
  try {
    const url = await readAsDataUrl(file);
    const data = dataUrlPayload(url);
    if (data === null) return { image: null, refusal: { name, reason: t("attach.readFailed") } };
    const original: ImageBlock = { type: "image", data, mimeType: file.type };
    // Best-effort: `compressImage` answers null for anything it cannot improve,
    // and the original is what goes out then.
    return { image: (await compressImage(file)) ?? original, refusal: null };
  } catch {
    return { image: null, refusal: { name, reason: t("attach.readFailed") } };
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

/** One line for the composer's refusal notice. */
export function refusalNotice(
  refusals: ImageRefusal[],
  overflow: number,
  t: Translate,
): string | null {
  const parts = refusals.map((refusal) =>
    t("attach.refusalLine", { name: refusal.name, reason: refusal.reason }),
  );
  if (overflow > 0) {
    parts.push(t("attach.overflow", { count: overflow, max: MAX_IMAGES_PER_MESSAGE }));
  }
  return parts.length > 0 ? parts.join(t("attach.refusalSeparator")) : null;
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

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("read failed"));
    };
    reader.readAsDataURL(blob);
  });
}

/** The base64 after `data:<type>;base64,`, or null when there is no payload. */
function dataUrlPayload(url: string): string | null {
  const comma = url.indexOf(",");
  return comma < 0 ? null : url.slice(comma + 1);
}

/** Formats a canvas can re-encode. GIF is out: redrawing one keeps a single frame. */
function isCompressibleImageType(mimeType: string): boolean {
  return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp";
}

/**
 * Shrink an image before it joins the session.
 *
 * Session files hold images as inline base64 with no separate blob store, so a
 * 5MB screenshot costs ~6.7MB of JSONL that every later read of the session
 * carries. Scaling to `MAX_IMAGE_DIMENSION` and re-encoding is what keeps that
 * bounded.
 *
 * Returns null whenever the original is at least as good — a format a canvas
 * cannot re-encode, a decode that failed, an environment without canvases, a
 * re-encode that came out larger, or an image already small and already inside
 * the bound. The caller falls back to the original, so this can never lose one.
 */
async function compressImage(file: File): Promise<ImageBlock | null> {
  if (!isCompressibleImageType(file.type)) return null;
  const bitmap = await decodeImage(file);
  if (bitmap === null) return null;
  try {
    const scale = fitScale(bitmap.width, bitmap.height);
    if (scale >= 1 && file.size <= REENCODE_THRESHOLD_BYTES) return null;
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, file.type, IMAGE_QUALITY);
    if (blob === null || blob.size >= file.size) return null;
    // The browser may answer with a different type than the one asked for
    // (Safari encodes WebP as PNG), so what it reports is what the block says.
    const mimeType = blob.type.length > 0 ? blob.type : file.type;
    if (!isAcceptedImageType(mimeType)) return null;
    const data = dataUrlPayload(await readAsDataUrl(blob));
    if (data === null) return null;
    return { type: "image", data, mimeType };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

async function decodeImage(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    // `from-image` keeps a phone photo upright: without it the EXIF rotation is
    // dropped and the copy the model sees comes out sideways.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      return await createImageBitmap(file);
    } catch {
      return null;
    }
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { SessionContext } from "@earendil-works/pi-coding-agent";
import { openSessionForRead } from "./session-open.ts";

/**
 * Session images, addressed by URL instead of shipped inline.
 *
 * A session file carries every picture it ever held as base64 inside the JSONL,
 * and a switch used to drag all of them through one `/messages` response — 30MB
 * on a session that screenshots a lot, parsed on the browser's main thread
 * before a single row could paint, though the reader looks at one or two of them
 * and usually not the ones at the top. The transcript now hands the **tool
 * results'** pictures out as URLs the browser fetches lazily (it already renders
 * them with `loading="lazy"`), which is where the weight is: a tool that returns
 * screenshots is what makes a session large.
 *
 * User messages keep their pictures inline on purpose. A failed turn can be
 * retried, and a retry re-sends the prompt's own images to pi — which wants the
 * base64 back. Nothing here has to know how to rehydrate for that path; the
 * bytes simply never leave the message.
 *
 * ## Addressing
 *
 * An image is named by **its position among the transcript's images**, plus a
 * version that changes whenever the bytes behind that position do. The position
 * is cheap to derive and both sides agree on it because both walk the same
 * message list in the same order; the version makes the URL change with the
 * transcript, so a response is immutable and a stale ordinal can never answer
 * for a newer one.
 *
 * What the version names differs by where the transcript came from. A session
 * read from **disk** is versioned by the file's mtime, and its bytes are
 * re-derived from the file on request, through the same shared parse the
 * transcript read just used (`session-open.ts`). The reader's browser asks for
 * them within a moment of the transcript arriving, so the parse is still warm; a
 * cold one costs the file read, off the critical path because by then the rows
 * are already on screen.
 *
 * A **live** session has no such file: its transcript comes from pi's memory and
 * may hold turns the file has never seen, so a URL cannot point into the file
 * for it. Its version is minted per response by `LiveImageStore`, which keeps
 * the bytes the URL names. That path matters most: a live transcript is far and
 * away the expensive one — it is the screenshots the running process still
 * remembers — so leaving it inline is exactly the stall this module exists to
 * prevent. See the `/messages` route.
 */

/** One image's bytes, with the type to serve them as. */
export interface SessionImage {
  mimeType: string;
  data: string;
}

/** The shape this module reads; the wire shape is wider than pi's own union. */
interface MessageLike {
  role?: unknown;
  content?: unknown;
}

function asImage(block: unknown): SessionImage | null {
  if (typeof block !== "object" || block === null) return null;
  const candidate = block as { type?: unknown; data?: unknown; mimeType?: unknown };
  if (candidate.type !== "image") return null;
  if (typeof candidate.data !== "string" || candidate.data.length === 0) return null;
  if (typeof candidate.mimeType !== "string") return null;
  return { mimeType: candidate.mimeType, data: candidate.data };
}

/** The current version of the bytes a session's images come from. */
export function sessionImageVersion(sessionPath: string): string | null {
  const stat = statSync(sessionPath, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? null : stat.mtimeNs.toString();
}

/** The URL one image is fetched from. The only place the shape is spelled. */
export function sessionImageUrl(sessionPath: string, index: number, version: string): string {
  const id = encodeURIComponent(sessionPath);
  return `/api/sessions/${id}/image/${String(index)}?v=${encodeURIComponent(version)}`;
}

/**
 * Replace every **tool result's** inline image with a URL, leaving the rest of
 * the transcript untouched.
 *
 * The image ordinal is counted across every message, not only the rewritten
 * ones, so the number in a URL is the image's place in the transcript and the
 * reader that serves it can find it by walking the same list. Copies are made
 * lazily: a message with no tool-result image is handed back as the same object,
 * and only the block arrays that actually change are rebuilt — the parsed
 * session must not be mutated, because `session-open.ts` hands the same manager
 * to the composer's read.
 */
export function withToolResultImageUrls(
  messages: SessionContext["messages"],
  sessionPath: string,
  version: string,
): SessionContext["messages"] {
  return rewriteToolResultImages(messages, (index) =>
    sessionImageUrl(sessionPath, index, version),
  );
}

/**
 * The rewrite itself, with the URL left to the caller.
 *
 * Both readers share it because the ordinal a URL carries has to be counted one
 * way: `withToolResultImageUrls` names a file's bytes, and the live route names
 * the copy its handle keeps (see `LiveImageStore`) — either way the reader that
 * serves the URL finds the image by walking the transcript.
 */
function rewriteToolResultImages(
  messages: SessionContext["messages"],
  urlFor: (index: number) => string,
): SessionContext["messages"] {
  const source = messages as unknown as MessageLike[];
  let next = source;
  let index = 0;

  source.forEach((message, messageIndex) => {
    const content = message.content;
    if (!Array.isArray(content)) return;
    const toolResult = message.role === "toolResult";
    let blocks = content;

    content.forEach((block, blockIndex) => {
      if (asImage(block) === null) return;
      const at = index;
      index += 1;
      if (!toolResult) return;
      if (blocks === content) blocks = [...content];
      blocks[blockIndex] = {
        type: "image",
        mimeType: (block as { mimeType: string }).mimeType,
        url: urlFor(at),
      };
    });

    if (blocks === content) return;
    if (next === source) next = [...source];
    next[messageIndex] = { ...message, content: blocks };
  });

  return next as unknown as SessionContext["messages"];
}

/**
 * Every image in a transcript, in document order — the ordinal space all the
 * URLs are counted in.
 *
 * A live transcript's bytes are handed to `LiveImageStore` as one flat list, so
 * this walk and `rewriteToolResultImages` have to agree on where each image
 * sits: both count *all* of them, a user message's included, because the
 * rewrite numbers the ones it leaves alone too.
 */
export function collectSessionImages(
  messages: SessionContext["messages"],
): SessionImage[] {
  const found: SessionImage[] = [];
  for (const message of messages as unknown as MessageLike[]) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const image = asImage(block);
      if (image !== null) found.push(image);
    }
  }
  return found;
}

/**
 * The image at `index` in a session's transcript, in document order, or null
 * when the file has no such image.
 */
export function readSessionImage(sessionPath: string, index: number): SessionImage | null {
  const manager = openSessionForRead(sessionPath);
  const messages = manager.buildSessionContext().messages as unknown as MessageLike[];
  let at = 0;

  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const image = asImage(block);
      if (image === null) continue;
      if (at === index) return image;
      at += 1;
    }
  }
  return null;
}

/**
 * The version prefix a live transcript's image URLs carry. URL-safe on purpose:
 * a version goes into a query string, and a separator that needs no escaping is
 * one a cache key and a log line can show as it is.
 */
const LIVE_PREFIX = "live-";

/**
 * Whether a URL's version names a live transcript's copy rather than a file's
 * mtime. A file version is a decimal nanosecond stamp, so the two can never be
 * mistaken for each other.
 */
export function isLiveImageVersion(version: string): boolean {
  return version.startsWith(LIVE_PREFIX);
}

/**
 * Names the server run a live version was minted in.
 *
 * A live version has to be unique for as long as the *browser* may remember it,
 * which is longer than this process lives: the URL path is the session's, and a
 * session outlives any one run of the server. Without the run in it, a restarted
 * server could mint a version a browser still had a stale entry for and be
 * answered with a stranger's screenshot. Run, revision and ordinal together put
 * that out of reach.
 */
const LIVE_RUN = randomUUID().slice(0, 8);
let liveRevisions = 0;

/** Whether two transcripts hand out the same pictures, byte for byte. */
function sameImages(left: readonly SessionImage[], right: readonly SessionImage[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (image, at) => image.mimeType === right[at]!.mimeType && image.data === right[at]!.data,
  );
}

/**
 * The images one **live** session's transcript handed out, kept on its handle.
 *
 * A file versions its images by mtime because the file is the truth and its
 * stamps move with it. A live session's truth is pi's memory, which has no stamp
 * at all — so the copy is what a URL addresses, and this is where that copy
 * lives. It costs one extra copy of the pictures the process still remembers,
 * bounded by the handle's own lifetime: a resident session is already holding
 * them (that is where `getMessages` answers from), and they go when it does,
 * rather than outliving the process that could have served them.
 *
 * Versions make the same promise the mtime makes. Unchanged pictures keep the
 * version they had, so a switch back is answered from the browser's cache; a
 * transcript that moved on mints a new one, and the version it retired 404s from
 * then on instead of quietly serving bytes the transcript no longer shows.
 * Handing one version out for *different* bytes is the single thing this must
 * never do.
 */
export class LiveImageStore {
  private version: string | null = null;
  private images: SessionImage[] = [];

  /**
   * Record the images of the transcript just read and answer the version their
   * URLs carry.
   */
  accept(images: SessionImage[]): string {
    if (this.version !== null && sameImages(this.images, images)) return this.version;
    liveRevisions += 1;
    this.version = `${LIVE_PREFIX}${LIVE_RUN}-${String(liveRevisions)}`;
    this.images = images;
    return this.version;
  }

  /** The bytes a URL names, or null when that version is no longer current. */
  read(version: string, index: number): SessionImage | null {
    if (this.version !== version) return null;
    return this.images[index] ?? null;
  }
}

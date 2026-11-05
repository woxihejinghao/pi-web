import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionForRead, resetSessionOpenCache } from "./session-open.ts";
import {
  collectSessionImages,
  isLiveImageVersion,
  LiveImageStore,
  readSessionImage,
  sessionImageUrl,
  sessionImageVersion,
  withToolResultImageUrls,
} from "./session-images.ts";

type Messages = SessionContext["messages"];

/** The module is deliberately structural; the tests build loose objects. */
const asMessages = (value: unknown): Messages => value as Messages;
const contentOf = (message: Messages[number]): unknown[] =>
  (message as unknown as { content: unknown[] }).content;

const user = (content: unknown): unknown => ({
  role: "user",
  content,
  timestamp: 0,
});
const toolResult = (content: unknown): unknown => ({
  role: "toolResult",
  toolCallId: "c1",
  toolName: "read",
  content,
  isError: false,
  timestamp: 1,
});

describe("withToolResultImageUrls", () => {
  it("URL-ifies a tool result's image and leaves a user's inline", () => {
    const messages = asMessages([
      user([{ type: "image", data: "USER", mimeType: "image/png" }]),
      toolResult([{ type: "image", data: "TOOL", mimeType: "image/jpeg" }]),
    ]);

    const out = withToolResultImageUrls(messages, "/s/a.jsonl", "7");

    // The ordinal counts every image, so the tool's is #1 — the user's was #0.
    expect(contentOf(out[1]!)[0]).toEqual({
      type: "image",
      mimeType: "image/jpeg",
      url: "/api/sessions/%2Fs%2Fa.jsonl/image/1?v=7",
    });
    // A user message keeps its bytes: a retry re-sends them to pi as base64.
    expect(contentOf(out[0]!)[0]).toEqual({ type: "image", data: "USER", mimeType: "image/png" });
  });

  it("does not mutate the parsed session", () => {
    // The same manager is handed to the composer's read; rewriting in place
    // would corrupt the token estimate it derives from the same objects.
    const original = asMessages([toolResult([{ type: "image", data: "TOOL", mimeType: "image/png" }])]);
    withToolResultImageUrls(original, "/s/a.jsonl", "7");
    expect(contentOf(original[0]!)[0]).toEqual({ type: "image", data: "TOOL", mimeType: "image/png" });
  });

  it("hands back the same array when nothing was rewritten", () => {
    const messages = asMessages([user("hello"), user([{ type: "text", text: "hi" }])]);
    expect(withToolResultImageUrls(messages, "/s/a.jsonl", "7")).toBe(messages);
  });
});

describe("sessionImageUrl / sessionImageVersion", () => {
  it("spells the URL with the path encoded as one segment", () => {
    expect(sessionImageUrl("/Users/me/s.jsonl", 3, "1760000000000000000")).toBe(
      "/api/sessions/%2FUsers%2Fme%2Fs.jsonl/image/3?v=1760000000000000000",
    );
  });

  it("reports null for a file that is not there", () => {
    expect(sessionImageVersion(join(tmpdir(), "piws-never-written.jsonl"))).toBeNull();
  });
});

describe("readSessionImage", () => {
  const HEADER = {
    type: "session",
    version: 3,
    id: "images-session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
  };

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "piws-images-"));
    resetSessionOpenCache();
  });
  afterEach(async () => {
    resetSessionOpenCache();
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSession(entries: unknown[]): Promise<string> {
    const path = join(dir, "session.jsonl");
    await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
    return path;
  }

  it("reads the nth image back in document order", async () => {
    const path = await writeSession([
      HEADER,
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
          ],
        },
      },
    ]);

    expect(readSessionImage(path, 0)).toEqual({ mimeType: "image/png", data: "aGVsbG8=" });
    expect(readSessionImage(path, 1)).toEqual({ mimeType: "image/jpeg", data: "d29ybGQ=" });
    expect(readSessionImage(path, 2)).toBeNull();
  });

  it("finds the image a rewrite would have named", async () => {
    const path = await writeSession([
      HEADER,
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "shot" },
      },
      {
        type: "message",
        id: "t1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: toolResult([{ type: "image", data: "VE9PTA==", mimeType: "image/png" }]),
      },
    ]);

    // The URL says position 0; the endpoint must resolve it to the same block.
    expect(readSessionImage(path, 0)).toEqual({ mimeType: "image/png", data: "VE9PTA==" });
    expect(openSessionForRead(path)).toBe(openSessionForRead(path));
  });
});

describe("collectSessionImages", () => {
  it("collects every image, in the ordinal space the rewrite numbers", () => {
    // A live transcript's bytes are handed to the store as one flat list, so this
    // walk and the rewrite have to agree on where each image sits — including the
    // user message's, which the rewrite counts but leaves inline.
    const messages = asMessages([
      user([{ type: "image", data: "USER", mimeType: "image/png" }]),
      user("plain"),
      toolResult([
        { type: "text", text: "shot" },
        { type: "image", data: "TOOL", mimeType: "image/jpeg" },
      ]),
    ]);

    expect(collectSessionImages(messages)).toEqual([
      { mimeType: "image/png", data: "USER" },
      { mimeType: "image/jpeg", data: "TOOL" },
    ]);
  });

  it("puts the image a URL names at the index that URL carries", () => {
    const messages = asMessages([
      user([{ type: "image", data: "USER", mimeType: "image/png" }]),
      toolResult([{ type: "image", data: "TOOL", mimeType: "image/jpeg" }]),
    ]);
    const images = collectSessionImages(messages);
    const rewritten = withToolResultImageUrls(messages, "/s/a.jsonl", "7");
    const url = (contentOf(rewritten[1]!)[0] as { url: string }).url;

    expect(url).toContain("/image/1?");
    expect(images[1]).toEqual({ mimeType: "image/jpeg", data: "TOOL" });
  });

  it("finds nothing in a transcript without pictures", () => {
    expect(collectSessionImages(asMessages([user("hello")]))).toEqual([]);
  });
});

describe("LiveImageStore", () => {
  const shot = (data: string, mimeType = "image/png"): { mimeType: string; data: string } => ({
    mimeType,
    data,
  });

  it("mints a version a file's version could never be mistaken for", () => {
    const version = new LiveImageStore().accept([shot("A")]);

    // The image route tells the two address spaces apart by exactly this: a file
    // version is a decimal nanosecond stamp, so the prefix is unambiguous.
    expect(isLiveImageVersion(version)).toBe(true);
    expect(isLiveImageVersion("1760000000000000000")).toBe(false);
  });

  it("resolves the ordinals its version was minted for", () => {
    const store = new LiveImageStore();
    const images = [shot("A"), shot("B", "image/jpeg")];
    const version = store.accept(images);

    expect(store.read(version, 0)).toEqual(images[0]);
    expect(store.read(version, 1)).toEqual(images[1]);
    expect(store.read(version, 2)).toBeNull();
    expect(store.read("live-someone-else-1", 0)).toBeNull();
  });

  it("keeps its version while the transcript is unchanged", () => {
    // Returning to a session is answered from the browser's cache only if the
    // version did not move — and a fresh read of pi's memory yields equal but
    // distinct objects, which is what the comparison has to see through.
    const store = new LiveImageStore();
    const first = store.accept([shot("A")]);
    expect(store.accept([shot("A")])).toBe(first);
  });

  it("retires a version as soon as the bytes behind it change", () => {
    // Reusing a version for different bytes is the one thing this must never do:
    // the browser would keep drawing the old screenshot.
    const store = new LiveImageStore();
    const before = store.accept([shot("A")]);
    const after = store.accept([shot("A"), shot("B")]);

    expect(after).not.toBe(before);
    expect(store.read(before, 0)).toBeNull();
    expect(store.read(after, 1)).toEqual(shot("B"));
  });

  it("notices a changed payload at the same position and length", () => {
    const store = new LiveImageStore();
    const before = store.accept([shot("AAA")]);
    const after = store.accept([shot("BBB")]);

    expect(after).not.toBe(before);
    expect(store.read(before, 0)).toBeNull();
    expect(store.read(after, 0)).toEqual(shot("BBB"));
  });

  it("never hands one version to two transcripts", () => {
    // Two sessions can hold the same picture at the same ordinal, and a URL only
    // ever names one transcript — so the version has to be minted per store.
    const first = new LiveImageStore();
    const second = new LiveImageStore();
    expect(second.accept([shot("A")])).not.toBe(first.accept([shot("A")]));
  });
});

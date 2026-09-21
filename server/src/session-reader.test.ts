import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageText, readSessionSnapshot, readSessionTree } from "./session-reader.ts";

const HEADER = {
  type: "session",
  version: 3,
  id: "01a04228-2612-7b9a-b6f1-f5c38cc1e726",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp/project",
};

/** Write a session file in pi's JSONL format. */
async function writeSession(dir: string, entries: unknown[]): Promise<string> {
  const path = join(dir, "session.jsonl");
  await writeFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  return path;
}

const message = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role, content },
});

describe("readSessionSnapshot", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "piws-reader-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the session id from the header", async () => {
    const path = await writeSession(dir, [HEADER]);
    expect(readSessionSnapshot(path).sessionId).toBe(HEADER.id);
  });

  it("returns no messages for a header-only session", async () => {
    // A session pi has created but never written a turn into.
    const path = await writeSession(dir, [HEADER]);
    expect(readSessionSnapshot(path).messages).toEqual([]);
  });

  it("replays the transcript in order", async () => {
    const path = await writeSession(dir, [
      HEADER,
      message("a1", null, "user", "hello"),
      message("a2", "a1", "assistant", [{ type: "text", text: "hi there" }]),
      message("a3", "a2", "user", "and again"),
    ]);
    expect(readSessionSnapshot(path).messages.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("skips entries that are not messages", async () => {
    // Real sessions interleave model changes, thinking-level changes and
    // extension state with the transcript.
    const path = await writeSession(dir, [
      HEADER,
      {
        type: "model_change",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        provider: "test",
        modelId: "test-model",
      },
      message("a1", "m1", "user", "hello"),
      {
        type: "custom",
        customType: "example",
        data: { phase: "idle" },
        id: "c1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:02.000Z",
      },
    ]);
    const { messages } = readSessionSnapshot(path);
    expect(messages.map((entry) => entry.role)).toEqual(["user"]);
  });

  it("throws for a file that is not a session", async () => {
    const path = join(dir, "broken.jsonl");
    await writeFile(path, "not json at all\n", "utf8");
    expect(() => readSessionSnapshot(path)).toThrow();
  });
});


describe("forkPoints", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "piws-fork-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports one entry per user message, in transcript order", async () => {
    const path = await writeSession(dir, [
      HEADER,
      message("m1", null, "user", "first question"),
      message("m2", "m1", "assistant", "an answer"),
      message("m3", "m2", "user", "second question"),
    ]);

    expect(readSessionSnapshot(path).forkPoints).toEqual([
      { entryId: "m1", text: "first question" },
      { entryId: "m3", text: "second question" },
    ]);
  });

  it("never offers an assistant message as a fork target", async () => {
    // pi only forks at user messages; an answer showing up here would produce
    // an entry id the fork command rejects.
    const path = await writeSession(dir, [
      HEADER,
      message("m1", null, "user", "q"),
      message("m2", "m1", "assistant", "a"),
    ]);
    expect(readSessionSnapshot(path).forkPoints.map((p) => p.text)).toEqual(["q"]);
  });

  it("keeps text parts and drops non-text ones", async () => {
    const path = await writeSession(dir, [
      HEADER,
      message("m1", null, "user", [
        { type: "text", text: "hello " },
        { type: "image", data: "…" },
        { type: "text", text: "world" },
      ]),
    ]);
    expect(readSessionSnapshot(path).forkPoints[0]!.text).toBe("hello world");
  });

  it("is empty for a session with no user messages", async () => {
    const path = await writeSession(dir, [HEADER, message("m1", null, "assistant", "hi")]);
    expect(readSessionSnapshot(path).forkPoints).toEqual([]);
  });
});

describe("messageText", () => {
  it("handles a plain string, an empty value, and junk", () => {
    expect(messageText("plain")).toBe("plain");
    expect(messageText(undefined)).toBe("");
    expect(messageText([{ type: "image" }])).toBe("");
    expect(messageText(42)).toBe("");
  });
});

describe("readSessionTree", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "piws-tree-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the tree, the leaf, and the session id", async () => {
    const path = await writeSession(dir, [
      HEADER,
      message("m1", null, "user", "q"),
      message("m2", "m1", "assistant", "a"),
    ]);

    const tree = readSessionTree(path);
    expect(tree.sessionId).toBe(HEADER.id);
    expect(tree.tree.length).toBeGreaterThan(0);

    // `tree` is typed as an opaque shape here; this walks it defensively.
    type Node = { entry: { id: string }; children: Node[] };
    const ids = new Set<string>();
    const walk = (nodes: readonly Node[]): void => {
      for (const node of nodes as readonly Node[]) {
        ids.add(node.entry.id);
        walk((node.children ?? []) as Node[]);
      }
    };
    walk(tree.tree as unknown as Node[]);
    expect(ids.has("m1")).toBe(true);
    // The leaf is the tip of the active branch and must be part of the tree.
    if (tree.leafId !== null) expect(ids.has(tree.leafId)).toBe(true);
  });
});

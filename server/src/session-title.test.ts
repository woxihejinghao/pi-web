import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionTitleWriter } from "./session-title.ts";

let dir: string;
let setSessionTitle: typeof import("./session-title.ts").setSessionTitle;

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "piws-title-")));
  ({ setSessionTitle } = await import("./session-title.ts"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Header-only file: enough for pi to open, and what a rename appends to. */
async function writeSession(fileName: string): Promise<string> {
  const path = join(dir, fileName);
  await writeFile(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "11111111-2222-3333-4444-555555555555",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: dir,
    })}\n`,
    "utf8",
  );
  return path;
}

/** Read the name back the way pi itself does: the last `session_info` entry. */
const nameOf = (path: string): string | undefined => SessionManager.open(path).getSessionName();

describe("setSessionTitle", () => {
  it("appends a session_info entry to pi's own file", async () => {
    const path = await writeSession("rename.jsonl");

    await setSessionTitle(path, "My name", undefined);

    expect(nameOf(path)).toBe("My name");
    expect(await readFile(path, "utf8")).toContain('"type":"session_info"');
  });

  it("clears the name when given an empty string", async () => {
    const path = await writeSession("clear.jsonl");
    await setSessionTitle(path, "First", undefined);

    await setSessionTitle(path, "", undefined);

    expect(nameOf(path)).toBeUndefined();
  });

  it("uses the live writer instead of appending to the file", async () => {
    const path = await writeSession("live.jsonl");
    const calls: string[] = [];
    const writer: SessionTitleWriter = {
      setSessionName(name) {
        calls.push(name);
        return Promise.resolve();
      },
    };

    await setSessionTitle(path, "Through RPC", writer);

    expect(calls).toEqual(["Through RPC"]);
    // The live process owns the file, so this path must not write to it too.
    expect(nameOf(path)).toBeUndefined();
  });

  it("refuses a session file that does not exist", async () => {
    await expect(setSessionTitle(join(dir, "missing.jsonl"), "Nope", undefined)).rejects.toThrow(
      /does not exist/,
    );
  });
});

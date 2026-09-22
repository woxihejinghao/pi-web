import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TrashRunner } from "./session-delete.ts";

let home: string;
let dir: string;
let store: typeof import("./store.ts");
let projects: typeof import("./projects.ts");
let sessionDelete: typeof import("./session-delete.ts");

beforeAll(async () => {
  home = await realpath(process.env.PI_WEB_SIMPLE_HOME!);
  dir = await realpath(await mkdtemp(join(tmpdir(), "piws-delete-")));
  store = await import("./store.ts");
  projects = await import("./projects.ts");
  sessionDelete = await import("./session-delete.ts");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(home, "store.json"), { force: true });
  store.resetStoreCache();
});

async function writeSession(fileName: string): Promise<string> {
  const path = join(dir, fileName);
  await writeFile(path, `${JSON.stringify({ type: "session", version: 3 })}\n`, "utf8");
  return path;
}

/** A host without the `trash` CLI; deletion has to fall back to unlink. */
const NO_TRASH: TrashRunner = async () => ({ ok: false, hint: "trash: spawn trash ENOENT" });

/** A host with the `trash` CLI: the file is "moved away" by the runner. */
const FAKE_TRASH: TrashRunner = async (path) => {
  await rm(path, { force: true });
  return { ok: true, hint: null };
};

describe("deleteSession", () => {
  it("prefers the system trash when the CLI is available", async () => {
    const path = await writeSession("trashed.jsonl");

    const result = await sessionDelete.deleteSession(path, FAKE_TRASH);

    expect(result).toEqual({ ok: true, method: "trash" });
    await expect(realpath(path)).rejects.toThrow();
  });

  it("falls back to a permanent delete when trash is unavailable", async () => {
    const path = await writeSession("unlinked.jsonl");

    const result = await sessionDelete.deleteSession(path, NO_TRASH);

    expect(result).toEqual({ ok: true, method: "unlink" });
    await expect(realpath(path)).rejects.toThrow();
  });

  it("forgets the session's rename and hidden overrides", async () => {
    const path = await writeSession("overridden.jsonl");
    await projects.setSessionOverride(path, { name: "Web name", hidden: true });
    expect(Object.keys(await projects.getSessionOverrides())).toContain(path);

    await sessionDelete.deleteSession(path, NO_TRASH);

    expect(await projects.getSessionOverrides()).not.toHaveProperty(path);
  });

  it("reports a missing file instead of claiming success", async () => {
    const result = await sessionDelete.deleteSession(join(dir, "never.jsonl"), NO_TRASH);

    expect(result.ok).toBe(false);
    expect(result.missing).toBe(true);
  });

  it("leaves the override alone when nothing was deleted", async () => {
    const path = join(dir, "missing-but-renamed.jsonl");
    await projects.setSessionOverride(path, { name: "Still here" });

    await sessionDelete.deleteSession(path, NO_TRASH);

    expect(await projects.getSessionOverrides()).toHaveProperty(path);
  });

  it("surfaces both failures when neither trash nor unlink works", async () => {
    // A directory is not a session file: unlink refuses it, and the trash
    // error is what explains why the recovery path was not available either.
    const path = join(dir, "a-directory");
    await mkdir(path, { recursive: true });

    const result = await sessionDelete.deleteSession(path, NO_TRASH);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("trash: spawn trash ENOENT");
    await expect(realpath(path)).resolves.toBe(path);
  });
});

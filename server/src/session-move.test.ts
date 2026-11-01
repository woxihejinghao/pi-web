import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { moveSessionFile } from "./session-move.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "piws-move-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("never overwrites a destination created after preflight validation", async () => {
  const source = join(root, "source.jsonl");
  const target = join(root, "target.jsonl");
  const contents = JSON.stringify({ type: "session", cwd: "/source" }) + "\n";
  await writeFile(source, contents);
  await writeFile(target, "keep me");
  await expect(moveSessionFile(source, target, "/target")).rejects.toThrow("already exists");
  expect(await readFile(source, "utf8")).toBe(contents);
  expect(await readFile(target, "utf8")).toBe("keep me");
  expect((await readdir(root)).sort()).toEqual(["source.jsonl", "target.jsonl"]);
});

it("leaves the original untouched when a workspace move has an invalid header", async () => {
  const source = join(root, "source.jsonl");
  await writeFile(source, "not json\n");
  await expect(moveSessionFile(source, join(root, "target.jsonl"), "/target")).rejects.toThrow();
  expect(await readFile(source, "utf8")).toBe("not json\n");
  expect(await readdir(root)).toEqual(["source.jsonl"]);
});

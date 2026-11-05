import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertAllowedSessionPath } from "./session-path.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("assertAllowedSessionPath", () => {
  it("rejects a session reached through a symlink outside the root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "piws-session-root-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "piws-session-outside-")));
    roots.push(root, outside);
    const link = join(root, "linked");
    await symlink(outside, link, "dir");
    await writeFile(join(outside, "escape.jsonl"), "", "utf8");

    expect(() => assertAllowedSessionPath(join(link, "escape.jsonl"), root)).toThrow(
      /session path is outside/,
    );
  });

  it("allows a normal session and rejects a similarly prefixed root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "piws-session-root-")));
    const sibling = `${root}-other`;
    roots.push(root, sibling);
    await mkdir(sibling, { recursive: true });
    const session = join(root, "ok.jsonl");
    await writeFile(session, "", "utf8");

    expect(assertAllowedSessionPath(session, root)).toBe(session);
    expect(() => assertAllowedSessionPath(join(sibling, "no.jsonl"), root)).toThrow(
      /session path is outside/,
    );
  });
});

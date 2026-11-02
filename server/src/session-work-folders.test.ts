import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { moveWorkFolders } from "./session-work-folders.ts";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "piws-work-folders-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const move = () => ({ source: join(root, "source"), destination: join(root, "target") });

it("preserves nested/hidden content and symlinks without following their targets", async () => {
  const paths = move();
  await mkdir(join(paths.source, ".nested"), { recursive: true });
  await writeFile(join(paths.source, ".nested", "report.txt"), "report bytes");
  await writeFile(join(root, "external.txt"), "do not relocate me");
  await symlink(join(root, "external.txt"), join(paths.source, "external-link"));
  const rollback = await moveWorkFolders([paths]);
  await expect(lstat(paths.source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(paths.destination, ".nested", "report.txt"), "utf8")).toBe("report bytes");
  expect(await readlink(join(paths.destination, "external-link"))).toBe(join(root, "external.txt"));
  expect(await readFile(join(root, "external.txt"), "utf8")).toBe("do not relocate me");
  await rollback();
  expect(await readFile(join(paths.source, ".nested", "report.txt"), "utf8")).toBe("report bytes");
  await expect(lstat(paths.destination)).rejects.toMatchObject({ code: "ENOENT" });
});

it("never merges into or overwrites an existing destination, even an empty directory", async () => {
  const paths = move();
  await mkdir(paths.source);
  await writeFile(join(paths.source, "report.txt"), "keep source");
  await mkdir(paths.destination);
  await expect(moveWorkFolders([paths])).rejects.toThrow("already exists");
  expect(await readdir(paths.destination)).toEqual([]);
  expect(await readFile(join(paths.source, "report.txt"), "utf8")).toBe("keep source");
});

it("rolls back every transferred entry and prior folder on a filesystem failure", async () => {
  const first = move();
  const second = { source: join(root, "second"), destination: join(root, "second-target") };
  await mkdir(first.source);
  await mkdir(second.source);
  await writeFile(join(first.source, "report.txt"), "first");
  await writeFile(join(second.source, "fail.txt"), "second");
  await expect(moveWorkFolders([first, second], async (source, target) => {
    if (source === join(second.source, "fail.txt")) throw Object.assign(new Error("cross device"), { code: "EXDEV" });
    await rename(source, target);
  })).rejects.toMatchObject({ code: "EXDEV" });
  expect(await readFile(join(first.source, "report.txt"), "utf8")).toBe("first");
  expect(await readFile(join(second.source, "fail.txt"), "utf8")).toBe("second");
  await expect(lstat(first.destination)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(second.destination)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains both versions and reports recovery if a rollback path has been occupied", async () => {
  const paths = move();
  await mkdir(paths.source);
  await writeFile(join(paths.source, "report.txt"), "original");
  const rollback = await moveWorkFolders([paths]);
  await mkdir(paths.source);
  await writeFile(join(paths.source, "report.txt"), "concurrent writer");
  await expect(rollback()).rejects.toThrow("rollback needs attention");
  expect(await readFile(join(paths.source, "report.txt"), "utf8")).toBe("concurrent writer");
  expect(await readFile(join(paths.destination, "report.txt"), "utf8")).toBe("original");
});

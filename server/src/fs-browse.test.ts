import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listDirectories, startLocations } from "./fs-browse.ts";

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "piws-fs-")));
  await mkdir(join(root, "beta"), { recursive: true });
  await mkdir(join(root, "alpha", "nested"), { recursive: true });
  await mkdir(join(root, ".hidden"), { recursive: true });
  await writeFile(join(root, "a-file.txt"), "x", "utf8");
  await symlink(join(root, "alpha"), join(root, "link-to-alpha"));
  await symlink(join(root, "a-file.txt"), join(root, "link-to-file"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listDirectories", () => {
  it("returns directories only, never files", async () => {
    const listing = await listDirectories(root);
    const names = listing.entries.map((entry) => entry.name);
    expect(names).not.toContain("a-file.txt");
    expect(names).not.toContain("link-to-file");
    expect(names).toContain("alpha");
  });

  it("resolves symlinks that point at directories", async () => {
    const listing = await listDirectories(root);
    const link = listing.entries.find((entry) => entry.name === "link-to-alpha");
    expect(link?.path).toBe(join(root, "link-to-alpha"));
  });

  it("sorts visible directories first, then dot-directories", async () => {
    const listing = await listDirectories(root);
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "alpha",
      "beta",
      "link-to-alpha",
      ".hidden",
    ]);
  });

  it("reports the canonical path and its parent", async () => {
    const listing = await listDirectories(join(root, "alpha"));
    expect(listing.path).toBe(join(root, "alpha"));
    expect(listing.parent).toBe(root);
    expect(listing.entries.map((e) => e.name)).toEqual(["nested"]);
  });

  it("has a null parent at a filesystem root", async () => {
    const listing = await listDirectories("/");
    expect(listing.parent).toBeNull();
  });

  it("defaults to the home directory", async () => {
    const listing = await listDirectories();
    expect(listing.path).toBe(await realpath(homedir()));
  });

  it("expands a leading tilde", async () => {
    const listing = await listDirectories("~");
    expect(listing.path).toBe(await realpath(homedir()));
  });

  it("normalizes dot segments away", async () => {
    const listing = await listDirectories(join(root, "alpha", "..", "beta"));
    expect(listing.path).toBe(join(root, "beta"));
  });

  it("404s a directory that does not exist", async () => {
    await expect(listDirectories(join(root, "ghost"))).rejects.toMatchObject({ status: 404 });
  });

  it("400s a path that is a file", async () => {
    await expect(listDirectories(join(root, "a-file.txt"))).rejects.toMatchObject({ status: 400 });
  });

  it("returns no entries for an empty directory", async () => {
    const empty = join(root, "empty");
    await mkdir(empty, { recursive: true });
    const listing = await listDirectories(empty);
    expect(listing.entries).toEqual([]);
  });
});

describe("startLocations", () => {
  it("always offers the home directory and the filesystem root", async () => {
    const locations = await startLocations();
    const labels = locations.map((location) => location.label);
    expect(labels).toContain("主目录");
    expect(labels).toContain("根目录");
    expect(locations.find((l) => l.label === "主目录")?.path).toBe(homedir());
  });

  it("only lists locations that exist", async () => {
    const locations = await startLocations();
    for (const location of locations) {
      expect(location.path.length).toBeGreaterThan(0);
    }
  });
});

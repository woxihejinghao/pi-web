import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let home: string;
let workspace: string;
let projects: typeof import("./projects.ts");
let store: typeof import("./store.ts");

beforeAll(async () => {
  // realpath the fixtures: on macOS /var is a symlink to /private/var, and the
  // canonical form is what this module is specified to return.
  home = await realpath(process.env.PI_WEB_SIMPLE_HOME!);
  workspace = await realpath(await mkdtemp(join(tmpdir(), "piws-workspace-")));
  // Import after the sandbox home is fixed by src/testing/setup.ts.
  store = await import("./store.ts");
  projects = await import("./projects.ts");
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(home, "store.json"), { force: true });
  store.resetStoreCache();
});

async function makeDir(name: string): Promise<string> {
  const path = join(workspace, name);
  await mkdir(path, { recursive: true });
  return path;
}

describe("canonicalizePath", () => {
  it("resolves dot segments and trailing slashes to one canonical form", async () => {
    const dir = await makeDir("canon-a");
    const variant = join(dir, "sub", "..") + "/";
    await mkdir(join(dir, "sub"), { recursive: true });
    expect(await projects.canonicalizePath(variant)).toBe(dir);
  });

  it("collapses symlinks onto the real directory", async () => {
    const dir = await makeDir("canon-real");
    const link = join(workspace, "canon-link");
    await rm(link, { force: true });
    await symlink(dir, link);
    expect(await projects.canonicalizePath(link)).toBe(dir);
  });

  it("rejects a missing path with ENOENT", async () => {
    await expect(projects.canonicalizePath(join(workspace, "nope"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a file with ENOTDIR", async () => {
    const file = join(workspace, "a-file.txt");
    await writeFile(file, "x");
    await expect(projects.canonicalizePath(file)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("rejects an empty path with EINVALID", async () => {
    await expect(projects.canonicalizePath("   ")).rejects.toMatchObject({ code: "EINVALID" });
  });
});

describe("addProject", () => {
  it("defaults the title to the final path segment", async () => {
    const dir = await makeDir("title-input");
    const project = await projects.addProject(dir);
    expect(project.title).toBe("title-input");
    expect(project.path).toBe(dir);
    expect(project.exists).toBe(true);
  });

  it("treats two spellings of the same directory as one project", async () => {
    const dir = await makeDir("dup-target");
    await mkdir(join(dir, "inner"), { recursive: true });
    await projects.addProject(dir);
    await expect(projects.addProject(join(dir, "inner", ".."))).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await projects.listProjects()).toHaveLength(1);
  });

  it("keeps records ordered by their stored order", async () => {
    const a = await makeDir("order-a");
    const b = await makeDir("order-b");
    await projects.addProject(a);
    await projects.addProject(b);
    const list = await projects.listProjects();
    expect(list.map((p) => p.title)).toEqual(["order-a", "order-b"]);
  });
});

describe("mutations", () => {
  it("falls back to the default title when renamed to blank", async () => {
    const dir = await makeDir("rename-me");
    const project = await projects.addProject(dir);
    await projects.renameProject(project.id, "Custom");
    expect((await projects.getProject(project.id)).title).toBe("Custom");
    await projects.renameProject(project.id, "   ");
    expect((await projects.getProject(project.id)).title).toBe("rename-me");
  });

  it("removes only the record, leaving the directory on disk", async () => {
    const dir = await makeDir("keep-my-files");
    const project = await projects.addProject(dir);
    await projects.removeProject(project.id);
    expect(await projects.listProjects()).toHaveLength(0);
    expect((await projects.canonicalizePath(dir))).toBe(dir);
  });

  it("reorders projects and rewrites their order keys", async () => {
    const a = await projects.addProject(await makeDir("reorder-a"));
    const b = await projects.addProject(await makeDir("reorder-b"));
    const c = await projects.addProject(await makeDir("reorder-c"));
    await projects.reorderProjects([c.id, a.id, b.id]);
    const list = await projects.listProjects();
    expect(list.map((p) => p.id)).toEqual([c.id, a.id, b.id]);
    expect(list.map((p) => p.order)).toEqual([0, 1, 2]);
  });

  it("rejects an incomplete reorder without changing anything", async () => {
    const a = await projects.addProject(await makeDir("reorder-x"));
    await projects.addProject(await makeDir("reorder-y"));
    await expect(projects.reorderProjects([a.id])).rejects.toMatchObject({ code: "EINVALID" });
    expect((await projects.listProjects()).map((p) => p.title)).toEqual([
      "reorder-x",
      "reorder-y",
    ]);
  });

  it("reports a missing project id", async () => {
    await expect(projects.getProject("missing")).rejects.toMatchObject({ code: "ENOTFOUND" });
    await expect(projects.renameProject("missing", "x")).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
    await expect(projects.removeProject("missing")).rejects.toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("session overrides", () => {
  it("merges, clears fields, and drops the entry when empty", async () => {
    const key = join(workspace, "sessions", "s1.jsonl");
    await projects.setSessionOverride(key, { name: "Renamed" });
    await projects.setSessionOverride(key, { hidden: true });
    expect(await projects.getSessionOverrides()).toEqual({ [key]: { name: "Renamed", hidden: true } });

    // Renaming to blank clears just the name and keeps the hide flag.
    await projects.setSessionOverride(key, { name: "  " });
    expect(await projects.getSessionOverrides()).toEqual({ [key]: { hidden: true } });

    await projects.setSessionOverride(key, { hidden: false });
    expect(await projects.getSessionOverrides()).toEqual({});
  });
});

describe("store persistence", () => {
  it("survives a cache reset (records are durable on disk)", async () => {
    const dir = await makeDir("durable");
    const project = await projects.addProject(dir);
    store.resetStoreCache();
    const reloaded = await projects.listProjects();
    expect(reloaded.map((p) => p.id)).toEqual([project.id]);
  });
});

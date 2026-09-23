import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMAGE_LIMIT,
  TEXT_LIMIT,
  listWorkspaceDirectory,
  readWorkspaceFile,
} from "./workspace-files.ts";

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "piws-ws-")));
  root = join(base, "project");
  outside = join(base, "outside");
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, ".github"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "README.md"), "# 标题\n", "utf8");
  await writeFile(join(root, "src", "index.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(outside, "secret.txt"), "top secret\n", "utf8");
  await writeFile(join(outside, "big.png"), Buffer.alloc(IMAGE_LIMIT + 1));
  await writeFile(join(root, "archive.pdf"), "%PDF-1.4", "utf8");
  await writeFile(join(root, "blob.dat"), Buffer.from([0x41, 0x00, 0x42]));
  await writeFile(join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "huge.txt"), "x".repeat(TEXT_LIMIT + 10), "utf8");
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
  await symlink(outside, join(root, "escape-dir"));
});

afterAll(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

describe("listWorkspaceDirectory", () => {
  it("lists directories first, then natural case-insensitive names", async () => {
    const listing = await listWorkspaceDirectory(root);
    const names = listing.entries.map((entry) => entry.name);
    // Every directory precedes every file; within a kind the order is natural
    // and case-insensitive.
    expect(names.slice(0, 3)).toEqual([".github", "escape-dir", "src"]);
    expect(names.slice(3, 5)).toEqual(["archive.pdf", "blob.dat"]);
    expect(names).toContain("README.md");
  });

  it("reports types and root-relative paths, dot entries included", async () => {
    const listing = await listWorkspaceDirectory(root);
    const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("src")?.type).toBe("directory");
    expect(byName.get("src")?.path).toBe("src");
    expect(byName.get("README.md")?.type).toBe("file");
    expect(byName.has(".github")).toBe(true);
  });

  it("lists a subdirectory by its relative path", async () => {
    const listing = await listWorkspaceDirectory(root, "src");
    expect(listing.path).toBe("src");
    expect(listing.entries.map((entry) => entry.path)).toEqual(["src/nested", "src/index.ts"]);
  });

  it("refuses parent traversal and absolute paths", async () => {
    await expect(listWorkspaceDirectory(root, "..")).rejects.toThrow(/\.\./);
    await expect(listWorkspaceDirectory(root, "/etc")).rejects.toThrow(/相对路径/);
  });

  it("refuses a symlink pointing outside the project", async () => {
    await expect(listWorkspaceDirectory(root, "escape-dir")).rejects.toThrow(/超出项目目录/);
  });

  it("rejects a file as a directory target", async () => {
    await expect(listWorkspaceDirectory(root, "README.md")).rejects.toThrow(/不是一个目录/);
  });
});

describe("readWorkspaceFile", () => {
  it("reads a text file with its size and path", async () => {
    const file = await readWorkspaceFile(root, "README.md");
    expect(file).toMatchObject({
      kind: "text",
      name: "README.md",
      path: "README.md",
      content: "# 标题\n",
      truncated: false,
    });
    expect(file.size).toBe(Buffer.byteLength("# 标题\n"));
  });

  it("truncates a text file past the read cap instead of refusing it", async () => {
    const file = await readWorkspaceFile(root, "huge.txt");
    expect(file.kind).toBe("text");
    expect(file.truncated).toBe(true);
    expect(file.content.length).toBe(TEXT_LIMIT);
  });

  it("reads a known image extension as base64 with its mime type", async () => {
    const file = await readWorkspaceFile(root, "pixel.png");
    expect(file.kind).toBe("image");
    expect(file.mimeType).toBe("image/png");
    expect(Buffer.from(file.content, "base64")).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("reports a known binary container as unsupported without reading it", async () => {
    const file = await readWorkspaceFile(root, "archive.pdf");
    expect(file.kind).toBe("unsupported");
    expect(file.reason).toMatch(/PDF/);
    expect(file.content).toBe("");
  });

  it("reports an unlisted binary file as unsupported via its NUL byte", async () => {
    const file = await readWorkspaceFile(root, "blob.dat");
    expect(file.kind).toBe("unsupported");
    expect(file.reason).toMatch(/二进制/);
  });

  it("refuses an oversized image rather than returning half of it", async () => {
    await expect(readWorkspaceFile(root, "escape-dir/big.png")).rejects.toThrow(/超出项目目录/);
    const direct = join(root, "..", "outside", "big.png");
    await expect(readWorkspaceFile(root, direct)).rejects.toThrow(/相对路径|超出项目目录/);
  });

  it("refuses to read outside the project through a symlink", async () => {
    await expect(readWorkspaceFile(root, "escape.txt")).rejects.toThrow(/超出项目目录/);
  });

  it("rejects a directory, a missing path and an empty path", async () => {
    await expect(readWorkspaceFile(root, "src")).rejects.toThrow(/这是一个目录/);
    await expect(readWorkspaceFile(root, "nope.txt")).rejects.toThrow(/路径不存在/);
    await expect(readWorkspaceFile(root, "")).rejects.toThrow(/path is required/);
  });
});

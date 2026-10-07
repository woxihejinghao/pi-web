import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMAGE_LIMIT,
  TEXT_LIMIT,
  TEXT_PAGE_BYTES,
  TEXT_PAGE_LINES,
  listWorkspaceDirectory,
  readWorkspaceFile,
  readWorkspaceRaw,
  readWorkspaceTextPage,
} from "./workspace-files.ts";

let root: string;
let outside: string;

/** `count` lines of "line N", newline-terminated. */
function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${String(index + 1)}`).join("\n") + "\n";
}

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
  await writeFile(join(root, "sheet.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await writeFile(join(root, "blob.dat"), Buffer.from([0x41, 0x00, 0x42]));
  await writeFile(join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "huge.txt"), "x".repeat(TEXT_LIMIT + 10), "utf8");
  // Fixtures for paging: more lines than one page may carry, more bytes than one
  // page may carry with no newline at all, and a file whose byte budget lands
  // inside a three-byte character.
  await writeFile(join(root, "lines.txt"), numberedLines(5000), "utf8");
  await writeFile(join(root, "wide.txt"), "字".repeat(200000), "utf8");
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

  it("answers a pdf with its own kind and no bytes", async () => {
    // Not "unsupported": a PDF *is* renderable, just not by anything in this
    // bundle. The tab mounts the browser's viewer against `/raw` using this
    // size, so the answer is a kind of its own rather than a refusal.
    const file = await readWorkspaceFile(root, "archive.pdf");
    expect(file.kind).toBe("pdf");
    expect(file.content).toBe("");
    expect(file.size).toBe("%PDF-1.4".length);
  });

  it("reports a known binary container as unsupported without reading it", async () => {
    const file = await readWorkspaceFile(root, "sheet.xlsx");
    expect(file.kind).toBe("unsupported");
    expect(file.reason).toMatch(/XLSX/);
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

/**
 * Paging, which exists because the whole-file read has no good answer for a
 * large file: it ends mid-line and says so, leaving the reader stuck at the head
 * of a log. A page is bounded by bytes and by lines, and always ends just after
 * a newline so the next request continues from a line start.
 */
describe("readWorkspaceTextPage", () => {
  /** Walk a file to its end, one page at a time, and report what was seen. */
  async function walk(path: string) {
    const texts: string[] = [];
    const lineCounts: number[] = [];
    let offset = 0;
    let eof = false;
    let requests = 0;
    while (!eof) {
      const page = await readWorkspaceTextPage(root, path, offset);
      texts.push(page.text);
      lineCounts.push(page.lines);
      offset = page.nextOffset;
      eof = page.eof;
      requests += 1;
      expect(requests).toBeLessThan(50);
    }
    return { text: texts.join(""), requests, lineCounts };
  }

  it("reads a file that fits in one page in one request", async () => {
    const page = await readWorkspaceTextPage(root, "src/index.ts");
    expect(page.text).toBe("export const a = 1;\n");
    expect(page.offset).toBe(0);
    expect(page.nextOffset).toBe(page.size);
    expect(page.eof).toBe(true);
    expect(page.lines).toBe(1);
  });

  it("ends a page just after a newline, so the next one starts at a line start", async () => {
    const page = await readWorkspaceTextPage(root, "lines.txt", 0);
    expect(page.eof).toBe(false);
    expect(page.text.endsWith("\n")).toBe(true);
    expect(page.text.startsWith("line 1\n")).toBe(true);
    expect(page.lines).toBe(TEXT_PAGE_LINES);
  });

  it("walks to the end with nothing lost and nothing repeated", async () => {
    const { text, lineCounts } = await walk("lines.txt");
    expect(text).toBe(numberedLines(5000));
    // The counts are what the reader numbers its lines with, so they have to add
    // up to the file's line count exactly.
    expect(lineCounts.reduce((sum, count) => sum + count, 0)).toBe(5000);
  });

  it("takes one line longer than the byte budget whole rather than never advancing", async () => {
    const page = await readWorkspaceTextPage(root, "huge.txt", 0);
    expect(page.text.length).toBe(TEXT_PAGE_BYTES);
    expect(page.nextOffset).toBe(TEXT_PAGE_BYTES);
    expect(page.eof).toBe(false);
    // One (partial) line, which is all a file with no newline in it has.
    expect(page.lines).toBe(1);

    const second = await readWorkspaceTextPage(root, "huge.txt", page.nextOffset);
    expect(second.offset).toBe(TEXT_PAGE_BYTES);
    expect(second.nextOffset).toBeGreaterThan(second.offset);
  });

  it("keeps a multi-byte character out of the seam", async () => {
    // `TEXT_PAGE_BYTES` is not a multiple of three, so the byte cut lands inside
    // a character; the page has to back up to a boundary, or both sides of the
    // seam come back with a replacement character.
    const page = await readWorkspaceTextPage(root, "wide.txt", 0);
    expect(page.nextOffset % 3).toBe(0);
    expect(page.text.includes("\uFFFD")).toBe(false);
    expect(page.text.length).toBe(page.nextOffset / 3);

    const second = await readWorkspaceTextPage(root, "wide.txt", page.nextOffset);
    expect(second.text.includes("\uFFFD")).toBe(false);
    expect(second.text.startsWith("字")).toBe(true);
  });

  it("answers an offset at the end with an empty final page", async () => {
    // How a reader discovers the end without an extra round trip: it is told
    // the offset is the size, and asking anyway is not an error.
    const page = await readWorkspaceTextPage(root, "src/index.ts", 9999);
    expect(page).toMatchObject({ offset: page.size, nextOffset: page.size, text: "", lines: 0, eof: true });
  });

  it("refuses a binary file on the first page", async () => {
    await expect(readWorkspaceTextPage(root, "blob.dat", 0)).rejects.toThrow(/二进制/);
  });

  it("refuses to read outside the project through a symlink", async () => {
    await expect(readWorkspaceTextPage(root, "escape.txt", 0)).rejects.toThrow(/超出项目目录/);
  });

  it("rejects a directory and a missing path", async () => {
    await expect(readWorkspaceTextPage(root, "src", 0)).rejects.toThrow(/这是一个目录/);
    await expect(readWorkspaceTextPage(root, "nope.txt", 0)).rejects.toThrow(/路径不存在/);
  });
});

describe("readWorkspaceRaw", () => {
  it("hands a pdf over with the type the browser's viewer keys off", async () => {
    const file = await readWorkspaceRaw(root, "archive.pdf");
    expect(file.mimeType).toBe("application/pdf");
    expect(file.name).toBe("archive.pdf");
    expect(file.size).toBe("%PDF-1.4".length);
    // The resolved location, so the route streams without re-deriving a path
    // this module already checked.
    expect(file.absolutePath.endsWith("archive.pdf")).toBe(true);
  });

  it("refuses a format with no built-in viewer", async () => {
    await expect(readWorkspaceRaw(root, "README.md")).rejects.toThrow(/没有内置查看器/);
    await expect(readWorkspaceRaw(root, "blob.dat")).rejects.toThrow(/没有内置查看器/);
  });

  it("refuses to read outside the project through a symlink", async () => {
    await expect(readWorkspaceRaw(root, "escape.txt")).rejects.toThrow(/超出项目目录/);
  });

  it("rejects a directory", async () => {
    await expect(readWorkspaceRaw(root, "src")).rejects.toThrow(/这是一个目录/);
  });
});

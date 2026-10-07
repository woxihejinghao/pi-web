import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";
import { badRequest, forbidden, HttpError, notFound } from "./errors.ts";

/**
 * The file source behind the right sidebar's Files and Preview tabs.
 *
 * Everything here is addressed *relative to a project directory*, never by
 * absolute path: the API's allowlist is the project list, and a request that
 * could name any path on the machine would turn a localhost server into a
 * general file reader. Both directions are canonicalized and re-checked, so a
 * symlink pointing outside the project is refused rather than followed.
 */

/** Entries returned for one directory before the listing is cut short. */
export const ENTRY_LIMIT = 500;

/** Text read cap. Larger files come back truncated rather than refused. */
export const TEXT_LIMIT = 1024 * 1024;

/**
 * Bytes one page of a paged text read may cover.
 *
 * Paging exists because asking for a whole file at once has no good answer for
 * a large one: the read cap ends a file mid-line and says so, which leaves the
 * reader looking at the head of a log they cannot get past. A page is bounded by
 * bytes *and* lines, and always ends just after a newline, so the next request
 * continues from a line start.
 */
export const TEXT_PAGE_BYTES = 256 * 1024;

/** Lines one page of a paged text read may cover. */
export const TEXT_PAGE_LINES = 2000;

/** Image cap. Larger images are refused: half a picture is worse than none. */
export const IMAGE_LIMIT = 8 * 1024 * 1024;

/** PDF cap. Larger documents are refused rather than handed over half-rendered. */
export const PDF_LIMIT = 64 * 1024 * 1024;

export interface WorkspaceEntry {
  name: string;
  /** Path relative to the project root, always `/`-separated. */
  path: string;
  type: "directory" | "file" | "other";
}

export interface WorkspaceListing {
  /** The listed directory, relative to the project root (`""` = the root). */
  path: string;
  entries: WorkspaceEntry[];
  /** True when the directory held more entries than `ENTRY_LIMIT`. */
  truncated: boolean;
}

export type WorkspaceFileKind = "text" | "image" | "pdf" | "unsupported";

export interface WorkspaceFileContent {
  path: string;
  name: string;
  kind: WorkspaceFileKind;
  size: number;
  /** True when a text file was longer than `TEXT_LIMIT`. */
  truncated: boolean;
  /** UTF-8 text for `text`, base64 for `image`, empty for `pdf`/`unsupported`. */
  content: string;
  /** Set for `image` only. */
  mimeType?: string;
  /** Set for `unsupported` only; already localized for display. */
  reason?: string;
}

/**
 * One page of a text file.
 *
 * Addressed by byte offset rather than by line number because a line number
 * cannot be resolved without reading everything before it: a 2000-line page 40
 * pages into a log would rescan 40 growing prefixes. Offsets make the walk
 * linear, and `lines` still counts what the reader sees.
 */
export interface WorkspaceTextPage {
  path: string;
  name: string;
  /** Byte offset this page starts at; `0` for the first page. */
  offset: number;
  /** Byte offset the next page starts at; equals `size` at the end. */
  nextOffset: number;
  /** Lines this page holds, so the caller can number the next page's first one. */
  lines: number;
  text: string;
  size: number;
  /** True when this page reached the end of the file. */
  eof: boolean;
}

/** A file handed to the browser rather than rendered here. */
export interface WorkspaceRawFile {
  name: string;
  /** The content type the browser's own viewer keys off. */
  mimeType: string;
  size: number;
  /** Already canonicalized and checked to be inside the project. */
  absolutePath: string;
}


/**
 * Extensions the Preview tab can render as a picture. SVG is included because
 * it is drawn through an `<img>`, where its scripts cannot run — the same
 * reasoning dsh uses for its static-image context.
 */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/**
 * Containers this UI knows it cannot render. Listing them up front means an
 * `.xlsx` reports "unsupported" instead of being decoded as mojibake, and it
 * saves the read entirely. `pdf` is deliberately absent: it has a viewer — the
 * browser's own, reached through `/raw` — so it is a kind of its own.
 */
const BINARY_EXTENSIONS = new Set([
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "tar",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "wasm",
  "so",
  "dylib",
  "dll",
  "exe",
  "bin",
  "class",
  "jar",
  "o",
  "a",
  "sqlite",
  "sqlite3",
  "db",
  "parquet",
  "mp3",
  "m4a",
  "wav",
  "flac",
  "ogg",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
]);

/** Human-readable size for the messages this module raises. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Split a client-supplied relative path into its segments.
 *
 * The `/`-separated form is wire format, not a filesystem path, so it is
 * checked rather than handed to `resolve`: absolute inputs, drive letters and
 * `..` are rejected here, before any filesystem call. A leading `./` and the
 * empty string are both accepted (`""` means the project root).
 *
 * Exported because the git module takes paths from the client too (staging,
 * discarding): git confines a pathspec to its own work tree anyway, and this
 * makes the refusal happen here, with a message the UI can show.
 */
export function assertRelativePath(input: string): string[] {
  if (input.startsWith("/") || /^[a-zA-Z]:/.test(input)) {
    throw forbidden(`路径必须是相对路径：${input}`);
  }
  const segments = input.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw forbidden(`路径不能包含 ..：${input}`);
  }
  return segments;
}

/**
 * Resolve a relative path inside the project, refusing anything that lands
 * outside it once symlinks are followed.
 *
 * The lexical check catches the obvious escapes; `realpath` is what stops
 * `link-to-etc/passwd`, which is a legitimate relative path pointing at a real
 * file somewhere else. Both the root and the target are canonicalized so the
 * comparison is between two resolved paths.
 */
async function resolveInsideProject(
  root: string,
  relative: string,
): Promise<{ target: string; relative: string }> {
  const segments = assertRelativePath(relative);

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    throw notFound(`项目目录不存在：${root}`);
  }

  const requested = segments.length > 0 ? join(canonicalRoot, ...segments) : canonicalRoot;
  let target: string;
  try {
    target = await realpath(requested);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notFound(`路径不存在：${segments.join("/") || "."}`);
    if (code === "EACCES") throw forbidden(`没有权限访问：${segments.join("/")}`);
    throw err;
  }

  if (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep)) {
    throw forbidden(`路径超出项目目录：${segments.join("/")}`);
  }
  return { target, relative: segments.join("/") };
}

/** The entry type a dirent describes, following a symlink one level. */
async function entryType(
  absolutePath: string,
  dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
): Promise<WorkspaceEntry["type"]> {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  if (dirent.isSymbolicLink()) {
    try {
      const info = await stat(absolutePath);
      return info.isDirectory() ? "directory" : "file";
    } catch {
      // A dangling symlink is reported as "other" so the row is drawn disabled
      // rather than vanishing from a listing that really has an entry there.
      return "other";
    }
  }
  return "other";
}

/**
 * List one directory level under the project root.
 *
 * One level at a time, like dsh's tree: a deep workspace would otherwise turn
 * the first paint of the panel into a full recursive walk.
 */
export async function listWorkspaceDirectory(
  root: string,
  relative = "",
): Promise<WorkspaceListing> {
  const { target, relative: normalized } = await resolveInsideProject(root, relative);

  const info = await stat(target);
  if (!info.isDirectory()) throw badRequest(`不是一个目录：${normalized || "."}`);

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      throw forbidden(`没有权限读取：${normalized || "."}`);
    }
    throw new HttpError(500, `无法读取目录：${normalized || "."}`);
  }

  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents) {
    const path = normalized.length > 0 ? `${normalized}/${dirent.name}` : dirent.name;
    entries.push({
      name: dirent.name,
      path,
      type: await entryType(join(target, dirent.name), dirent),
    });
  }

  // Directories first, then a natural, case-insensitive order. Dot entries are
  // not hidden — a workspace's `.github`/`.env.example` are part of its shape —
  // they simply sort among the rest.
  entries.sort((a, b) => {
    const kind = Number(b.type === "directory") - Number(a.type === "directory");
    if (kind !== 0) return kind;
    return a.name.localeCompare(b.name, "zh", { numeric: true, sensitivity: "base" });
  });

  const truncated = entries.length > ENTRY_LIMIT;
  return {
    path: normalized,
    entries: truncated ? entries.slice(0, ENTRY_LIMIT) : entries,
    truncated,
  };
}

/**
 * Read one file for the Preview tab.
 *
 * Three outcomes, decided in this order: a known image extension is read as
 * bytes, a known binary container reports "unsupported" without a read, and
 * everything else is read as text up to `TEXT_LIMIT`. A NUL byte in a text
 * read is what catches the binary nobody listed — decoded output of such a
 * file is mojibake, which reads as a rendering bug rather than as a file this
 * UI cannot show.
 */
export async function readWorkspaceFile(
  root: string,
  relative: string,
): Promise<WorkspaceFileContent> {
  if (typeof relative !== "string" || relative.length === 0) {
    throw badRequest("path is required");
  }
  const { target, relative: normalized } = await resolveInsideProject(root, relative);

  const info = await stat(target);
  if (info.isDirectory()) throw badRequest(`这是一个目录：${normalized}`);
  if (!info.isFile()) throw badRequest(`不是一个普通文件：${normalized}`);

  const name = basename(normalized);
  const extension = extname(name).slice(1).toLowerCase();

  const mimeType = IMAGE_MIME[extension];
  if (mimeType !== undefined) {
    if (info.size > IMAGE_LIMIT) {
      throw new HttpError(413, `文件过大（${formatSize(info.size)}），无法预览`);
    }
    const buffer = await readFile(target);
    return {
      path: normalized,
      name,
      kind: "image",
      mimeType,
      size: info.size,
      truncated: false,
      content: buffer.toString("base64"),
    };
  }

  // A PDF is not read here at all: the bytes go to the browser untouched
  // through `/raw`, because the only renderer for them is the browser's own.
  // Answering with the size is what lets the tab mount that viewer.
  if (extension === "pdf") {
    if (info.size > PDF_LIMIT) {
      throw new HttpError(413, `文件过大（${formatSize(info.size)}），无法预览`);
    }
    return {
      path: normalized,
      name,
      kind: "pdf",
      size: info.size,
      truncated: false,
      content: "",
    };
  }

  if (BINARY_EXTENSIONS.has(extension)) {
    return {
      path: normalized,
      name,
      kind: "unsupported",
      size: info.size,
      truncated: false,
      content: "",
      reason: `${extension.toUpperCase()} 文件暂不支持预览`,
    };
  }

  const handle = await open(target, "r");
  try {
    const length = Math.min(info.size, TEXT_LIMIT);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, 0);
    if (buffer.includes(0)) {
      return {
        path: normalized,
        name,
        kind: "unsupported",
        size: info.size,
        truncated: false,
        content: "",
        reason: "二进制文件暂不支持预览",
      };
    }
    return {
      path: normalized,
      name,
      kind: "text",
      size: info.size,
      truncated: info.size > TEXT_LIMIT,
      content: buffer.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

const NEWLINE = 0x0a;

/** Bytes the UTF-8 sequence introduced by `lead` occupies; 1 for anything odd. */
function sequenceLength(lead: number): number {
  if ((lead & 0x80) === 0) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

/**
 * Trim a byte cut back onto a character boundary.
 *
 * Reachable only for a single line longer than the page budget — every other
 * page ends just after a newline, which is ASCII and therefore already a
 * boundary. Cutting inside a multi-byte character would put a replacement
 * character on each side of the seam.
 *
 * Works from the window's last byte backwards, because the byte at the cut is
 * the one that is *not* in the window: find the lead byte of the sequence the
 * cut lands in, and drop that sequence when it does not fit inside the window.
 */
function utf8SafeCut(buffer: Buffer, cut: number): number {
  let lead = cut - 1;
  while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  return lead + sequenceLength(buffer[lead] ?? 0) <= cut ? cut : lead;
}

/**
 * How many bytes of a freshly read window belong to this page.
 *
 * The page ends just after a newline so the next one starts at a line start;
 * only the file's last page may end mid-line. `maxLines` then trims a window
 * that happens to hold more lines than one page may carry.
 */
function pageLength(buffer: Buffer, reachesEof: boolean, maxLines: number): number {
  const end = reachesEof ? buffer.length : buffer.lastIndexOf(NEWLINE) + 1;
  // No newline in the whole window: one line longer than the page budget. It is
  // taken whole — a page that refused to advance would ask for itself forever —
  // which is also why this is the one cut that needs a boundary check.
  if (end === 0) return utf8SafeCut(buffer, buffer.length);

  let seen = 0;
  for (
    let index = buffer.indexOf(NEWLINE);
    index !== -1 && index < end;
    index = buffer.indexOf(NEWLINE, index + 1)
  ) {
    seen += 1;
    if (seen === maxLines) return index + 1;
  }
  return end;
}

/** Lines a page of text holds, counting a final line that has no newline. */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return text.endsWith("\n") ? count : count + 1;
}

/**
 * Read one page of a text file, for files too large to hand over whole.
 *
 * The page is addressed by the byte offset the caller got back from the previous
 * one, so a walk through a large file reads each byte once. `offset` may be
 * anything the caller holds; it is clamped, and an offset at or past the end
 * answers with an empty final page rather than an error, because that is the
 * ordinary way a reader discovers it has reached the end.
 */
export async function readWorkspaceTextPage(
  root: string,
  relative: string,
  offset = 0,
): Promise<WorkspaceTextPage> {
  const { target, relative: normalized } = await resolveInsideProject(root, relative);
  const info = await stat(target);
  if (info.isDirectory()) throw badRequest(`这是一个目录：${normalized}`);
  if (!info.isFile()) throw badRequest(`不是一个普通文件：${normalized}`);

  const name = basename(normalized);
  const start = Number.isFinite(offset) ? Math.min(Math.max(0, Math.floor(offset)), info.size) : 0;
  const base = { path: normalized, name, size: info.size };

  if (start >= info.size) {
    return { ...base, offset: info.size, nextOffset: info.size, lines: 0, text: "", eof: true };
  }

  const length = Math.min(TEXT_PAGE_BYTES, info.size - start);
  const buffer = Buffer.alloc(length);
  const handle = await open(target, "r");
  try {
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }

  // The same test the whole-file read makes, and only on the first page: a NUL
  // is what catches the binary nobody listed, and the client only asks for more
  // pages of a file the first page already proved to be text.
  if (start === 0 && buffer.includes(0)) {
    throw badRequest(`二进制文件暂不支持预览：${normalized}`);
  }

  const end = pageLength(buffer, start + length >= info.size, TEXT_PAGE_LINES);
  const text = buffer.subarray(0, end).toString("utf8");
  const nextOffset = start + end;
  return {
    ...base,
    offset: start,
    nextOffset,
    lines: countLines(text),
    text,
    eof: nextOffset >= info.size,
  };
}

/**
 * The one format the sidebar hands to the browser instead of drawing itself.
 *
 * Everything else in this module comes back as JSON for the app to render. A
 * PDF cannot: it needs a real document viewer, and the only one guaranteed to be
 * present is the browser's own, which keys off the content type of a response.
 * So this answers with the file's location and its type, and the route streams
 * the bytes.
 */
const RAW_MIME: Record<string, string> = { pdf: "application/pdf" };

export async function readWorkspaceRaw(
  root: string,
  relative: string,
): Promise<WorkspaceRawFile> {
  const { target, relative: normalized } = await resolveInsideProject(root, relative);
  const info = await stat(target);
  if (info.isDirectory()) throw badRequest(`这是一个目录：${normalized}`);
  if (!info.isFile()) throw badRequest(`不是一个普通文件：${normalized}`);

  const name = basename(normalized);
  const mimeType = RAW_MIME[extname(name).slice(1).toLowerCase()];
  if (mimeType === undefined) {
    throw badRequest(`这种文件没有内置查看器：${name}`);
  }
  if (info.size > PDF_LIMIT) {
    throw new HttpError(413, `文件过大（${formatSize(info.size)}），无法预览`);
  }
  return { name, mimeType, size: info.size, absolutePath: target };
}


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

/** Image cap. Larger images are refused: half a picture is worse than none. */
export const IMAGE_LIMIT = 8 * 1024 * 1024;

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

export type WorkspaceFileKind = "text" | "image" | "unsupported";

export interface WorkspaceFileContent {
  path: string;
  name: string;
  kind: WorkspaceFileKind;
  size: number;
  /** True when a text file was longer than `TEXT_LIMIT`. */
  truncated: boolean;
  /** UTF-8 text for `text`, base64 for `image`, empty for `unsupported`. */
  content: string;
  /** Set for `image` only. */
  mimeType?: string;
  /** Set for `unsupported` only; already localized for display. */
  reason?: string;
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
 * saves the read entirely.
 */
const BINARY_EXTENSIONS = new Set([
  "pdf",
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

import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { badRequest, forbidden, HttpError, notFound } from "./errors.ts";
import { expandHome } from "./projects.ts";

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  /** Canonical absolute path of the listed directory. */
  path: string;
  /** Parent directory, or null at a filesystem root. */
  parent: string | null;
  entries: DirEntry[];
}

export interface StartLocation {
  label: string;
  path: string;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Convenience roots offered when the picker opens with no path. */
export async function startLocations(): Promise<StartLocation[]> {
  const home = homedir();
  const candidates: StartLocation[] = [
    { label: "主目录", path: home },
    { label: "桌面", path: join(home, "Desktop") },
    { label: "文稿", path: join(home, "Documents") },
    { label: "下载", path: join(home, "Downloads") },
    { label: "根目录", path: sep },
  ];
  const available: StartLocation[] = [];
  for (const candidate of candidates) {
    if (await isDirectory(candidate.path)) available.push(candidate);
  }
  return available;
}

/**
 * List the sub-directories of one directory.
 *
 * A browser cannot hand back an absolute path (neither `webkitdirectory` nor
 * the File System Access API exposes one), so the picker is driven by the
 * server side of the same machine. Only directory names are ever returned —
 * never file contents.
 */
export async function listDirectories(input?: string): Promise<DirListing> {
  const requested = input?.trim();
  const absolute = resolve(expandHome(requested && requested.length > 0 ? requested : homedir()));

  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notFound(`目录不存在：${absolute}`);
    if (code === "EACCES") throw forbidden(`没有权限访问：${absolute}`);
    throw err;
  }
  if (!(await isDirectory(canonical))) {
    throw badRequest(`不是目录：${canonical}`);
  }

  let dirents;
  try {
    dirents = await readdir(canonical, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      throw forbidden(`没有权限读取：${canonical}`);
    }
    throw new HttpError(500, `无法读取目录：${canonical}`);
  }

  const entries: DirEntry[] = [];
  for (const dirent of dirents) {
    const childPath = join(canonical, dirent.name);
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: childPath });
    } else if (dirent.isSymbolicLink() && (await isDirectory(childPath))) {
      // A symlinked directory is a legitimate project root.
      entries.push({ name: dirent.name, path: childPath });
    }
  }

  // Dot-directories are legitimate targets (e.g. ~/.config) but rarely the
  // intent, so they sort last instead of disappearing.
  entries.sort((a, b) => {
    const hidden = Number(a.name.startsWith(".")) - Number(b.name.startsWith("."));
    if (hidden !== 0) return hidden;
    return a.name.localeCompare(b.name, "zh");
  });

  const parent = dirname(canonical);
  return {
    path: canonical,
    parent: parent === canonical ? null : parent,
    entries,
  };
}

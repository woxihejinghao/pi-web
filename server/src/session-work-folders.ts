import { chmod, lstat, mkdir, readdir, realpath, rename, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DATA_DIR } from "./config.ts";
import { badRequest, conflict, forbidden } from "./errors.ts";
import { expandHome } from "./projects.ts";
import { mutateStore, readStore } from "./store.ts";

export interface WorkFolderMove { source: string; destination: string }

// Serialize association edits and moves, including different chats that might
// claim overlapping folders. No asynchronous store callback or nested lock.
let mutationQueue: Promise<unknown> = Promise.resolve();
export function withWorkFolderLock<T>(run: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(run, run);
  mutationQueue = next.catch(() => undefined);
  return next;
}
const within = (path: string, root: string) => path === root || path.startsWith(root + sep);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
export function getWorkFolderRoot(): string {
  return resolve(expandHome(process.env.PI_WEB_SIMPLE_WORKSPACE_DIR ?? join(homedir(), "pi", "workspace")));
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Validate a dedicated folder, not a shared workspace or pi's private data. */
export async function validateWorkFolders(sessionPath: string, paths: unknown, sessionRoot: string): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length > 32 || !paths.every((path) => typeof path === "string")) {
    throw badRequest("workFolders must be an array of at most 32 paths");
  }
  const store = await readStore();
  const root = paths.length ? await realpath(getWorkFolderRoot()).catch(() => { throw badRequest("workspace root does not exist"); }) : getWorkFolderRoot();
  const folders: string[] = [];
  for (const input of paths as string[]) {
    const expanded = expandHome(input);
    if (!isAbsolute(expanded)) throw badRequest("work folder must be an absolute path");
    const path = resolve(expanded);
    const stats = await lstat(path).catch(() => { throw badRequest(`work folder does not exist: ${path}`); });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw badRequest("work folder must be a real directory, not a symlink");
    const canonical = await realpath(path);
    if (canonical.split(sep).some((part) => part === ".git" || part === ".pi")) {
      throw forbidden("cannot associate repository or pi metadata directories directly");
    }
    if (canonical === root || !within(canonical, root)) throw forbidden("work folder must be strictly inside the workspace root");
    if ([resolve(sessionRoot), resolve(DATA_DIR), resolve(homedir(), ".pi")].some((protectedPath) => overlaps(canonical, protectedPath))) {
      throw forbidden("cannot associate pi's internal data");
    }
    if (store.projects.some((project) => within(project.path, canonical))) {
      throw conflict("choose a dedicated work folder, not a registered workspace or its ancestor");
    }
    if (folders.some((folder) => overlaps(folder, canonical))) throw conflict("work folders must not overlap");
    for (const [otherSession, override] of Object.entries(store.sessionOverrides)) {
      if (otherSession !== sessionPath && override.workFolders?.some((folder) => overlaps(folder, canonical))) {
        throw conflict("work folder is already associated with another chat");
      }
    }
    folders.push(canonical);
  }
  return folders;
}

export async function saveWorkFolders(sessionPath: string, paths: unknown, sessionRoot: string): Promise<string[]> {
  const current = (await readStore()).sessionOverrides[sessionPath]?.workFolders ?? [];
  // Removing a stale association must remain possible even if a folder (or
  // the configured root) has disappeared. Additions always require validation.
  const removingOnly = Array.isArray(paths) && paths.length <= 32
    && paths.every((path) => typeof path === "string" && current.includes(path));
  const folders = removingOnly ? [...new Set(paths as string[])] : await validateWorkFolders(sessionPath, paths, sessionRoot);
  await mutateStore((draft) => {
    const override = { ...draft.sessionOverrides[sessionPath], workFolders: folders };
    draft.sessionOverrides[sessionPath] = override;
  });
  return folders;
}

export async function planWorkFolderMoves(sessionPath: string, targetFolder: string, sessionRoot: string): Promise<{ workFolders: string[]; moves: WorkFolderMove[] }> {
  const associated = (await readStore()).sessionOverrides[sessionPath]?.workFolders ?? [];
  const workFolders = await validateWorkFolders(sessionPath, associated, sessionRoot);
  if (!workFolders.length) return { workFolders, moves: [] };
  const target = await realpath(targetFolder);
  if (target !== resolve(targetFolder)) throw conflict("destination workspace path changed; re-add the workspace before moving files");
  const root = await realpath(getWorkFolderRoot());
  if (!within(target, root)) throw forbidden("work folders can only move within the workspace root");
  const moves: WorkFolderMove[] = [];
  const names = new Set<string>();
  for (const source of workFolders) {
    const destination = join(target, basename(source));
    if (source === destination) continue;
    if (within(target, source)) throw badRequest("cannot move a work folder into itself");
    if (names.has(destination) || await exists(destination)) throw conflict(`destination work folder already exists: ${destination}`);
    names.add(destination);
    moves.push({ source, destination });
  }
  return { workFolders, moves };
}

/** Reserve every destination exclusively before touching sources. Transfer
 * entries without dereferencing symlinks; no recursive delete/copy fallback.
 * Rollback only entries we moved, never overwrite or delete unrelated files.
 * Cross-device moves fail and roll back rather than silently copying data.
 */
export async function moveWorkFolders(moves: WorkFolderMove[], renameEntry = rename): Promise<() => Promise<void>> {
  const reserved: Array<WorkFolderMove & { mode: number; entries: string[] }> = [];
  const rollback = async () => {
    const failures: string[] = [];
    for (const move of [...reserved].reverse()) {
      try {
        await chmod(move.destination, 0o700);
        if (!await exists(move.source)) await mkdir(move.source, { mode: move.mode });
        for (const entry of [...move.entries].reverse()) {
          const original = join(move.source, entry);
          if (await exists(original)) throw new Error(`recovery path occupied: ${original}`);
          await renameEntry(join(move.destination, entry), original);
        }
        await rmdir(move.destination);
      } catch (error) { failures.push(String(error)); }
    }
    if (failures.length) throw new Error(`work-folder rollback needs attention; files retained at source/destination: ${failures.join("; ")}`);
  };
  try {
    for (const move of moves) {
      const stats = await lstat(move.source);
      if (!stats.isDirectory() || stats.isSymbolicLink() || await realpath(move.source) !== move.source) {
        throw conflict("work folder changed since validation");
      }
      if (await realpath(dirname(move.destination)) !== dirname(move.destination)) throw conflict("destination parent changed since validation");
      try { await mkdir(move.destination, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict(`destination work folder already exists: ${move.destination}`);
        throw error;
      }
      reserved.push({ ...move, mode: stats.mode & 0o777, entries: [] });
    }
    for (const move of reserved) {
      for (const entry of await readdir(move.source)) {
        if (await exists(join(move.destination, entry))) throw conflict("destination changed during move");
        await renameEntry(join(move.source, entry), join(move.destination, entry));
        move.entries.push(entry);
      }
      // Fails if another writer added a file: never recursively remove a source.
      await rmdir(move.source);
      await chmod(move.destination, move.mode);
    }
    return rollback;
  } catch (error) {
    try { await rollback(); }
    catch (recovery) { throw new AggregateError([error, recovery], "move failed; work folders require recovery"); }
    throw error;
  }
}

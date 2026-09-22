import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import {
  mutateStore,
  readStore,
  type ProjectRecord,
  type SessionOverride,
} from "./store.ts";

export type ProjectErrorCode = "ENOENT" | "ENOTDIR" | "EEXIST" | "ENOTFOUND" | "EINVALID";

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

export interface ProjectView extends ProjectRecord {
  /**
   * Whether the directory still exists. Deleting a project never touches the
   * folder or its sessions, so a record can outlive its path.
   */
  exists: boolean;
}

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

/**
 * Resolve a user-supplied path to its canonical form. `fs.realpath` is the one
 * uniqueness canon (matching dsh): trailing slashes, `..`, and symlinks are all
 * collapsed, so two spellings of the same directory collide as intended.
 */
export async function canonicalizePath(input: string): Promise<string> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ProjectError("EINVALID", "path is required");
  }
  const absolute = resolve(expandHome(trimmed));
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectError("ENOENT", `directory does not exist: ${absolute}`);
    }
    throw err;
  }
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new ProjectError("ENOTDIR", `not a directory: ${canonical}`);
  }
  return canonical;
}

/** Final path segment, or the path itself for a filesystem root. */
export function defaultTitle(path: string): string {
  return basename(path) || path;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function listProjects(): Promise<ProjectView[]> {
  const store = await readStore();
  const ordered = [...store.projects].sort((a, b) => a.order - b.order);
  return Promise.all(
    ordered.map(async (project) => ({ ...project, exists: await directoryExists(project.path) })),
  );
}

export async function getProject(id: string): Promise<ProjectView> {
  const store = await readStore();
  const project = store.projects.find((p) => p.id === id);
  if (!project) throw new ProjectError("ENOTFOUND", `no project with id ${id}`);
  return { ...project, exists: await directoryExists(project.path) };
}

export async function addProject(inputPath: string, title?: string): Promise<ProjectView> {
  const canonical = await canonicalizePath(inputPath);
  return mutateStore((draft) => {
    if (draft.projects.some((p) => p.path === canonical)) {
      throw new ProjectError("EEXIST", `project already registered: ${canonical}`);
    }
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: randomUUID(),
      path: canonical,
      title: title?.trim() || defaultTitle(canonical),
      order: draft.projects.length,
      createdAt: now,
      updatedAt: now,
    };
    draft.projects.push(record);
    return { ...record, exists: true };
  });
}

export async function renameProject(id: string, title: string): Promise<ProjectRecord> {
  return mutateStore((draft) => {
    const project = draft.projects.find((p) => p.id === id);
    if (!project) throw new ProjectError("ENOTFOUND", `no project with id ${id}`);
    project.title = title.trim() || defaultTitle(project.path);
    project.updatedAt = new Date().toISOString();
    return { ...project };
  });
}

/** Removes the record only: the folder and every session stay on disk. */
export async function removeProject(id: string): Promise<void> {
  await mutateStore((draft) => {
    const index = draft.projects.findIndex((p) => p.id === id);
    if (index < 0) throw new ProjectError("ENOTFOUND", `no project with id ${id}`);
    draft.projects.splice(index, 1);
    draft.projects.forEach((project, i) => {
      project.order = i;
    });
  });
}

export async function reorderProjects(orderedIds: string[]): Promise<ProjectRecord[]> {
  return mutateStore((draft) => {
    if (orderedIds.length !== draft.projects.length) {
      throw new ProjectError("EINVALID", "reorder must list every project exactly once");
    }
    const byId = new Map(draft.projects.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const next: ProjectRecord[] = [];
    for (const id of orderedIds) {
      const project = byId.get(id);
      if (!project || seen.has(id)) {
        throw new ProjectError("EINVALID", "reorder must list every project exactly once");
      }
      seen.add(id);
      next.push(project);
    }
    next.forEach((project, i) => {
      project.order = i;
    });
    draft.projects = next;
    return next.map((p) => ({ ...p }));
  });
}

export async function getSessionOverrides(): Promise<Record<string, SessionOverride>> {
  const store = await readStore();
  return store.sessionOverrides;
}

/**
 * Merge an override for one session. Passing an empty object clears it, which
 * lets "rename back to automatic" be expressed without a separate endpoint.
 */
export async function setSessionOverride(
  sessionPath: string,
  override: SessionOverride,
): Promise<SessionOverride | null> {
  const key = resolve(expandHome(sessionPath));
  return mutateStore((draft) => {
    const merged: SessionOverride = { ...draft.sessionOverrides[key], ...override };
    if (merged.name !== undefined && merged.name.trim().length === 0) delete merged.name;
    if (merged.hidden === false) delete merged.hidden;
    if (Object.keys(merged).length === 0) {
      delete draft.sessionOverrides[key];
      return null;
    }
    draft.sessionOverrides[key] = merged;
    return merged;
  });
}

/**
 * Forget every UI override for a session, called when its file is deleted.
 *
 * An override is keyed by path, so leaving it behind would keep the deleted
 * session's Web-side name (or hidden flag) in `store.json` forever — and hand
 * it to whatever session landed at that path next.
 */
export async function removeSessionOverride(sessionPath: string): Promise<void> {
  const key = resolve(expandHome(sessionPath));
  await mutateStore((draft) => {
    delete draft.sessionOverrides[key];
  });
}

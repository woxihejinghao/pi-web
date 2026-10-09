import type { ProjectView } from "./types.ts";

/** Paths arrive from the server as POSIX paths (this app targets macOS/Linux). */
const sep = "/";

export interface ProjectNode {
  project: ProjectView;
  children: ProjectNode[];
  depth: number;
}

/** True when `ancestor` is a strict directory ancestor of `descendant`. */
function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return false;
  const prefix = ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`;
  return descendant.startsWith(prefix);
}

/**
 * Order the registered projects into the rows the sidebar draws.
 *
 * `nest` is dsh's `nestWorkspaces`: on, each project falls under its nearest
 * registered ancestor directory (its "Workspace Tree" grouping); off, every
 * project is a root of its own (its plain "Workspaces" grouping). Both read the
 * same `order` field, so switching between them never reshuffles what the
 * server holds — the ids in `projects` stay the authority either way.
 *
 * @param projects - every registered workspace.
 * @param options.nest - nest under ancestor directories (default true).
 * @returns the root nodes, each carrying its depth from the top level.
 */
export function buildProjectTree(
  projects: ProjectView[],
  options: { nest?: boolean } = {},
): ProjectNode[] {
  const nest = options.nest ?? true;
  const ordered = [...projects].sort((a, b) => a.order - b.order);

  const parentOf = new Map<string, string | null>();
  for (const project of ordered) {
    let nearest: ProjectView | null = null;
    if (nest) {
      for (const candidate of ordered) {
        if (candidate.id === project.id) continue;
        if (!isAncestor(candidate.path, project.path)) continue;
        if (!nearest || candidate.path.length > nearest.path.length) nearest = candidate;
      }
    }
    parentOf.set(project.id, nearest?.id ?? null);
  }

  const nodes = new Map<string, ProjectNode>();
  for (const project of ordered) {
    nodes.set(project.id, { project, children: [], depth: 0 });
  }

  const roots: ProjectNode[] = [];
  for (const project of ordered) {
    const node = nodes.get(project.id)!;
    const parentId = parentOf.get(project.id);
    if (parentId) nodes.get(parentId)!.children.push(node);
    else roots.push(node);
  }

  const assignDepth = (list: ProjectNode[], depth: number): void => {
    for (const node of list) {
      node.depth = depth;
      assignDepth(node.children, depth + 1);
    }
  };
  assignDepth(roots, 0);

  return roots;
}

/** Depth-first flatten, so rendering and search can walk one ordered list. */
export function flattenProjectTree(roots: ProjectNode[]): ProjectNode[] {
  const out: ProjectNode[] = [];
  const walk = (list: ProjectNode[]): void => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}

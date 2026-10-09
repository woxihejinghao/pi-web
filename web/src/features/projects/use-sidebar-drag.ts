/**
 * Drag-and-drop reordering for the sidebar's rows.
 *
 * The whole tree is one drag surface, so the in-flight state lives here rather
 * than in a row: a workspace can be dropped on a *different* workspace's
 * header, and both rows have to agree on what is being dragged and where the
 * marker goes. dsh keeps the same state on its `SessionTree`
 * (`ui-workspace/rows/WorkspaceBrowser.tsx`), and the row wiring here — the
 * `dragover`/`drop` pair, `rowHalf`, the document-level acceptance — is its
 * `RowDragProps`.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { actions, appStore, isDraftSession } from "../../lib/app-state.ts";
import { flattenProjectTree, type ProjectNode } from "../../lib/project-tree.ts";
import { FLAT_ORDER_KEY, rowHalf } from "../../lib/sidebar-view.ts";
import { flatSessionRowsOf, sessionRowsOf } from "./session-rows.ts";

/** Which edge of a row a drop lands on. */
type Half = "before" | "after";

/** The row a drag started from. */
type DragSource =
  | { kind: "session"; accountKey: string; path: string }
  | { kind: "project"; projectId: string; parentId: string | null };

/** Where the insertion marker currently sits. */
type DragOver =
  | { kind: "session"; accountKey: string; path: string; half: Half }
  | { kind: "project"; projectId: string; half: Half };

interface DragState {
  source: DragSource;
  over: DragOver | null;
}

/** The handlers one row spreads onto its element. */
export interface RowDragHandlers {
  /** False for a row that has nothing to save a position for (a draft). */
  draggable: boolean;
  /** The insert marker this row is drawing right now, or null. */
  marker: Half | null;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
}

/** What every row needs in order to take part in a drag. */
export interface SidebarDrag {
  /** Wiring for one session row. */
  sessionRow: (accountKey: string, path: string) => RowDragHandlers;
  /** Wiring for one workspace header row. */
  projectRow: (projectId: string) => RowDragHandlers;
}

/** One static row: nothing to drag, nothing to accept. */
const STATIC_ROW: RowDragHandlers = {
  draggable: false,
  marker: null,
  onDragStart: () => undefined,
  onDragEnd: () => undefined,
  onDragOver: () => undefined,
  onDrop: () => undefined,
};

/**
 * Wiring for a tree with no drag at all: a standalone render of the rows (the
 * row tests) or a surface whose owner wires its own. Rows are static, and
 * nothing can start a drag.
 */
export const NO_DRAG: SidebarDrag = {
  sessionRow: () => STATIC_ROW,
  projectRow: () => STATIC_ROW,
};

/**
 * Track one row drag across the whole tree.
 *
 * @param tree - the rows as drawn, which is what supplies both the sibling sets
 *   a workspace may move within and the parent each one's id belongs to.
 * @returns the per-row wiring.
 */
export function useSidebarDrag(tree: readonly ProjectNode[]): SidebarDrag {
  const [drag, setDrag] = useState<DragState | null>(null);
  /**
   * The live drag, which is the ref rather than the state.
   *
   * `dragover` and `drop` can arrive before React has re-rendered the row that
   * started the drag — the browser fires them as the pointer moves, and the
   * element under it is whatever the last commit drew. Reading the state would
   * have a row judge a drag it has not seen yet as somebody else's and refuse
   * the drop, so every handler here decides from this ref; the state exists
   * only so the marker repaints.
   */
  const live = useRef<DragState | null>(null);
  /** The one place the drag changes: ref for the handlers, state for the paint. */
  const put = (next: DragState | null): void => {
    live.current = next;
    setDrag(next);
  };
  // One commit per drag: `drop` and `dragend` can both arrive for the same
  // release, and the second must not reorder anything.
  const committed = useRef(false);

  const parentOf = useMemo(() => parentOfMap(tree), [tree]);
  const orderedIds = useMemo(
    () => flattenProjectTree([...tree]).map((node) => node.project.id),
    [tree],
  );

  // Accept the native drag at document level while a row drag is active: a
  // release outside any row would otherwise be drawn as a rejected drop before
  // `dragend` commits the last marker the pointer was over.
  const active = drag !== null;
  useEffect(() => {
    if (!active) return;
    const acceptDrag = (event: DragEvent): void => {
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
    };
    const acceptDrop = (event: DragEvent): void => {
      event.preventDefault();
    };
    document.addEventListener("dragover", acceptDrag);
    document.addEventListener("drop", acceptDrop);
    return () => {
      document.removeEventListener("dragover", acceptDrag);
      document.removeEventListener("drop", acceptDrop);
    };
  }, [active]);

  const commitSession = (accountKey: string, targetPath: string, half: Half): void => {
    const current = live.current;
    if (current === null || current.source.kind !== "session") return;
    if (current.source.accountKey !== accountKey || committed.current) return;
    committed.current = true;
    put(null);
    if (current.source.path === targetPath) return;
    const state = appStore.get();
    // The order as drawn, which is what the drop has to permute: the same
    // filter and page limits the renderer applied.
    const order = (accountKey === FLAT_ORDER_KEY
      ? flatSessionRowsOf(state).sessions
      : sessionRowsOf(state, accountKey).sessions
    ).map((session) => session.path);
    actions.moveSession(accountKey, order, current.source.path, targetPath, half);
  };

  const commitProject = (targetId: string, half: Half): void => {
    const current = live.current;
    if (current === null || current.source.kind !== "project") return;
    if (committed.current) return;
    committed.current = true;
    put(null);
    const sourceId = current.source.projectId;
    if (sourceId === targetId) return;
    // The anchor is the workspace the dragged row lands *before*: the target
    // itself when dropping on its upper half, its next sibling when dropping
    // below — or nothing at all, which means "last".
    const owner = parentOf.get(targetId) ?? null;
    const siblings = orderedIds.filter((id) => (parentOf.get(id) ?? null) === owner);
    const anchor = half === "before" ? targetId : siblings[siblings.indexOf(targetId) + 1];
    void actions.moveProject(sourceId, anchor);
  };

  const sessionRow = (accountKey: string, path: string): RowDragHandlers => {
    // A draft has no file and so no position to save; dsh leaves its blank row
    // out of the drag for the same reason.
    const canDrag = !isDraftSession(path);
    /** True when the live drag is one this row may receive. */
    const accepts = (): boolean => {
      const current = live.current;
      return current !== null && current.source.kind === "session"
        && current.source.accountKey === accountKey;
    };
    const marker = drag?.over?.kind === "session"
      && drag.over.accountKey === accountKey && drag.over.path === path
      ? drag.over.half
      : null;

    return {
      draggable: canDrag,
      marker,
      onDragStart: (event) => {
        if (!canDrag) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", path);
        committed.current = false;
        put({ source: { kind: "session", accountKey, path }, over: null });
      },
      onDragEnd: () => {
        committed.current = false;
        put(null);
      },
      onDragOver: (event) => {
        if (!accepts()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const half = rowHalf(event);
        const current = live.current;
        const over = current?.over ?? null;
        // The same marker twice in a row is not worth a repaint.
        if (over !== null && over.kind === "session" && over.accountKey === accountKey
          && over.path === path && over.half === half) {
          return;
        }
        if (current !== null) put({ ...current, over: { kind: "session", accountKey, path, half } });
      },
      onDrop: (event) => {
        if (!accepts()) return;
        event.preventDefault();
        commitSession(accountKey, path, rowHalf(event));
      },
    };
  };

  const projectRow = (projectId: string): RowDragHandlers => {
    const parentId = parentOf.get(projectId) ?? null;
    /**
     * A workspace only moves among its siblings: dropping one into another
     * subtree would change the path model, not the order, so it is refused
     * rather than silently reordered. dsh gates its targets the same way.
     */
    const accepts = (): boolean => {
      const current = live.current;
      return current !== null && current.source.kind === "project"
        && current.source.parentId === parentId;
    };
    const marker = drag?.over?.kind === "project" && drag.over.projectId === projectId
      ? drag.over.half
      : null;

    return {
      draggable: true,
      marker,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", projectId);
        committed.current = false;
        put({ source: { kind: "project", projectId, parentId }, over: null });
      },
      onDragEnd: () => {
        committed.current = false;
        put(null);
      },
      onDragOver: (event) => {
        if (!accepts()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const half = rowHalf(event);
        const current = live.current;
        const over = current?.over ?? null;
        if (over !== null && over.kind === "project" && over.projectId === projectId
          && over.half === half) {
          return;
        }
        if (current !== null) put({ ...current, over: { kind: "project", projectId, half } });
      },
      onDrop: (event) => {
        if (!accepts()) return;
        event.preventDefault();
        commitProject(projectId, rowHalf(event));
      },
    };
  };

  return { sessionRow, projectRow };
}

/**
 * Each workspace's parent id, or null at the top level.
 *
 * Exported because it is the whole of the sibling rule a workspace drop is held
 * to: two headers may trade places exactly when this map gives them the same
 * parent.
 */
export function parentOfMap(tree: readonly ProjectNode[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const walk = (nodes: readonly ProjectNode[], parentId: string | null): void => {
    for (const node of nodes) {
      map.set(node.project.id, parentId);
      walk(node.children, node.project.id);
    }
  };
  walk(tree, null);
  return map;
}

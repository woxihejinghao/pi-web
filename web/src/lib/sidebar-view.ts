/**
 * The sidebar's viewing preferences: how sessions are grouped, how they are
 * ordered, and the manual order each account was left in.
 *
 * dsh keeps the same three pieces in its `dsh.workspace.view` store
 * (`ui-workspace/stores.ts`). The vocabulary is carried over name for name —
 * `'workspace' | 'workspace-tree' | 'flat'` and `'manual' | 'updated'` — so the
 * two implementations stay diffable; what differs is where the state lives.
 * dsh builds it into its store engine with a `persist` key, while this shell
 * has one plain store and reads its own `localStorage` entry at boot (the same
 * arrangement the right bar's layout uses).
 */

/** Session-list grouping: sibling workspace sections, a nested tree, or one list. */
export type SessionGroupBy = "workspace" | "workspace-tree" | "flat";

/** Session order: the saved manual positions, or current recency. */
export type SessionOrderBy = "manual" | "updated";

/** One account's saved manual order, keyed by `FLAT_ORDER_KEY` when it is the one list. */
export type SessionOrderByAccount = Record<string, string[]>;

export interface SidebarView {
  groupBy: SessionGroupBy;
  orderBy: SessionOrderBy;
  sessionOrder: SessionOrderByAccount;
}

/**
 * The browser-local order account for the flat list.
 *
 * dsh spells it `__flat_session_order__`, and keeps it in the same map as the
 * per-workspace accounts. Carrying the name over matters: a workspace id can
 * never collide with it, so one record can hold both without a second shape.
 */
export const FLAT_ORDER_KEY = "__flat_session_order__";

/**
 * The view a fresh install starts from.
 *
 * `workspace-tree` is the one deviation from dsh's own default (`workspace`):
 * nesting was this sidebar's only grouping before the menu existed, and it is
 * what the path model here reaches for — projects are registered one directory
 * at a time, so a monorepo arrives as several nested paths at once. The menu
 * switches to the flat grouping in one click; the reverse is not true for
 * someone who never knew the tree was there.
 */
export const DEFAULT_SIDEBAR_VIEW: SidebarView = {
  groupBy: "workspace-tree",
  // Same as dsh: recency is the honest default when nothing has been arranged.
  orderBy: "updated",
  sessionOrder: {},
};

/** Where the preferences are cached; versioned so a shape change can move on. */
const STORAGE_KEY = "pi-web-simple.sidebar-view.v1";

/**
 * Read the cache. Absent in the node test environment, and a browser may hold a
 * `localStorage` whose `getItem` throws (blocked storage), so both the lookup
 * and the read are guarded: either one means "no persistence", not an error
 * worth surfacing.
 */
function readCache(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Cache the preferences; a quota or a blocked write is not worth interrupting the view for. */
function writeCache(value: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, value);
  } catch {
    // The session keeps working; it just forgets this preference.
  }
}

function isGroupBy(value: unknown): value is SessionGroupBy {
  return value === "workspace" || value === "workspace-tree" || value === "flat";
}

function isOrderBy(value: unknown): value is SessionOrderBy {
  return value === "manual" || value === "updated";
}

/**
 * One saved account, or undefined when the entry is not a list of paths.
 *
 * A rejected entry is dropped rather than repaired: half of a saved order would
 * pin the rows it kept and silently re-sort the rest, which reads as the
 * arrangement having been thrown away — the same thing as dropping it, but with
 * a wrong answer in between.
 */
function readOrder(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry): entry is string => typeof entry === "string") ? [...value] : undefined;
}

function readSessionOrder(value: unknown): SessionOrderByAccount {
  if (value === null || typeof value !== "object") return {};
  const out: SessionOrderByAccount = {};
  for (const [key, entry] of Object.entries(value)) {
    const order = readOrder(entry);
    if (order !== undefined) out[key] = order;
  }
  return out;
}

/**
 * The cached preferences, or the defaults.
 *
 * Every field is validated on its own, so one unreadable entry (an older
 * shape, a hand-edited value) costs only that field instead of the whole view.
 */
export function loadSidebarView(): SidebarView {
  const raw = readCache();
  if (raw === null) return { ...DEFAULT_SIDEBAR_VIEW };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_SIDEBAR_VIEW };
    const record = parsed as Record<string, unknown>;
    return {
      groupBy: isGroupBy(record.groupBy) ? record.groupBy : DEFAULT_SIDEBAR_VIEW.groupBy,
      orderBy: isOrderBy(record.orderBy) ? record.orderBy : DEFAULT_SIDEBAR_VIEW.orderBy,
      sessionOrder: readSessionOrder(record.sessionOrder),
    };
  } catch {
    // Unparseable cache: start from the defaults rather than refusing to boot.
    return { ...DEFAULT_SIDEBAR_VIEW };
  }
}

/** Cache the preferences. */
export function saveSidebarView(view: SidebarView): void {
  writeCache(JSON.stringify(view));
}

/**
 * Reconcile a saved manual order with the members that are actually loaded.
 *
 * dsh's `reconcileManualOrder` also has pinned and archived partitions to weave
 * in; this shell has neither, so what is left is the rule that matters: the
 * saved entries keep their relative positions, and members the saved order has
 * never seen — a session created since, and the rest of a page that had not
 * been revealed yet — trail in the order the caller passed them (recency).
 */export function reconcileManualOrder(
  members: readonly string[],
  saved: readonly string[] | undefined,
): string[] {
  const known = new Set(members);
  const placed = new Set<string>();
  const out: string[] = [];
  for (const id of saved ?? []) {
    if (!known.has(id) || placed.has(id)) continue;
    out.push(id);
    placed.add(id);
  }
  for (const id of members) {
    if (placed.has(id)) continue;
    out.push(id);
    placed.add(id);
  }
  return out;
}

/**
 * Order one account's sessions by a saved manual order.
 *
 * The saved list is reconciled against the members actually present, so a row
 * the order has never seen joins at the front of what is left (see
 * `reconcileManualOrder`) and a row that is gone is skipped instead of leaving
 * a gap.
 *
 * @param sessions - the account's rows, already in the fallback (recency) order.
 * @param saved - that account's saved order, if it has one.
 * @returns the rows in display order.
 */
export function orderSessions<T extends { path: string }>(
  sessions: readonly T[],
  saved: readonly string[] | undefined,
): T[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  return reconcileManualOrder(
    sessions.map((session) => session.path),
    saved,
  ).flatMap((path) => {
    const session = byPath.get(path);
    return session === undefined ? [] : [session];
  });
}

/**
 * Move one id onto another's edge, keeping every other relative position.
 *
 * dsh's `sessionDragOrder` in one step, minus its pinned/second-section
 * handling: `at === sourceIndex` is the no-op test, which is why the caller
 * gets `undefined` rather than an identical copy (that is what makes a drop in
 * place cost nothing).
 */
export function moveInOrder(
  order: readonly string[],
  sourceId: string,
  targetId: string,
  half: "before" | "after",
): string[] | undefined {
  if (sourceId === targetId) return undefined;
  const sourceIndex = order.indexOf(sourceId);
  if (sourceIndex === -1 || !order.includes(targetId)) return undefined;
  const next = order.filter((id) => id !== sourceId);
  const at = next.indexOf(targetId) + (half === "after" ? 1 : 0);
  if (at === sourceIndex) return undefined;
  next.splice(at, 0, sourceId);
  return next;
}

/**
 * Which half of a row the pointer is on, i.e. whether the drop lands above or
 * below it. Identical to dsh's `rowHalf` / `workspaceGroupHalf`.
 */
export function rowHalf(event: { clientY: number; currentTarget: HTMLElement }): "before" | "after" {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/**
 * Where a workspace drop lands in the full submitted order.
 *
 * A workspace may only move among its siblings (the children of one tree
 * parent, or — flat and ungrouped alike — every root). `anchor` is the id the
 * dragged row is placed *before*, or undefined to land last; the returned list
 * is what goes to `PUT /api/projects/order`.
 *
 * @param ids - every workspace id, in the order the tree currently draws them.
 * @param sourceId - the dragged workspace.
 * @param anchorId - the workspace it lands before, or undefined for the end.
 * @returns the new complete order, or undefined when nothing moved.
 */
export function moveWorkspace(
  ids: readonly string[],
  sourceId: string,
  anchorId: string | undefined,
): string[] | undefined {
  if (sourceId === anchorId) return undefined;
  const sourceIndex = ids.indexOf(sourceId);
  if (sourceIndex === -1) return undefined;
  const next = ids.filter((id) => id !== sourceId);
  const at = anchorId === undefined ? next.length : next.indexOf(anchorId);
  if (at === -1 || at === sourceIndex) return undefined;
  next.splice(at, 0, sourceId);
  return next;
}

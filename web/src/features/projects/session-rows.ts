/**
 * The session rows the sidebar draws, in order.
 *
 * Both the renderer and the drag-and-drop handler call these: a workspace's
 * drop has to reorder exactly the rows that are on screen, so the two sides have
 * to agree on which rows survive the search filter and the revealed-page cut,
 * and on the order the current arrangement puts them in.
 */
import { SESSIONS_PAGE_SIZE, type AppState } from "../../lib/app-state.ts";
import { FLAT_ORDER_KEY, orderSessions } from "../../lib/sidebar-view.ts";
import type { SessionView } from "../../lib/types.ts";

/** A workspace's rows: pending drafts first, then the ordered page. */
export interface SessionRows {
  /**
   * Rows this browser created that pi has not written to disk yet, newest
   * first. They lead the workspace and are not draggable: dsh pins its blank
   * session the same way, and a row with no file has no position to save.
   */
  drafts: string[];
  /** The ordered page, capped unless the list is being searched. */
  sessions: SessionView[];
  /** The size of the page that was asked for; "show more" adds one more to it. */
  limit: number;
  /** How many rows the workspace still holds beyond `sessions`. */
  remaining: number;
}

/**
 * What one workspace shows.
 *
 * Hidden sessions are dropped: the server already leaves them out of the list
 * it answers with, so this is the client-side half of the same rule.
 */
export function sessionRowsOf(state: AppState, projectId: string): SessionRows {
  const all = state.sessions[projectId] ?? [];
  const visible = all.filter((session) => !session.hidden);
  const query = state.sessionQuery.trim().toLowerCase();
  const searching = query.length > 0;
  const matched = searching
    ? visible.filter((session) => session.title.toLowerCase().includes(query))
    : visible;
  const view = state.sidebarView;
  const ordered = view.orderBy === "manual"
    ? orderSessions(matched, view.sessionOrder[projectId])
    : matched;
  // A search filters titles on the client and so asks the server for the whole
  // list; anything short of that is capped by the revealed-page count.
  const limit = searching
    ? ordered.length
    : (state.revealedSessions[projectId] ?? SESSIONS_PAGE_SIZE);
  const sessions = ordered.slice(0, limit);
  const remaining = searching
    ? ordered.length - sessions.length
    : Math.max(0, (state.sessionTotals[projectId] ?? all.length) - sessions.length);
  const drafts = (state.unsavedSessions[projectId] ?? []).filter(
    (path) => !all.some((session) => session.path === path),
  );
  return { drafts, sessions, limit, remaining };
}

/** One flat list's rows: every workspace's drafts, then every session. */
export interface FlatRows {
  /** Pending drafts, newest first. */
  drafts: string[];
  /** Every loaded session, in the current order. */
  sessions: SessionView[];
}

/**
 * What the one-list grouping shows.
 *
 * The workspaces' pages arrive newest-first each; merging them means ordering
 * the whole set again, by recency or by the list's own saved arrangement. That
 * arrangement is its own account (`FLAT_ORDER_KEY`) rather than a merge of the
 * per-workspace ones: a session dragged here is being placed in this list, and
 * dsh keeps the flat list's order in a browser-local account of its own for the
 * same reason.
 */
export function flatSessionRowsOf(state: AppState): FlatRows {
  const rows: SessionView[] = [];
  for (const project of state.projects) {
    for (const session of state.sessions[project.id] ?? []) {
      if (!session.hidden) rows.push(session);
    }
  }
  const query = state.sessionQuery.trim().toLowerCase();
  const matched = query.length > 0
    ? rows.filter((session) => session.title.toLowerCase().includes(query))
    : rows;
  const view = state.sidebarView;
  const sessions = view.orderBy === "manual"
    ? orderSessions(matched, view.sessionOrder[FLAT_ORDER_KEY])
    : [...matched].sort((a, b) => b.modified.localeCompare(a.modified));

  const drafts: string[] = [];
  for (const project of state.projects) {
    const all = state.sessions[project.id] ?? [];
    for (const path of state.unsavedSessions[project.id] ?? []) {
      if (!all.some((session) => session.path === path)) drafts.push(path);
    }
  }
  return { drafts, sessions };
}

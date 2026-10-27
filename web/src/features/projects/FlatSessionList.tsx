/**
 * The one-list grouping: every workspace's sessions in a single column, with no
 * workspace headers at all.
 *
 * dsh draws this as `FlatBody` (`ui-workspace/rows/WorkspaceBrowser.tsx`), and
 * the rows are the same session rows the grouped view draws — the leading status
 * slot, the title, the trailing time, and the same drag wiring, so a row can be
 * arranged here just as it can inside a workspace.
 *
 * There is no "show more" here, because there is no workspace to fold rows away
 * under: the whole list is what this view asks the server for (see
 * `refreshSessions`) and what it draws.
 */
import { useMemo } from "react";
import { appStore, isDraftSession, useT } from "../../lib/app-state.ts";
import { formatRelativeTime } from "../../lib/format.ts";
import { FLAT_ORDER_KEY } from "../../lib/sidebar-view.ts";
import { useStore } from "../../lib/store.ts";
import { useDelayedFlag } from "../../lib/use-delayed-flag.ts";
import styles from "../../layout/Sidebar.module.css";
import { SessionRow, sessionStatus } from "./ProjectTree.tsx";
import { pendingAskOf, type PendingAsk } from "../conversation/question-model.ts";
import { flatSessionRowsOf } from "./session-rows.ts";
import type { SidebarDrag } from "./use-sidebar-drag.ts";

export function FlatSessionList({ drag }: { drag: SidebarDrag }) {
  const t = useT();
  const state = useStore(appStore);
  const rows = flatSessionRowsOf(state);
  // Delayed for the same reason the workspace's own hint is: this list arrives
  // in milliseconds when every workspace is warm, and an immediate hint would
  // flash and vanish. Called above the early return below, to keep hook order.
  const loading = useDelayedFlag(rows.loading);
  const selected = state.selectedSessionPath;
  /**
   * Which workspace each row belongs to.
   *
   * The flat view commends a row without drawing a workspace header over it, so
   * the owner is not in scope where the row is rendered. It is recovered here —
   * from the same per-project lists the rows came from — because opening a row
   * has to switch the selected workspace with it (see `selectSession`).
   */
  const ownerOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of state.projects) {
      for (const session of state.sessions[project.id] ?? []) map.set(session.path, project.id);
      for (const path of state.unsavedSessions[project.id] ?? []) map.set(path, project.id);
    }
    return map;
  }, [state.projects, state.sessions, state.unsavedSessions]);
  /** What an extension is blocked on in this row's session, or null. */
  const pendingFor = (path: string): PendingAsk | null =>
    pendingAskOf(state.pendingUiRequests, path);

  if (rows.drafts.length === 0 && rows.sessions.length === 0) {
    return (
      <p className={styles.emptyList}>
        {loading ? t("session.loading") : t("session.empty")}
      </p>
    );
  }

  return (
    <>
      {rows.drafts.map((path) => (
        <SessionRow
          key={path}
          sessionPath={path}
          projectId={ownerOf.get(path)}
          title={state.unsavedSessionTitles[path] ?? t("sidebar.newSession")}
          time={isDraftSession(path) ? t("session.preparing") : t("session.unsaved")}
          active={path === selected}
          external={false}
          status={sessionStatus(state.sessionActivity[path], pendingFor(path))}
          indent={0}
          drag={drag.sessionRow(FLAT_ORDER_KEY, path)}
          canDelete={false}
        />
      ))}

      {rows.sessions.map((session) => {
        const pending = pendingFor(session.path);
        return (
          <SessionRow
            key={session.path}
            sessionPath={session.path}
            projectId={ownerOf.get(session.path)}
            title={session.title}
            // A plan review takes the timestamp's place, as dsh draws it.
            time={pending === "plan-review"
              ? t("session.planReviewTime")
              : formatRelativeTime(session.modified, t)}
            active={session.path === selected}
            external={Boolean(state.externalChanged[session.path])}
            status={sessionStatus(state.sessionActivity[session.path], pending)}
            indent={0}
            drag={drag.sessionRow(FLAT_ORDER_KEY, session.path)}
          />
        );
      })}
    </>
  );
}

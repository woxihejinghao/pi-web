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
import { appStore, isDraftSession, useT } from "../../lib/app-state.ts";
import { formatRelativeTime } from "../../lib/format.ts";
import { FLAT_ORDER_KEY } from "../../lib/sidebar-view.ts";
import { useStore } from "../../lib/store.ts";
import styles from "../../layout/Sidebar.module.css";
import { SessionRow, sessionStatus } from "./ProjectTree.tsx";
import { flatSessionRowsOf } from "./session-rows.ts";
import type { SidebarDrag } from "./use-sidebar-drag.ts";

export function FlatSessionList({ drag }: { drag: SidebarDrag }) {
  const t = useT();
  const state = useStore(appStore);
  const rows = flatSessionRowsOf(state);
  const selected = state.selectedSessionPath;
  /** True when this row's session is the one an extension is blocked on. */
  const pendingFor = (path: string): boolean =>
    state.pendingUiRequests.some((item) => item.sessionPath === path);

  if (rows.drafts.length === 0 && rows.sessions.length === 0) {
    return <p className={styles.emptyList}>{t("session.empty")}</p>;
  }

  return (
    <>
      {rows.drafts.map((path) => (
        <SessionRow
          key={path}
          sessionPath={path}
          title={t("sidebar.newSession")}
          time={isDraftSession(path) ? t("session.preparing") : t("session.unsaved")}
          active={path === selected}
          external={false}
          status={sessionStatus(state.sessionActivity[path], pendingFor(path))}
          indent={0}
          drag={drag.sessionRow(FLAT_ORDER_KEY, path)}
          canDelete={false}
        />
      ))}

      {rows.sessions.map((session) => (
        <SessionRow
          key={session.path}
          sessionPath={session.path}
          title={session.title}
          time={formatRelativeTime(session.modified, t)}
          active={session.path === selected}
          external={Boolean(state.externalChanged[session.path])}
          status={sessionStatus(
            state.sessionActivity[session.path],
            pendingFor(session.path),
          )}
          indent={0}
          drag={drag.sessionRow(FLAT_ORDER_KEY, session.path)}
        />
      ))}
    </>
  );
}

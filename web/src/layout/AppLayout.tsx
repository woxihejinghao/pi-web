import { useEffect } from "react";
import clsx from "clsx";
import { ConversationPane } from "../features/conversation/ConversationPane.tsx";
import { Rightbar } from "../features/rightbar/Rightbar.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { actions, appStore, useT } from "../lib/app-state.ts";
import { setEventSession } from "../lib/sse.ts";
import { useStore } from "../lib/store.ts";
import styles from "./AppLayout.module.css";

/**
 * Three-region shell mirroring dsh's arrangement: the project/session sidebar on
 * the left, the active conversation in the middle, and the right sidebar — the
 * per-session panel the conversation header's toggle opens.
 */
export function AppLayout() {
  const t = useT();
  const state = useStore(appStore);

  useEffect(() => {
    void actions.bootstrap();
  }, []);

  // The server fans a session's token stream out only to the tab reading it;
  // this is how it learns which session that is. Fire-and-forget, and a no-op
  // until the stream greets us with its id.
  useEffect(() => {
    setEventSession(state.selectedSessionPath);
  }, [state.selectedSessionPath]);

  // The settings page replaces the shell instead of sitting over it. That does
  // unmount the conversation, and remounting costs a transcript read — a few
  // milliseconds off disk, with no pi process started for it. Worth paying to
  // avoid reasoning about two live layers at once.
  if (state.settingsOpen) return <SettingsPage />;

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Sidebar />
      </aside>
      <main className={styles.main}>
        {state.status === "error" ? (
          <div className={styles.empty}>{t("layout.disconnected")}</div>
        ) : (
          <ConversationPane />
        )}
      </main>
      {/* Renders nothing without an open session, and a fullscreen panel takes
          itself out of this flow — so the shell stays a three-track flex row. */}
      <Rightbar />
      {state.notice ? (
        <div
          className={clsx(
            styles.notice,
            // A notify that lands while a question is waiting would otherwise sit
            // on top of the card and cover the controls the user has to reach.
            state.pendingUiRequests.length > 0 && styles.noticeAboveCard,
          )}
          role="status"
        >
          <span>{state.notice}</span>
          <button
            type="button"
            className={styles.noticeDismiss}
            onClick={() => actions.setNotice(null)}
            aria-label={t("layout.dismiss")}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

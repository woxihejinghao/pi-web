import { useEffect } from "react";
import clsx from "clsx";
import { ConversationPane } from "../features/conversation/ConversationPane.tsx";
import { Rightbar } from "../features/rightbar/Rightbar.tsx";
import { rightbarCommands } from "../features/rightbar/shortcuts.ts";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { actions, appStore, useT } from "../lib/app-state.ts";
import { useShortcuts } from "../lib/shortcuts/use-shortcuts.ts";
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

  // Installed here rather than inside the panel: the commands open the panel
  // too, so their owner cannot be the thing they are meant to conjure. dsh
  // makes the same division — a shortcut service on the shell, the commands
  // registered by the features that act on them.
  //
  // The settings page is why the flag exists. It renders *instead of* the shell
  // rather than over it, so this component stays mounted and the listener would
  // otherwise still be live on a page with no conversation and no panel.
  useShortcuts(rightbarCommands, !state.settingsOpen);

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

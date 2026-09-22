import { useEffect } from "react";
import clsx from "clsx";
import { ConversationPane } from "../features/conversation/ConversationPane.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { actions, appStore } from "../lib/app-state.ts";
import { useStore } from "../lib/store.ts";
import styles from "./AppLayout.module.css";

/**
 * Two-region shell mirroring dsh's arrangement: the project/session sidebar on
 * the left, the active conversation filling the rest. A right sidebar is
 * deliberately out of scope for this first version.
 */
export function AppLayout() {
  const state = useStore(appStore);

  useEffect(() => {
    void actions.bootstrap();
  }, []);

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
          <div className={styles.empty}>无法连接服务端，请确认 API 已启动。</div>
        ) : (
          <ConversationPane />
        )}
      </main>
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
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

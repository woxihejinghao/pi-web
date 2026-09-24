import { useEffect, useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { TodoList } from "./TodoList.tsx";
import {
  PANEL_COMPLETED_LIMIT,
  progressLabel,
  shouldOfferTodoInstall,
  summarizeTodos,
  visibleTodos,
  type TodoItem,
} from "./todo-model.ts";
import styles from "./TodoPanel.module.css";

/**
 * The session's plan, as a persistent strip above the composer.
 *
 * dsh mounts the same panel and collapses it by default, so a long-running
 * session answers "where is it now?" without the reader opening anything, while
 * a user who wants the whole list gets it with one click. Empty lists render
 * nothing at all: a strip that says "no tasks" would take a permanent slice of a
 * pane that is mostly conversation.
 *
 * The list is the session's, not the current turn's. dsh's plan is replaced
 * wholesale on every write, so it only ever describes the turn it belongs to;
 * pi's todo list persists until it is cleared, and pretending otherwise here
 * would hide rows the terminal panel is still showing. What that costs is
 * length — dozens of finished tasks on a long session — so the finished tail is
 * trimmed to the newest few (`PANEL_COMPLETED_LIMIT`) with the rest counted in a
 * `+N 项已完成` line. Unfinished rows are never trimmed.
 *
 * An empty list is not always "nothing to say", though: pi's `todo` tool comes
 * from an extension the user installs, so when that extension is missing the
 * panel has nothing to project — not because the session is idle. That case
 * gets a one-line notice with the same shape as the MCP section's, offering to
 * install it or to stop asking. `shouldOfferTodoInstall` owns when it appears.
 */
export function TodoPanel({
  todos,
  projectPath,
}: {
  todos: readonly TodoItem[];
  projectPath: string | null;
}) {
  const t = useT();
  const state = useStore(appStore);
  const [collapsed, setCollapsed] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const view = state.todo;

  useEffect(() => {
    // The answer is per workspace, the same way the extension inventory is, so
    // switching workspaces has to re-resolve rather than keep the last answer.
    if (view !== null && view.projectPath === projectPath) return;
    void actions.loadTodo(projectPath);
  }, [projectPath, view]);

  const rows = visibleTodos(todos);
  const offerInstall = shouldOfferTodoInstall(view, state.settings.todoNoticeDismissed);

  if (rows.length === 0 && !offerInstall) return null;

  const install = (): void => {
    setInstalling(true);
    setInstallError(null);
    void actions
      .installTodoExtension(projectPath)
      .catch((err: Error) => setInstallError(err.message))
      .finally(() => setInstalling(false));
  };

  return (
    <div className={styles.dock}>
      <section className={styles.root} aria-label={t("todo.panelTitle")}>
        {rows.length === 0 ? (
          <>
            <div className={styles.notice}>
              <span className={styles.lead} aria-hidden>
                <Glyph name="checklist" />
              </span>
              <span className={styles.noticeText}>{t("todo.installNotice")}</span>
              <button
                type="button"
                className={styles.noticeAction}
                disabled={installing}
                title="pi install npm:@juicesharp/rpiv-todo"
                onClick={install}
              >
                {installing ? t("todo.installing") : t("todo.install")}
              </button>
              <button
                type="button"
                className={styles.noticeClose}
                disabled={installing}
                title={t("todo.dismissTitle")}
                onClick={() => void actions.dismissTodoNotice()}
              >{t("todo.dismiss")}</button>
            </div>
            {installError !== null ? (
              <p className={styles.noticeError}>{installError}</p>
            ) : null}
          </>
        ) : (
          <div className={styles.body}>
            <button
              type="button"
              className={styles.header}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((value) => !value)}
            >
              <span className={styles.lead} aria-hidden>
                <Glyph name="checklist" />
              </span>
              <span className={styles.title}>{t("todo.title")}</span>
              {/* The counts are chrome: the reader who cares about which task is
                  running is one click away from the rows themselves. */}
              <span className={styles.progress}>{progressLabel(summarizeTodos(todos), t)}</span>
              <span className={styles.chevron} aria-hidden>
                <Glyph name="chevronDown" className={collapsed ? styles.chevronCollapsed : undefined} />
              </span>
            </button>
            {collapsed ? null : <TodoList todos={todos} completedLimit={PANEL_COMPLETED_LIMIT} />}
          </div>
        )}
      </section>
    </div>
  );
}

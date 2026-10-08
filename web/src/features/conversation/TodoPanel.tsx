import { useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { useT } from "../../lib/app-state.ts";
import { TodoList } from "./TodoList.tsx";
import {
  PANEL_COMPLETED_LIMIT,
  progressLabel,
  summarizeTodos,
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
 * The list is the session's, not the current turn's. dsh clears its plan at the
 * start of the next turn, so its panel only ever describes one turn; here the
 * list persists until the agent replaces or empties it, and pretending
 * otherwise would hide rows the transcript is still showing. What that costs is
 * length — dozens of finished tasks on a long session — so the finished tail is
 * trimmed to the newest few (`PANEL_COMPLETED_LIMIT`) with the rest counted in a
 * `+N 项已完成` line. Unfinished rows are never trimmed.
 */
export function TodoPanel({ todos }: { todos: readonly TodoItem[] }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(true);

  if (todos.length === 0) return null;

  return (
    <div className={styles.dock}>
      <section className={styles.root} aria-label={t("todo.panelTitle")}>
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
      </section>
    </div>
  );
}

import { useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { TodoList } from "./TodoList.tsx";
import {
  PANEL_COMPLETED_LIMIT,
  progressLabel,
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
 */
export function TodoPanel({ todos }: { todos: readonly TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(true);

  const rows = visibleTodos(todos);
  if (rows.length === 0) return null;

  const summary = summarizeTodos(todos);
  const label = progressLabel(summary);

  return (
    <div className={styles.dock}>
      <section className={styles.root} aria-label="任务清单">
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
            <span className={styles.title}>任务</span>
            {/* The counts are chrome: the reader who cares about which task is
                running is one click away from the rows themselves. */}
            <span className={styles.progress}>{label}</span>
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

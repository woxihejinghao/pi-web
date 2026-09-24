import { useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { StateDot } from "../../components/StateDot.tsx";
import type { ToolCallBlock } from "../../lib/types.ts";
import { DisclosureRow } from "./DisclosureRow.tsx";
import { TodoList } from "./TodoList.tsx";
import {
  parseTodoSnapshot,
  rowSummary,
  summarizeTodos,
  todoArgsSummary,
  visibleTodos,
} from "./todo-model.ts";
import type { ToolExecution } from "./useConversation.ts";
import styles from "./TodoRow.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * One `todo` call as a disclosure row.
 *
 * dsh's todo row is the same shape — checklist glyph, fixed title, and a
 * `done/total` summary — but its summary can only describe the whole list,
 * because its tool writes the whole list. pi's calls name one task at a time, so
 * the summary here is the list *after* this call: the count plus whichever task
 * is now in progress, which is the thing the reader wants to know from a row
 * that says "update #3".
 *
 * Expanded it shows the snapshot the call returned — the plan as it stood right
 * after it — which is strictly more than dsh can show, since a todo call's
 * arguments carry an id and a status rather than a list.
 */
export function TodoRow({
  call,
  execution,
}: {
  call: ToolCallBlock;
  execution: ToolExecution | undefined;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const state = execution?.isError ? "error" : execution?.running ? "running" : "ok";
  const running = execution?.running ?? false;

  const args = call.arguments ?? execution?.args;
  const snapshot = parseTodoSnapshot(execution?.details);
  const tasks = snapshot?.tasks ?? [];
  // Until the snapshot lands — and for a call whose payload was rejected — the
  // arguments are the only description of what happened.
  const summary = snapshot === null ? null : summarizeTodos(tasks);
  const text = summary === null ? todoArgsSummary(args) : rowSummary(summary);
  const extra = summary?.activeExtra ?? 0;

  const rows = visibleTodos(tasks);
  const body =
    snapshot === null
      ? running
        ? t("common.runningEllipsis")
        : t("todo.noSnapshot")
      : rows.length === 0
        ? t("todo.empty")
        : null;

  return (
    <div className={styles.root} data-tool={call.name} data-state={state}>
      {running ? <span className={styles.visuallyHidden}>{t("common.running")}</span> : null}

      <DisclosureRow
        rowClassName={styles.row}
        leadingClassName={styles.leading}
        titleClassName={styles.title}
        chevronClassName={styles.chevron}
        // A rejected call keeps its own glyph convention: the error dot.
        icon={state === "error" ? <StateDot state="error" /> : <Glyph name="checklist" />}
        title={t("todo.panelTitle")}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={
          <>
            <span className={styles.sep} aria-hidden />
            <span className={styles.summary} data-error={execution?.isError || undefined}>
              {text}
            </span>
            {extra > 0 ? <span className={styles.extra}>{`+${String(extra)}`}</span> : null}
          </>
        }
      >
        <div className={styles.card}>
          {body === null ? <TodoList todos={tasks} /> : <span className={styles.empty}>{body}</span>}
        </div>
      </DisclosureRow>
    </div>
  );
}

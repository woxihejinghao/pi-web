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
  todosInArgs,
} from "./todo-model.ts";
import type { ToolExecution } from "./useConversation.ts";
import styles from "./TodoRow.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * One `todo` call as a disclosure row.
 *
 * dsh's row has the same shape — checklist glyph, fixed title, and a
 * `done/total` summary naming whatever is in progress — because the tool behind
 * it writes a whole list too. The one thing that differs is where the list comes
 * from while the call is in flight: this tool carries it in the arguments, so a
 * running or rejected row still gets a real summary instead of the generic tool
 * one.
 *
 * Expanded it shows the snapshot the call returned — the plan as it stood right
 * after it — or, for a call that has not answered yet, the list it was asked to
 * write.
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
  // The result is authoritative; the arguments are the fallback, and the only
  // source for a call that is still running or that failed outright.
  const todos = parseTodoSnapshot(execution?.details) ?? todosInArgs(args);
  const summary = todos === null ? null : summarizeTodos(todos);
  const extra = summary?.activeExtra ?? 0;

  const body =
    todos === null
      ? running
        ? t("common.runningEllipsis")
        : t("todo.noSnapshot")
      : todos.length === 0
        ? t("todo.empty")
        : null;

  return (
    <div className={styles.root} data-tool={call.name} data-state={state}>
      {running ? <span className={styles.visuallyHidden}>{t("common.running")}</span> : null}

      <DisclosureRow
        rowClassName={styles.row}
        leadingClassName={styles.leading}
        titleClassName={styles.title}
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
              {summary === null ? t(running ? "common.runningEllipsis" : "todo.noSnapshot") : rowSummary(summary, t)}
            </span>
            {extra > 0 ? <span className={styles.extra}>{`+${String(extra)}`}</span> : null}
          </>
        }
      >
        <div className={styles.card}>
          {body === null && todos !== null ? (
            <TodoList todos={todos} />
          ) : (
            <span className={styles.empty}>
              {body ?? t(running ? "common.runningEllipsis" : "todo.noSnapshot")}
            </span>
          )}
        </div>
      </DisclosureRow>
    </div>
  );
}

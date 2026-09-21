import { useId } from "react";
import clsx from "clsx";
import { limitCompleted, visibleTodos, type TodoItem, type TodoStatus } from "./todo-model.ts";
import styles from "./TodoList.module.css";

/**
 * The task rows. Shared by the plan panel above the composer and the todo row
 * inside the transcript, because both surfaces show the same list and two
 * implementations would drift.
 *
 * The three glyphs are dsh's, path for path: a check inside a closed ring, a
 * ring that fades out along its own gradient and rotates, and a dashed ring for
 * work that has not started.
 */

/** Status glyphs share the figma 14×14 artboard; the 16×16 `.glyph` cell centers them. */
function CompletedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden className={styles.glyphCompleted}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** In-progress: business-blue ring fading out; CSS spins the svg. */
function ProgressGlyph() {
  const gradientId = useId();
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden className={styles.glyphProgress}>
      <defs>
        <linearGradient id={gradientId} x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
    </svg>
  );
}

/** Pending: dashed unstarted ring (figma dash 2.4 2.4). */
function PendingGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden className={styles.glyphPending}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  );
}

/**
 * `deleted` renders nothing. A tombstone exists so a `blockedBy` id still
 * resolves; it is filtered out before it reaches a list, and a stray one getting
 * a glyph of its own would be a row nobody meant to draw.
 */
function StatusGlyph({ status }: { status: TodoStatus }) {
  switch (status) {
    case "completed":
      return <CompletedGlyph />;
    case "in_progress":
      return <ProgressGlyph />;
    case "pending":
      return <PendingGlyph />;
    case "deleted":
      return null;
  }
}

export function TodoList({
  todos,
  completedLimit,
  className,
}: {
  todos: readonly TodoItem[];
  /**
   * Drop all but the newest N finished tasks, with a `+N 项已完成` line for the
   * rest. Only the plan panel passes this: a transcript row shows the snapshot
   * that call returned, and trimming a historical record would be a lie.
   */
  completedLimit?: number;
  className?: string;
}) {
  const { rows, hiddenCompleted } =
    completedLimit === undefined
      ? { rows: visibleTodos(todos), hiddenCompleted: 0 }
      : limitCompleted(todos, completedLimit);
  if (rows.length === 0) return null;

  return (
    <ul className={clsx(styles.list, className)}>
      {rows.map((item) => (
        // pi's tasks have stable ids, so they are the key — dsh keys on the
        // content string only because its items have no identity.
        <li key={item.id} className={styles.item} data-status={item.status} data-task-id={item.id}>
          <span className={styles.glyph} aria-hidden>
            <StatusGlyph status={item.status} />
          </span>
          <span className={styles.content}>{item.subject}</span>
          {item.status === "in_progress" && item.activeForm !== undefined ? (
            // Parenthesised like the terminal panel's row: the label describes
            // the shape the task is taking, not another task.
            <span className={styles.activeForm}>{`(${item.activeForm})`}</span>
          ) : null}
          {item.blockedBy !== undefined && item.blockedBy.length > 0 ? (
            <span className={styles.blocked}>{`⛓ ${item.blockedBy.map((id) => `#${String(id)}`).join(",")}`}</span>
          ) : null}
        </li>
      ))}
      {hiddenCompleted > 0 ? (
        <li className={styles.more}>{`+${String(hiddenCompleted)} 项已完成`}</li>
      ) : null}
    </ul>
  );
}

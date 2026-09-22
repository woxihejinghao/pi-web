import clsx from "clsx";
import type { ReactNode } from "react";
import styles from "./StatPanel.module.css";

export interface StatPanelProps {
  icon: ReactNode;
  title: string;
  /** Optional figure pinned to the right of the title, e.g. `用量 364K tok`. */
  value?: string;
  /** `end` pins the panel to the anchor's right edge; default centres it. */
  align?: "center" | "end";
  /** A sentence under the rows, for figures whose provenance needs stating. */
  note?: ReactNode;
  children: ReactNode;
}

/**
 * The detail panel behind the composer's pills and the context ring.
 *
 * Shared rather than duplicated because all of these panels are the same shape:
 * an icon-and-title header, a rule, then a two-column list. Its CSS started life
 * inside `SessionStats.module.css` and moved here when the second consumer
 * appeared. The note lives outside the `<dl>` because a `<p>` is not a legal
 * child of a description list.
 */
export function StatPanel({ icon, title, value, align = "center", note, children }: StatPanelProps) {
  return (
    <div
      className={clsx(styles.panel, align === "end" && styles.end)}
      role="dialog"
      aria-label={title}
    >
      <div className={styles.title}>
        <span className={styles.titleLabel}>
          {icon}
          {title}
        </span>
        {value === undefined ? null : <span className={styles.titleValue}>{value}</span>}
      </div>
      <div className={styles.titleRule} aria-hidden />
      <dl className={styles.details}>{children}</dl>
      {note === undefined ? null : <p className={styles.note}>{note}</p>}
    </div>
  );
}

/** One `label → value` row. `route` lets long values wrap instead of clip. */
export function StatRow({
  label,
  value,
  route,
}: {
  label: string;
  value: string;
  route?: boolean;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={route === true ? styles.route : undefined}>{value}</dd>
    </>
  );
}

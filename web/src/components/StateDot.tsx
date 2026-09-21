import clsx from "clsx";
import styles from "./StateDot.module.css";

/**
 * dsh's run-state dot, used in place of a tool icon when a row is not "ok".
 *
 * Two stacked circles rather than a border: an outer ring at 10% opacity and an
 * inner solid dot inset to 80%. That reads as a halo at any size and does not
 * alias the way a hairline border does.
 */
export function StateDot({
  state,
  size = 10,
  className,
}: {
  state: "done" | "warning" | "error" | "idle";
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={clsx(styles.dot, className)}
      data-state={state}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

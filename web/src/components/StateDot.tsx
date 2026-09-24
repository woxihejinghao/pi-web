import clsx from "clsx";
import styles from "./StateDot.module.css";

/**
 * dsh's run-state mark.
 *
 * `done` / `warning` / `error` / `idle` are the same two stacked circles (
 * an outer ring at 10% opacity and an inner solid dot inset to 80%). That
 * reads as a halo at any size and does not alias the way a hairline border
 * does.
 *
 * `ongoing` is dsh's separate running glyph: a chase of eight 2x2 cells
 * around the empty centre of a 10x10 box, lit in sequence rather than a
 * spinner. The two share the caller's `size`, so a row can swap between a
 * settled dot and the running mark without moving.
 */
export type StateDotState = "ongoing" | "done" | "warning" | "error" | "idle";

/**
 * The eight cells of the running mark, in draw order: the ring around the
 * centre of a 10x10 viewBox, each cell a 2x2 square. The chase animation
 * lights them in this order, one step every 125ms.
 */
const ONGOING_CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [4, 0],
  [8, 0],
  [8, 4],
  [8, 8],
  [4, 8],
  [0, 8],
  [0, 4],
];

export function StateDot({
  state,
  size = 10,
  className,
}: {
  state: StateDotState;
  size?: number;
  className?: string;
}) {
  if (state === "ongoing") {
    return (
      <svg
        className={clsx(styles.matrix, className)}
        data-state="ongoing"
        width={size}
        height={size}
        viewBox="0 0 10 10"
        shapeRendering="crispEdges"
        aria-hidden
      >
        {ONGOING_CELLS.map(([x, y], index) => (
          <rect
            key={`${x}-${y}`}
            className={styles.cell}
            x={x}
            y={y}
            width="2"
            height="2"
            // Negative delays start the chase mid-cycle; the ring steps
            // backwards by one cell per 125ms, so eight cells span the 1s loop.
            style={{ animationDelay: `${(index - ONGOING_CELLS.length) * 125}ms` }}
          />
        ))}
      </svg>
    );
  }

  return (
    <span
      className={clsx(styles.dot, className)}
      data-state={state}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

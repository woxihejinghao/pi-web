import { type ReactNode, useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { useT } from "../../lib/app-state.ts";
import { formatRunDuration } from "../../lib/duration.ts";
import styles from "./TurnProcessGroup.module.css";

/**
 * dsh renders the elapsed figure's digits in the code face with tabular figures
 * and leaves the unit words in the row's own font. Splitting the already
 * localized string on its digit runs gets that without a second copy of every
 * `duration.*` template — and without a second place for the two languages to
 * drift apart.
 */
function numericSpans(text: string): ReactNode[] {
  return text
    .split(/(\d+)/)
    .filter((part) => part !== "")
    .map((part, index) =>
      /^\d+$/.test(part) ? (
        <span key={index} className={styles.number}>
          {part}
        </span>
      ) : (
        part
      ),
    );
}

/**
 * A finished turn's process rows (thinking + tool calls) folded behind dsh's
 * turn-process header, used by the "compact" transcript display.
 *
 * Ported from dsh's `TurnProcessNodeView`. What the port keeps:
 *
 * - The header is a completion summary, not a label — "已完成，用时 2分33秒" — so
 *   it is only ever drawn for a turn that has ended. That is also why a live
 *   turn is never folded (see `MessageList`): a running turn has no completion
 *   to report, and a header claiming one would be the only thing on screen that
 *   is wrong.
 * - The hairline under it is the boundary between the turn's process and its
 *   answer, so the fold reads as "these rows were the work, that is the reply".
 * - The chevron turns over on the same 100ms easing as every other disclosure.
 *
 * dsh builds this window out of a paginated chunk list and so also owns load
 * states, an "answer anchor" and per-段 counters; here the whole turn is already
 * in memory, so the only behaviour worth keeping is that the group is per
 * finished turn and starts collapsed.
 */
export function TurnProcessGroup({
  durationMs,
  children,
}: {
  /** Wall-clock span of the turn, in ms. Null when the transcript has no stamps. */
  durationMs: number | null;
  children: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // dsh clamps this at a second: a turn that finished inside one would otherwise
  // read "0秒", which looks like the timing broke rather than like a fast turn.
  const elapsed = durationMs === null ? null : formatRunDuration(Math.max(1000, durationMs), t);

  return (
    <div className={styles.root} data-open={open || undefined}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className={styles.label}>
          {elapsed === null ? t("turn.processWorked") : t("turn.processTook")}
          {elapsed === null ? null : numericSpans(elapsed)}
        </span>
        <Glyph name="chevronDown" className={styles.chevron} />
      </button>
      {/* Kept out of the DOM while closed rather than hidden with CSS: these are
          the rows the group exists to stand in for, and dsh unmounts them too. */}
      {open ? <div className={styles.body}>{children}</div> : null}
    </div>
  );
}

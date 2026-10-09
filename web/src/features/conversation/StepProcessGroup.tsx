import { type ReactNode, useEffect, useRef, useState } from "react";
import { Glyph, type GlyphName } from "../../components/dsh-icons.tsx";
import type { ProcessActivity } from "./row-model.ts";
import styles from "./StepProcessGroup.module.css";

/**
 * dsh's per-stretch process group (its `ChatGroupSeat`): a run of a turn's
 * process rows folded behind a header that names the work — "已读取文件并搜索了
 * 代码" once the run ends, "正在读取文件" while it is still going.
 *
 * The turn-level fold (`TurnProcessGroup`) answers "what did this turn do?";
 * this one answers "what did *this stretch* of it do?". Splitting the two is
 * exactly what dsh's `stepGrouping` policy decides: `standard` folds every
 * stretch, `detailed` only the stretches of closed turns, `verbose` none.
 */
const ACTIVITY_GLYPHS: Record<ProcessActivity, GlyphName> = {
  thinking: "think",
  read: "browse",
  write: "edit",
  edit: "edit",
  search: "search",
  commands: "terminal",
  code: "code",
  plan: "checklist",
  tools: "sparkle",
};

/**
 * dsh's floor on how long a live title stays on screen (its
 * `PROCESS_TITLE_MINIMUM_MS`).
 *
 * Tool calls arrive in bursts — read, grep, read inside a few hundred
 * milliseconds — and with the running argument streaming in a character at a
 * time, an unthrottled header reads as flicker rather than as progress. Holding
 * each value for at least this long is what makes it legible.
 */
const TITLE_MINIMUM_MS = 150;

/**
 * Show `title`, but never for less than `TITLE_MINIMUM_MS`.
 *
 * Once the stretch stops being live this returns the desired value directly:
 * the final wording must not be held back by a throttle that exists for the
 * in-between states. Same shape as dsh's `useStableLiveProcessTitle`.
 */
function useStableTitle(desired: string, active: boolean): string {
  const [displayed, setDisplayed] = useState(desired);
  const displayedRef = useRef(displayed);
  const desiredRef = useRef(desired);
  const displayedAtRef = useRef(Date.now());
  useEffect(() => {
    desiredRef.current = desired;
    if (!active || displayedRef.current === desired) return;
    const remaining = TITLE_MINIMUM_MS - (Date.now() - displayedAtRef.current);
    const commit = (): void => {
      const next = desiredRef.current;
      displayedRef.current = next;
      displayedAtRef.current = Date.now();
      setDisplayed(next);
    };
    if (remaining <= 0) {
      commit();
      return;
    }
    const timer = setTimeout(commit, remaining);
    return () => {
      clearTimeout(timer);
    };
  }, [active, desired]);
  return active ? displayed : desired;
}

export function StepProcessGroup({
  title,
  activity,
  running,
  children,
}: {
  /** Localized header, from `processSegmentTitle`. */
  title: string;
  /** Category deciding the glyph; see `processActivityOf`. */
  activity: ProcessActivity;
  /** Whether the stretch is still arriving — drives the live header's shimmer. */
  running: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label = useStableTitle(title, running);
  return (
    <div className={styles.root} data-open={open || undefined} data-running={running || undefined}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className={styles.leading}>
          <Glyph name={ACTIVITY_GLYPHS[activity]} className={styles.activityIcon} />
          <Glyph name="chevronDown" className={styles.chevron} />
        </span>
        <span className={styles.label}>{label}</span>
      </button>
      {/* Kept out of the DOM while closed, the way every other fold here is:
          the rows are what the group stands in for. */}
      {open ? <div className={styles.body}>{children}</div> : null}
    </div>
  );
}

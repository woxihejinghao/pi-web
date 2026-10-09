import { type ReactNode, useState } from "react";
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
        <span className={styles.label}>{title}</span>
      </button>
      {/* Kept out of the DOM while closed, the way every other fold here is:
          the rows are what the group stands in for. */}
      {open ? <div className={styles.body}>{children}</div> : null}
    </div>
  );
}

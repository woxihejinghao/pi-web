/**
 * One hunk of a unified diff, drawn with both line numbers and collapsible on
 * its own.
 *
 * Shared by the changes panel, a turn's review tab, and the turn-tail card's
 * hover preview: all three draw the same object — git's patch text or pi's,
 * parsed by `diff-parse.ts` — so the row geometry, the number gutters and the
 * fold rule live in one place rather than drifting apart. The rows come from
 * `FileDiff.module.css` (the reference's own sheet, ported), and the fold
 * control's chrome from `ChangesTab.module.css`, which is where this project
 * keeps the panel it belongs to.
 */
import { useState } from "react";
import clsx from "clsx";
import { useT } from "../../lib/app-state.ts";
import type { DiffHunk, DiffLine } from "./diff-parse.ts";
import { TreeChevronIcon } from "./rightbar-icons.tsx";
import diffStyles from "./FileDiff.module.css";
import styles from "./ChangesTab.module.css";

/** Hunk lines a file opens with before its own diffs start collapsed. */
const HUNK_OPEN_LINES = 80;

/** The sign a drawn row carries; a context line has neither and gets the space. */
function markerOf(kind: DiffLine["kind"]): string {
  return kind === "add" ? "+" : kind === "del" ? "-" : " ";
}

/**
 * One hunk's lines, numbered on both sides.
 *
 * Split out of {@link DiffHunkView} so the turn-tail card's hover comparison can
 * draw the same rows without the fold control or the hunk header — dsh shares
 * one `FileDiff` between its preview and its review tab for exactly this reason,
 * and two renderers are free to disagree about a line number where one is not.
 *
 * The rows are drawn with `FileDiff.module.css`, the port of the reference's own
 * sheet, everywhere: one picture of a diff for the panel, the review tab and the
 * comparison alike. Whether a long line wraps is the body's decision, not a
 * row's — a body carrying `data-review-wrap` wraps (the panel and the review
 * tab, whose patch scrolls with the pane), and one without it scrolls sideways
 * (the comparison, which is placed at a measured width).
 *
 * @param hunk - a parsed hunk; its `meta` lines (the `@@` header) are not drawn.
 */
export function DiffLines({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      {hunk.lines.map((line, index) =>
        line.kind === "meta" ? null : (
          <div
            className={clsx(
              diffStyles.line,
              line.kind === "add" && diffStyles.lineAdd,
              line.kind === "del" && diffStyles.lineDel,
              line.kind === "context" && diffStyles.lineContext,
            )}
            data-diff-line={line.kind}
            key={`${String(index)}:${line.text}`}
          >
            <span className={diffStyles.num}>{line.oldLine ?? ""}</span>
            <span className={diffStyles.num}>{line.newLine ?? ""}</span>
            <span className={diffStyles.marker}>{markerOf(line.kind)}</span>
            <span className={diffStyles.text}>{line.text}</span>
          </div>
        ),
      )}
    </>
  );
}

/**
 * One hunk, collapsible on its own.
 *
 * A single file can carry several distant hunks, and the interesting one is
 * often the smallest; folding per hunk (rather than per file) is what makes a
 * big diff readable. A hunk long enough to fill the panel starts folded, with
 * its line count on the header so nothing is hidden silently.
 */
export function DiffHunkView({ hunk }: { hunk: DiffHunk }) {
  const t = useT();
  const bodyLines = hunk.lines.filter((line) => line.kind !== "meta");
  const [open, setOpen] = useState(bodyLines.length <= HUNK_OPEN_LINES);

  return (
    <div className={diffStyles.hunk}>
      <button
        type="button"
        className={styles.hunkHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={clsx(styles.chevron, open && styles.chevronOpen)}>
          <TreeChevronIcon width={11} height={11} />
        </span>
        <span className={styles.hunkRange}>{hunk.header}</span>
        <span className={styles.hunkCount}>
          {t("fileDiff.lineCount", { count: bodyLines.length })}
          {open ? "" : ` · ${t("fileDiff.expandHint")}`}
        </span>
      </button>
      {open ? <DiffLines hunk={hunk} /> : null}
    </div>
  );
}

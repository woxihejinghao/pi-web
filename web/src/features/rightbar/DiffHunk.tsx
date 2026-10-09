/**
 * One hunk of a unified diff, drawn with both line numbers and collapsible on
 * its own.
 *
 * Shared by the changes panel and a turn's review tab: both draw the same object
 * — git's patch text or pi's, both parsed by `diff-parse.ts` — so the row
 * geometry, the number gutters and the fold rule live in one place rather than
 * drifting apart in two. The styles come from `ChangesTab.module.css`, which is
 * where this project keeps its diff rows; dsh splits them into a
 * `FileDiff.module.css` for the same reason.
 */
import { useState } from "react";
import clsx from "clsx";
import { useT } from "../../lib/app-state.ts";
import type { DiffHunk } from "./diff-parse.ts";
import { TreeChevronIcon } from "./rightbar-icons.tsx";
import styles from "./ChangesTab.module.css";

/** Hunk lines a file opens with before its own diffs start collapsed. */
const HUNK_OPEN_LINES = 80;

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
    <div className={styles.hunk}>
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
      {open
        ? hunk.lines.map((line, index) =>
            line.kind === "meta" ? null : (
              <div
                className={clsx(
                  styles.line,
                  line.kind === "add" && styles.lineAdd,
                  line.kind === "del" && styles.lineDel,
                )}
                key={`${String(index)}:${line.text}`}
              >
                <span className={styles.num}>{line.oldLine ?? ""}</span>
                <span className={styles.num}>{line.newLine ?? ""}</span>
                <span className={styles.marker}>
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                </span>
                <span className={styles.text}>{line.text}</span>
              </div>
            ),
          )
        : null}
    </div>
  );
}

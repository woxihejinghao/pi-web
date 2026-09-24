import { useState } from "react";
import { ChevronIcon } from "../../components/icons.tsx";
import { DiffIcon } from "../rightbar/rightbar-icons.tsx";
import type { TurnFile } from "./turn-files.ts";
import styles from "./ChangedFilesCard.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * Rows shown before the fold: dsh's summary height for a closing message, and
 * enough that a turn's ordinary one-to-three file change needs no second click.
 */
const COLLAPSED_ROWS = 3;

/** The per-tool tally in the header: how many files each tool wrote. */
function toolTally(files: readonly TurnFile[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const tool of file.tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, count]) => `${tool} ${String(count)}`).join(" · ");
}

/**
 * The files a turn wrote, as a card at the turn's tail.
 *
 * Every row opens its file in the right sidebar's preview. That is the whole
 * point of the card: the transcript already says a `write` happened, and what a
 * reader wants next is the file, not the tool row's argument summary. Files
 * outside the project are listed but not clickable — the preview route takes a
 * project-relative path, and pretending otherwise would put a button on screen
 * that can only fail.
 */
export function ChangedFilesCard({
  files,
  onOpenFile,
}: {
  files: readonly TurnFile[];
  /** Absent when the sidebar cannot be addressed (no session path yet). */
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const foldable = files.length > COLLAPSED_ROWS;
  const rows = foldable && !expanded ? files.slice(0, COLLAPSED_ROWS) : files;

  const targetOf = (file: TurnFile): string | null =>
    onOpenFile !== undefined && file.relative !== null ? file.relative : null;
  /** The header opens the first file that can actually be previewed. */
  const headerTarget = files.find((file) => targetOf(file) !== null);

  const header = (
    <>
      <span className={styles.tile}>
        <DiffIcon width={18} height={18} />
      </span>
      <span className={styles.titles}>
        <span className={styles.title}>{t("editedFiles.title", { count: files.length })}</span>
        <span className={styles.stat}>{toolTally(files)}</span>
      </span>
    </>
  );

  return (
    <div className={styles.card} data-turn-files>
      {headerTarget === undefined ? (
        <div className={styles.header}>{header}</div>
      ) : (
        <button
          type="button"
          className={styles.header}
          aria-label={t("editedFiles.previewAll")}
          onClick={() => {
            const target = targetOf(headerTarget);
            if (target !== null) onOpenFile?.(target);
          }}
        >
          {header}
        </button>
      )}

      <ul className={styles.list}>
        {rows.map((file) => {
          const target = targetOf(file);
          const label = <span className={styles.path}>{file.display}</span>;
          const badge = (
            <span className={styles.tools}>
              {file.tools.join(" · ")}
              {file.calls > 1 ? ` ×${String(file.calls)}` : ""}
            </span>
          );
          return (
            <li key={file.path}>
              {target === null ? (
                <div className={styles.row} title={file.path}>
                  {label}
                  {badge}
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.row}
                  title={file.path}
                  aria-label={t("editedFiles.previewOne", { name: file.display })}
                  onClick={() => onOpenFile?.(target)}
                >
                  {label}
                  {badge}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {foldable ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-label={expanded ? t("editedFiles.collapseAll") : t("editedFiles.expandAll", { count: files.length })}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? t("common.collapse") : t("editedFiles.showAll", { count: files.length })}</span>
          <ChevronIcon width={14} height={14} />
        </button>
      ) : null}
    </div>
  );
}

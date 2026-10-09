import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/app-state.ts";
import { ChevronDownIcon } from "../../components/icons.tsx";
import { ExternalIcon } from "./rightbar-icons.tsx";
import { parseUnifiedDiff } from "./diff-parse.ts";
import { DiffHunkView } from "./DiffHunk.tsx";
import { parseTurnChangesTarget, type RightbarTab } from "./rightbar-state.ts";
import { useTurnChanges } from "./turn-changes-store.ts";
import styles from "./TurnChangesTab.module.css";

/** dsh groups its line counts; a turn that adds 1200 lines says so readably. */
const GROUPED = new Intl.NumberFormat("en-US");

/**
 * One turn's changed files, behind a file selector.
 *
 * dsh's review tab (`ReviewTab.tsx`) reads a summary and a comparison from the
 * Host by session and event sequence; this project has neither a snapshot nor a
 * route, so it reads the transcript's own projection out of `turn-changes-store`
 * — the same numbers and the same patches the card at the turn's tail was drawn
 * from. A turn whose tab was restored from a saved layout, or whose transcript is
 * no longer loaded, has nothing to read and says so instead of showing an empty
 * panel.
 *
 * **One deliberate difference from dsh**: there is no side-by-side view and no
 * line-wrap toggle. The wrap toggle is absent because the rows already wrap (this
 * project's changes panel scrolls with its pane rather than inside itself, so
 * long lines must wrap to be readable at all); the split view is absent because
 * this project has no split diff anywhere, which
 * `docs/known-limitations.md` records.
 */
export function TurnChangesTab({
  sessionPath,
  tab,
  onOpenFile,
}: {
  sessionPath: string;
  tab: RightbarTab;
  /** Opens the whole file in the sidebar; absent means the control is not drawn. */
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const t = useT();
  const coordinates = useMemo(() => parseTurnChangesTarget(tab.target), [tab.target]);
  const turn = coordinates?.turn ?? 0;
  const changes = useTurnChanges(sessionPath, turn);

  /** The file the tab is showing; the address carries it so a re-entry can move it. */
  const [index, setIndex] = useState(coordinates?.index ?? 0);
  const [menuOpen, setMenuOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);

  // Every navigation to this tab applies its file index; the tab itself is keyed
  // by id, so it is not remounted by the address changing under it.
  useEffect(() => {
    setIndex(coordinates?.index ?? 0);
  }, [coordinates]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (selectorRef.current?.contains(event.target as Node) === true) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const files = changes?.files ?? [];
  const selected = files[index] ?? files[0];
  const hunks = useMemo(
    () =>
      selected === undefined
        ? []
        : selected.patches.flatMap((patch) => parseUnifiedDiff(patch).hunks),
    [selected],
  );

  const counts = (added: number, deleted: number) => (
    <>
      <span className={styles.added}>+{GROUPED.format(added)}</span>
      <span className={styles.deleted}>-{GROUPED.format(deleted)}</span>
    </>
  );

  return (
    <div className={styles.root} data-turn-changes>
      <div className={styles.header}>
        {selected === undefined ? (
          <span className={styles.title}>{t("turnChanges.title", { turn })}</span>
        ) : (
          <div className={styles.selector} ref={selectorRef}>
            <button
              type="button"
              className={styles.selectorButton}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t("turnChanges.selectFile")}
              title={selected.display}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <span className={styles.selectorPath}>{selected.display}</span>
              <ChevronDownIcon width={12} height={12} />
            </button>
            {menuOpen ? (
              <div className={styles.menu} role="menu">
                {files.map((file, fileIndex) => (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    key={file.path}
                    onClick={() => {
                      setIndex(fileIndex);
                      setMenuOpen(false);
                    }}
                  >
                    <span className={styles.menuPath}>{file.display}</span>
                    <span className={styles.counts}>{counts(file.added, file.deleted)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
        {selected !== undefined && selected.relative !== null && onOpenFile !== undefined ? (
          <button
            type="button"
            className={styles.tool}
            title={t("turnChanges.openFile")}
            aria-label={t("turnChanges.openFileAria", { name: selected.display })}
            onClick={() => {
              if (selected.relative !== null) onOpenFile(selected.relative);
            }}
          >
            <ExternalIcon width={15} height={15} />
          </button>
        ) : null}
      </div>

      <div className={styles.body}>
        {selected === undefined ? (
          <p className={styles.note}>{t("turnChanges.missing")}</p>
        ) : hunks.length === 0 ? (
          <p className={styles.note}>
            {selected.oversized ? t("turnChanges.oversized") : t("turnChanges.noDiff")}
          </p>
        ) : (
          hunks.map((hunk, hunkIndex) => (
            <DiffHunkView key={`${String(hunkIndex)}:${hunk.header}`} hunk={hunk} />
          ))
        )}
      </div>
    </div>
  );
}

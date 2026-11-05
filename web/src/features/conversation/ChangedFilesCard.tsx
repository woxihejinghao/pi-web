import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
  Ref,
} from "react";
import { createPortal } from "react-dom";
import type { Translate } from "../../lib/i18n/index.ts";
import { ChevronIcon } from "../../components/icons.tsx";
import { DiffLines } from "../rightbar/DiffHunk.tsx";
import { DiffIcon, FileIcon } from "../rightbar/rightbar-icons.tsx";
import { parseUnifiedDiff, type DiffHunk, type DiffLine } from "../rightbar/diff-parse.ts";
import diffStyles from "../rightbar/FileDiff.module.css";
import type { TurnFile } from "./turn-files.ts";
import { previewPlacement, previewTopMargin, type PreviewPlacement } from "./preview-position.ts";
import styles from "./ChangedFilesCard.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * Rows shown before the fold: dsh's summary height for a closing message, and
 * enough that a turn's ordinary one-to-three file change needs no second click.
 */
const COLLAPSED_ROWS = 4;

/** dsh opens a row's comparison after half a second of hover, not on contact. */
const PREVIEW_DELAY_MS = 500;

/**
 * Grace a pointer gets to travel from a row onto the open comparison.
 *
 * dsh's `HoverCard` keeps the same 200ms for the same trip (`usePointerGrace`):
 * without it the pane disappears the moment the pointer leaves the row, so the
 * scrollport it draws and the text in it can never be used.
 */
const PREVIEW_GRACE_MS = 200;

/**
 * The fade a dismissal runs through, and how long the panel stays mounted for
 * it — dsh's `PREVIEW_FADE_MS`. Without it a comparison the pointer has left
 * vanishes between two frames; with it, coming back inside during the fade
 * cancels the dismissal instead of having to reopen the row from scratch.
 */
const PREVIEW_FADE_MS = 100;

/** dsh groups its line counts; a turn that adds 1200 lines says so readably. */
const GROUPED = new Intl.NumberFormat("en-US");

/**
 * Lines one comparison draws before it stops and says so — dsh's
 * `MAX_RENDERED_LINES`. A turn can write a generated file, and the whole point
 * of this card is that hovering a row is cheap: past the cap the panel keeps its
 * height and the note names what is missing rather than the browser laying out
 * tens of thousands of rows nobody will read.
 */
const MAX_RENDERED_LINES = 5000;

/**
 * The hunks a comparison has room for, and whether it had to stop.
 *
 * dsh cuts inside the hunk that runs past the cap (`renderedHunks`), so the
 * first line the reader loses is the one just past the budget; this does the
 * same. `meta` lines are the `@@` header, which is never drawn, so they stay
 * with their hunk.
 */
function renderableHunks(hunks: readonly DiffHunk[]): {
  hunks: DiffHunk[];
  truncated: boolean;
} {
  const shown: DiffHunk[] = [];
  let budget = MAX_RENDERED_LINES;
  for (const hunk of hunks) {
    const body = hunk.lines.filter((line) => line.kind !== "meta");
    if (body.length > budget) {
      if (budget > 0) {
        const kept = new Set<DiffLine>(body.slice(0, budget));
        shown.push({
          ...hunk,
          lines: hunk.lines.filter((line) => line.kind === "meta" || kept.has(line)),
        });
      }
      return { hunks: shown, truncated: true };
    }
    shown.push(hunk);
    budget -= body.length;
  }
  return { hunks: shown, truncated: false };
}

/** The last segment of a path, either separator — what a one-file header is named. */
function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Added and deleted line counts in the card's two colors, as dsh draws them. */
function Counts({ added, deleted, t }: { added: number; deleted: number; t: Translate }) {
  return (
    <>
      <span className={styles.added}>{t("editedFiles.added", { count: GROUPED.format(added) })}</span>
      <span className={styles.deleted}>{t("editedFiles.deleted", { count: GROUPED.format(deleted) })}</span>
    </>
  );
}

/** The counts one file shows, or the reason it has none. */
function fileCounts(file: TurnFile, t: Translate) {
  if (file.oversized && file.added + file.deleted === 0) {
    return <span>{t("editedFiles.oversized")}</span>;
  }
  return <Counts added={file.added} deleted={file.deleted} t={t} />;
}

/**
 * The files a turn wrote, as a card at the turn's tail.
 *
 * Every row opens the turn's review in the right sidebar, on that file — dsh's
 * card does the same (`openReview(index)`), and the review is where the
 * comparison, the other files of the turn, and the way into the whole file all
 * live. The transcript already says a `write` happened; what a reader wants next
 * is the change, not the tool row's argument summary. A row is a button whenever
 * the sidebar can be addressed, including a file outside the project: its patch
 * is in the transcript like any other, and only the review's "open the whole
 * file" control needs a project-relative path.
 *
 * A single-file turn keeps only the header, the way dsh does: the file's name is
 * the whole title, so a list of one would repeat it. Multi-file turns carry the
 * per-file counts and a hover comparison, and hold their rows to four before the
 * fold.
 */
export function ChangedFilesCard({
  files,
  turn,
  onOpenChanges,
}: {
  files: readonly TurnFile[];
  /** The turn these files belong to — what a review tab is addressed by. */
  turn: number;
  /** Absent when the sidebar cannot be addressed (no session path yet). */
  onOpenChanges?: ((turn: number, index: number) => void) | undefined;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  /** Index of the file whose comparison is open. */
  const [preview, setPreview] = useState(0);
  /**
   * The comparison's three phases — dsh's `HoverCard` shape. `closed` draws
   * nothing, `open` is the comparison, and `closing` is that same comparison
   * fading out: still mounted, still readable, and back to `open` if the pointer
   * or the keyboard returns before the fade is over.
   */
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const open = phase !== "closed";
  /** The comparison's box once it has been measured; null until then. */
  const [placement, setPlacement] = useState<PreviewPlacement | null>(null);
  const positioned = placement !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  /** The row the open comparison is anchored to, and the card it is sized from. */
  const rowRef = useRef<HTMLElement | null>(null);
  /** The comparison itself, measured for where its top edge lands. */
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** The half-second dwell a row must hold before its comparison opens. */
  const armTimer = useRef<number | null>(null);
  /** The grace a pointer gets to cross from a row onto the open comparison. */
  const closeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current);
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  /**
   * Place the comparison against the viewport, before paint.
   *
   * The panel is portalled to `document.body` and `position: fixed`, so its box
   * is computed here instead of inherited from an ancestor. The old card hung it
   * absolutely inside its own `position: relative` shell: the transcript's
   * scrollport then became its containing block and clipped it along the edge the
   * composer sits on, which is the "covered by the input" the reader saw.
   * Portalling is also what the tooltip does, and it keeps the panel out of the
   * scrollport's stacking context, so no ancestor's `transform`/`filter`/
   * containment can trap it later. {@link previewPlacement} holds the
   * arithmetic; this holds what it is measured from.
   *
   * It re-places on scroll and resize because the row under a fixed panel can
   * move without the pointer moving — and with capture, because the transcript's
   * scrollport is a nested scroller whose events never reach the window. The
   * `positioned` dependency is what re-runs it for a panel that was 0 tall on the
   * first pass, so the top edge is decided from the height it actually has.
   */
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = (): void => {
      const row = rowRef.current;
      if (row === null) return;
      const card = rootRef.current;
      const bounds = row.getBoundingClientRect();
      setPlacement(
        previewPlacement(
          bounds,
          card === null ? bounds : card.getBoundingClientRect(),
          panelRef.current?.offsetHeight ?? 0,
          { width: window.innerWidth, height: window.innerHeight },
          previewTopMargin(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--dsh-frame-top-clearance",
            ),
          ),
        ),
      );
    };
    place();
    const observer = new ResizeObserver(place);
    for (const element of [panelRef.current, rootRef.current, rowRef.current]) {
      if (element !== null) observer.observe(element);
    }
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, positioned]);

  /** The fade's own clock: the comparison unmounts once it has run out. */
  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(() => {
      setPhase("closed");
    }, PREVIEW_FADE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [phase]);

  const single = files.length === 1 ? files[0] : undefined;
  const foldable = files.length > COLLAPSED_ROWS;
  const rows = foldable && !expanded ? files.slice(0, COLLAPSED_ROWS) : files;
  const added = files.reduce((total, file) => total + file.added, 0);
  const deleted = files.reduce((total, file) => total + file.deleted, 0);

  const openable = onOpenChanges !== undefined;
  /** Open the turn's review on one file; the card never previews a file itself. */
  const openAt = (index: number): void => {
    // The hover comparison has done its job once the panel that replaces it is
    // asked for; leaving it up would draw two copies of the same diff.
    cancelPreview();
    onOpenChanges?.(turn, index);
  };

  /** A pointer is back (on a row, or on the comparison): the pane stays up. */
  const cancelClose = useCallback((): void => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  /**
   * Start the dismissal: the comparison fades, and is gone when the fade ends.
   *
   * The phase transition is written as a function of the current phase so a
   * second close (or a close with the timer already run out) cannot skip the
   * fade, and a return during the fade cancels the unmount.
   */
  const beginClose = useCallback((): void => {
    cancelClose();
    setPhase((current) => (current === "closed" ? "closed" : "closing"));
  }, [cancelClose]);

  /** Escape dismisses the comparison while it is up, as dsh's HoverCard does. */
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === "Escape") beginClose();
    };
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss);
    };
  }, [open, beginClose]);

  /** Drop a pending or already-open comparison now, with no fade. */
  const cancelPreview = (): void => {
    if (armTimer.current !== null) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    cancelClose();
    setPhase("closed");
  };

  /**
   * A row arms the comparison half a second in, so passing over the card costs
   * nothing. Every row arms one, including a file whose patch this transcript
   * cannot draw: the pane then says why instead of the hover doing nothing.
   *
   * The same row coming back during the grace or during the fade keeps the
   * comparison it already has instead of restarting the dwell (dsh: `if (open)
   * setPhase('open'); return`); a different row retargets the one panel after its
   * own dwell, and the panel it replaces is not closed on the way, so crossing
   * rows never blinks.
   */
  const armPreview = (index: number, row: HTMLElement): void => {
    cancelClose();
    if (open && index === preview) {
      setPhase("open");
      return;
    }
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => {
      armTimer.current = null;
      rowRef.current = row;
      setPreview(index);
      setPhase("open");
    }, PREVIEW_DELAY_MS);
  };

  /**
   * The pointer left a row, or left the comparison itself.
   *
   * The close is delayed so the pointer can cross the few pixels between the two
   * (see {@link PREVIEW_GRACE_MS}); coming back to either cancels it. The arm
   * timer goes with it — a pointer already on its way out should not still open a
   * pane on the row it is leaving — and a closed card has nothing to close, so
   * passing over it costs no timers at all.
   */
  const scheduleClose = (): void => {
    if (armTimer.current !== null) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    if (!open) return;
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      beginClose();
    }, PREVIEW_GRACE_MS);
  };

  const hoverProps = (index: number) => ({
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => {
      armPreview(index, event.currentTarget);
    },
    onMouseLeave: scheduleClose,
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      armPreview(index, event.currentTarget);
    },
    onBlur: scheduleClose,
  });

  const headline = single === undefined ? t("editedFiles.title", { count: files.length }) : null;
  const header = (
    <>
      <span className={styles.tile}>
        {single === undefined ? (
          <DiffIcon width={18} height={18} />
        ) : (
          <FileIcon width={18} height={18} />
        )}
      </span>
      <span className={styles.titles}>
        <span className={styles.title}>
          {single === undefined
            ? headline
            : t("editedFiles.singleTitle", { name: basename(single.display) })}
        </span>
        <span className={styles.stat}>
          <span className={styles.statCounts}>
            {single === undefined ? (
              <Counts added={added} deleted={deleted} t={t} />
            ) : (
              fileCounts(single, t)
            )}
          </span>
          <span className={styles.previewHint}>{t("editedFiles.previewHint")}</span>
        </span>
      </span>
    </>
  );

  const headerLabel =
    single === undefined
      ? t("editedFiles.reviewAll")
      : t("editedFiles.viewDiff", { name: single.display });

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-turn-files
      data-single={single !== undefined || undefined}
    >
      <div className={styles.card}>
        {openable ? (
          <button
            type="button"
            className={styles.header}
            aria-label={headerLabel}
            onClick={() => openAt(0)}
            {...(single === undefined ? {} : hoverProps(0))}
          >
            {header}
          </button>
        ) : (
          <div className={styles.header}>{header}</div>
        )}

        {single === undefined ? (
          <ul className={styles.list}>
            {rows.map((file) => {
              const index = files.indexOf(file);
              const label = <span className={styles.path}>{file.display}</span>;
              const badge = <span className={styles.counts}>{fileCounts(file, t)}</span>;
              const hover = hoverProps(index);
              return (
                <li key={file.path}>
                  {openable ? (
                    <button
                      type="button"
                      className={styles.row}
                      title={file.path}
                      aria-label={t("editedFiles.viewDiff", { name: file.display })}
                      onClick={() => openAt(index)}
                      {...hover}
                    >
                      {label}
                      {badge}
                    </button>
                  ) : (
                    <div className={styles.row} title={file.path} {...hover}>
                      {label}
                      {badge}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {foldable ? (
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t("editedFiles.collapseAll")
                : t("editedFiles.expandAll", { count: files.length })
            }
            onClick={() => setExpanded((value) => !value)}
          >
            <span>
              {expanded ? t("common.collapse") : t("editedFiles.showAll", { count: files.length })}
            </span>
            <ChevronIcon width={14} height={14} />
          </button>
        ) : null}
      </div>

      {open && placement !== null && files[preview] !== undefined
        ? createPortal(
            <ChangedFilePreview
              file={files[preview] as TurnFile}
              onEnter={cancelClose}
              onLeave={scheduleClose}
              panelRef={panelRef}
              closing={phase === "closing"}
              style={
                {
                  left: placement.left,
                  top: placement.top,
                  width: placement.width,
                  maxHeight: placement.maxHeight,
                  // The stylesheet's fade reads this; dsh publishes its own the
                  // same way, beside the box.
                  "--dsh-hover-preview-fade": `${String(PREVIEW_FADE_MS)}ms`,
                } as CSSProperties
              }
            />,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * The comparison a hovered file opens: one surface, drawn over the whole app.
 *
 * The lines come from pi's own patches — the same text the counts were parsed
 * from — so the header can never claim `+3 -1` over a diff showing something
 * else. dsh hides the hunk headers in this preview because the panel it opens is
 * one click away; this one does the same, and keeps only the lines that carry
 * the change. The rows themselves are {@link DiffLines}, the same component the
 * changes panel and the review tab draw, so a line number here is read the way
 * every other diff in the app reads it.
 *
 * The pane is a pointer target in its own right: `onEnter`/`onLeave` keep it up
 * while a reader scrolls it or selects from it, which is the whole reason the
 * card delays its close.
 *
 * It is drawn in a portal on `document.body` and its box is handed down from the
 * card ({@link previewPlacement}), so what is left here is the surface itself:
 * the path, and the diff. `panelRef` is how the card measures that surface for
 * the placement's top edge; `closing` is dsh's `data-closing`, the fade before
 * the unmount.
 *
 * Exported because the card can only mount it after a dwell no static render can
 * perform: this is the component the pane's contents are asserted through. Its
 * added props stay optional so a plain `<ChangedFilePreview file=… />` still
 * renders the surface.
 */
export function ChangedFilePreview({
  file,
  onEnter,
  onLeave,
  panelRef,
  closing = false,
  style,
}: {
  file: TurnFile;
  onEnter: () => void;
  onLeave: () => void;
  /** The surface itself, measured by the card's placement pass. */
  panelRef?: Ref<HTMLDivElement> | undefined;
  /** True while the comparison is fading out. */
  closing?: boolean | undefined;
  /** The box the card computed: left, top, width, max-height. */
  style?: CSSProperties | undefined;
}) {
  const t = useT();
  const hunks = useMemo(
    () => file.patches.flatMap((patch) => parseUnifiedDiff(patch).hunks),
    [file.patches],
  );
  const drawn = useMemo(() => renderableHunks(hunks), [hunks]);

  return (
    <div
      ref={panelRef}
      className={styles.preview}
      data-turn-files-preview
      data-closing={closing || undefined}
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className={styles.previewPath} title={file.path}>
        {file.display}
      </div>
      <div className={diffStyles.body} data-review-view="unified">
        {drawn.hunks.length === 0 ? (
          file.oversized ? (
            <p className={diffStyles.status} role="status">
              {t("turnChanges.oversized")}
            </p>
          ) : (
            <p className={diffStyles.note} data-diff-note="empty">
              {t("turnChanges.noDiff")}
            </p>
          )
        ) : (
          <>
            {drawn.hunks.map((hunk, hunkIndex) => (
              <div className={diffStyles.hunk} key={`${String(hunkIndex)}:${hunk.header}`}>
                <DiffLines hunk={hunk} />
              </div>
            ))}
            {drawn.truncated ? (
              <p className={diffStyles.note} data-diff-truncated>
                {t("turnChanges.truncated", { count: GROUPED.format(MAX_RENDERED_LINES) })}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

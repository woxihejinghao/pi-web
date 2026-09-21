import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RailTurn } from "./turn-rail.ts";
import styles from "./TurnNavigator.module.css";

/** Fixed pitch between neighbouring marks; overflow scrolls inside the frame. */
const TURN_SPACING_PX = 10;
/** Rail padding above the first mark and below the last one, per end. */
const RAIL_INSET_PX = 6;
/** Fade band the mask reserves at a scrollable end. */
const FADE_PX = 24;
/** The frame stops growing here and starts scrolling instead. */
const MAX_RAIL_HEIGHT_PX = 420;

const RAIL_AT_REST: RailScrollState = { top: 0, canScrollUp: false, canScrollDown: false };

interface RailScrollState {
  top: number;
  canScrollUp: boolean;
  canScrollDown: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function itemPosition(index: number): Record<string, string> {
  return { "--turn-natural-position": `${String(index * TURN_SPACING_PX)}px` };
}

function frameStyle(count: number, scrollTop: number, bandHeight: number | null): Record<string, string> {
  return {
    "--turn-natural-height": `${String((count - 1) * TURN_SPACING_PX + 2 * RAIL_INSET_PX)}px`,
    "--turn-rail-inset": `${String(RAIL_INSET_PX)}px`,
    "--turn-scroll-top": `${String(scrollTop)}px`,
    // dsh derives this band from the viewport minus a hard-coded composer
    // height. We measure the scrollport instead, so the rail stays centred when
    // a banner or an error strip changes the available height.
    ...(bandHeight === null ? {} : { "--turn-rail-band": `${String(bandHeight)}px` }),
  };
}

/**
 * Which mark sits under the pointer.
 *
 * The rail is fixed-pitch, so this is arithmetic rather than hit testing: the
 * marks are evenly spaced by construction, and the frame is clipped to
 * `MAX_RAIL_HEIGHT_PX` with its own scroll offset, both of which are known here.
 */
function itemAtPointer(
  items: readonly RailTurn[],
  frame: HTMLElement,
  scrollTop: number,
  clientY: number,
): RailTurn | undefined {
  const offset = clientY - frame.getBoundingClientRect().top + scrollTop - RAIL_INSET_PX;
  return items[clamp(Math.round(offset / TURN_SPACING_PX), 0, items.length - 1)];
}

function railScrollState(scroller: HTMLElement): RailScrollState {
  const top = scroller.scrollTop;
  return {
    top,
    canScrollUp: top > 1,
    canScrollDown: top < scroller.scrollHeight - scroller.clientHeight - 1,
  };
}

function sameRailScrollState(left: RailScrollState, right: RailScrollState): boolean {
  return (
    left.top === right.top &&
    left.canScrollUp === right.canScrollUp &&
    left.canScrollDown === right.canScrollDown
  );
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface TurnNavigatorProps {
  items: readonly RailTurn[];
  /** Turn the scrollport is currently reading, or null before layout settles. */
  activeTurn: number | null;
  /** Turn currently executing, so its mark can pulse. */
  busyTurn: number | null;
  /** Measured height of the scrollport; the CSS fallback applies until it arrives. */
  bandHeight: number | null;
  onNavigate: (turn: number) => void;
}

/**
 * Fixed-pitch rail of every turn in the session — hover to preview, click to
 * jump.
 *
 * Ported from dsh's `TurnNavigator`. Three details carry the whole interaction:
 *
 * - The marks are **evenly spaced** (`TURN_SPACING_PX`), not positioned by
 *   content height. That is what makes the rail a stable index of the session
 *   rather than a map of it, and it is why {@link itemAtPointer} can invert the
 *   layout with one division.
 * - The frame is **clipped and separately scrollable** once a session outgrows
 *   `MAX_RAIL_HEIGHT_PX`, so a 350-turn session still shows a usable rail
 *   instead of a wall of hairlines.
 * - Focus previews too, not just hover, so the rail is reachable by keyboard.
 *
 * One deliberate departure: dsh splices this rail together from a loaded window
 * plus an unloaded "outline" projection, because its transcript is paged. pi
 * serves the whole transcript in one read, so every mark here is loaded and the
 * rail has no paging states to model.
 */
function TurnNavigatorRail({
  items,
  activeTurn,
  busyTurn,
  bandHeight,
  onNavigate,
}: TurnNavigatorProps) {
  const [previewTurn, setPreviewTurn] = useState<number | null>(null);
  const [scrollState, setScrollState] = useState<RailScrollState>(RAIL_AT_REST);
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** While the pointer works the rail, follow must not move it under the hand. */
  const pointerInsideRef = useRef(false);
  const previewId = useMemo(() => `turn-preview-${Math.random().toString(36).slice(2)}`, []);

  const syncScrollState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const next = railScrollState(scroller);
    setScrollState((current) => (sameRailScrollState(current, next) ? current : next));
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncScrollState);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [syncScrollState]);

  useEffect(syncScrollState, [items.length, syncScrollState]);

  // Keep the active mark in view, unless the pointer is using the rail.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null || activeTurn === null || pointerInsideRef.current) return;
    const index = items.findIndex((item) => item.turn === activeTurn);
    if (index < 0) return;
    const markTop = RAIL_INSET_PX + index * TURN_SPACING_PX;
    const viewTop = scroller.scrollTop;
    const viewHeight = scroller.clientHeight;
    if (viewHeight <= 0) return;
    if (markTop >= viewTop + FADE_PX && markTop <= viewTop + viewHeight - FADE_PX) return;
    const target = Math.max(0, markTop - viewHeight / 2);
    const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
    if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top: target, behavior });
    else scroller.scrollTop = target;
    syncScrollState();
  }, [activeTurn, items, syncScrollState]);

  // One mark is not a navigator.
  if (items.length < 2) return null;

  const previewIndex = items.findIndex((item) => item.turn === previewTurn);
  const preview = previewIndex < 0 ? undefined : items[previewIndex];
  const previewPosition = previewIndex < 0 ? undefined : itemPosition(previewIndex);

  const previewAtPointer = (event: React.PointerEvent<HTMLElement>): void => {
    const scrollTop = scrollerRef.current?.scrollTop ?? 0;
    const item = itemAtPointer(items, event.currentTarget, scrollTop, event.clientY);
    setPreviewTurn(item?.turn ?? null);
  };

  const navigateAtPointer = (event: React.MouseEvent<HTMLElement>): void => {
    const scrollTop = scrollerRef.current?.scrollTop ?? 0;
    const item = itemAtPointer(items, event.currentTarget, scrollTop, event.clientY);
    if (item !== undefined) onNavigate(item.turn);
  };

  const fadeClasses = [styles.scroller];
  if (scrollState.canScrollUp) fadeClasses.push(styles.fadeTop);
  if (scrollState.canScrollDown) fadeClasses.push(styles.fadeBottom);

  return (
    <div className={styles.slot}>
      <nav
        className={styles.frame}
        style={frameStyle(items.length, scrollState.top, bandHeight)}
        aria-label="轮次导航"
        onClick={navigateAtPointer}
        onPointerMove={previewAtPointer}
        onPointerEnter={() => {
          pointerInsideRef.current = true;
        }}
        onPointerLeave={() => {
          pointerInsideRef.current = false;
          setPreviewTurn(null);
        }}
      >
        <div ref={scrollerRef} className={fadeClasses.join(" ")} onScroll={syncScrollState}>
          <div className={styles.marks}>
            {items.map((item, index) => {
              const active = item.turn === activeTurn;
              const showing = item.turn === previewTurn;
              const classes = [styles.mark];
              if (active) classes.push(styles.markActive);
              else if (showing) classes.push(styles.markPreview);
              if (item.turn === busyTurn) classes.push(styles.markBusy);
              return (
                <div key={item.turn} className={styles.markPosition} style={itemPosition(index)}>
                  <button
                    type="button"
                    className={classes.join(" ")}
                    aria-label={`跳转到第 ${String(item.turn)} 轮`}
                    aria-current={active ? "true" : undefined}
                    aria-busy={item.turn === busyTurn ? "true" : undefined}
                    aria-describedby={showing ? previewId : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      onNavigate(item.turn);
                    }}
                    onFocus={() => {
                      setPreviewTurn(item.turn);
                    }}
                    onBlur={() => {
                      setPreviewTurn(null);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {preview !== undefined && previewPosition !== undefined ? (
          <div id={previewId} role="tooltip" className={styles.preview} style={previewPosition}>
            <div className={styles.previewPrompt}>{preview.prompt || `第 ${String(preview.turn)} 轮`}</div>
            {preview.response !== "" ? (
              <div className={styles.previewResponse}>{preview.response}</div>
            ) : null}
          </div>
        ) : null}
      </nav>
    </div>
  );
}

/**
 * Memoized because the transcript re-renders on every streaming delta while the
 * rail only changes when a turn is added, removed, or becomes active. Its props
 * must stay referentially stable across those commits.
 */
export const TurnNavigator = memo(TurnNavigatorRail);

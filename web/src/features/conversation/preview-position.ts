/**
 * Where the changed-files comparison stands, and how much of it fits.
 *
 * dsh places its preview-variant `HoverCard` this way (`HoverCard.tsx`): the
 * panel is fixed to the viewport, sized from the card it belongs to, and
 * anchored to the row the pointer is on — so it can leave a scrolling, clipped
 * transcript and still point at the row that opened it. The numbers are dsh's
 * own, and this module is where they are decided, so they can be read (and
 * tested) without a browser.
 */

/** The panel never grows past this, whatever room the viewport has to offer. */
export const PREVIEW_MAX_HEIGHT = 420;

/** Air between the card's sides and the panel's, on both sides at once. */
export const PREVIEW_INSET = 24;

/** Air between the row the pointer is on and the panel's near edge. */
export const PREVIEW_ANCHOR_GAP = 8;

/** Air the panel keeps from every viewport edge. */
export const PREVIEW_VIEWPORT_MARGIN = 8;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** The panel's fixed-position box, in viewport pixels. */
export interface PreviewPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/**
 * Place the panel against the row it belongs to.
 *
 * The side is measured, not guessed: the panel takes the larger of the room
 * above the row and the room below it, and the row's own height decides which
 * side that is — a row high in the transcript opens downward, a row near the
 * bottom opens upward, and the cap (`PREVIEW_MAX_HEIGHT`) is what the space is
 * compared against, so a tall panel does not open upward into 200px of room
 * while 600px sit below it.
 *
 * @param row - the hovered row's viewport rect: what the panel is anchored to.
 * @param card - the card's viewport rect: what the panel is sized and inset from.
 * @param height - the panel's own height, as measured; 0 before its first paint,
 * which the caller corrects by placing again (see the card's placement effect).
 * @param viewport - the window's inner size.
 * @param topMargin - the floor for the panel's top edge, from `previewTopMargin`.
 * @returns the panel's box.
 */
export function previewPlacement(
  row: Rect,
  card: Rect,
  height: number,
  viewport: { width: number; height: number },
  topMargin: number,
): PreviewPlacement {
  const width = Math.max(
    0,
    Math.min(card.width - PREVIEW_INSET * 2, viewport.width - PREVIEW_VIEWPORT_MARGIN * 2),
  );
  const belowTop = Math.max(topMargin, row.bottom + PREVIEW_ANCHOR_GAP);
  const above = Math.max(0, row.top - PREVIEW_ANCHOR_GAP - topMargin);
  const below = Math.max(0, viewport.height - belowTop - PREVIEW_VIEWPORT_MARGIN);
  const onTop = above >= Math.min(PREVIEW_MAX_HEIGHT, below);
  const maxHeight = Math.min(PREVIEW_MAX_HEIGHT, onTop ? above : below);
  return {
    left: Math.max(
      PREVIEW_VIEWPORT_MARGIN,
      Math.min(card.left + PREVIEW_INSET, viewport.width - width - PREVIEW_VIEWPORT_MARGIN),
    ),
    // Anchored to the panel's near edge: on top, its bottom sits a gap above the
    // row; below, its top sits a gap under it.
    top: onTop
      ? Math.max(topMargin, row.top - Math.min(height, maxHeight) - PREVIEW_ANCHOR_GAP)
      : belowTop,
    width,
    maxHeight,
  };
}

/**
 * The top margin an overlay keeps from the viewport edge.
 *
 * dsh derives this from the desktop frame's reserved top strip
 * (`overlay-top-margin.ts`); this app declares the same strip as a theme
 * variable, and a browser build that never set it falls back to the margin
 * floor. dsh also lifts the strip in fullscreen, which this app has no mode for.
 *
 * @param clearance - the raw `--dsh-frame-top-clearance` value, e.g. `"48px"`.
 * @param min - the overlay's own viewport margin, used as the floor.
 * @returns the larger of `min` and the strip plus 20px.
 */
export function previewTopMargin(clearance: string, min = PREVIEW_VIEWPORT_MARGIN): number {
  const value = Number.parseFloat(clearance);
  return Number.isNaN(value) ? min : Math.max(min, value + 20);
}

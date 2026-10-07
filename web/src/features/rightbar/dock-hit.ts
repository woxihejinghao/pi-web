/**
 * Where a dragged chip would land, resolved against measured rectangles.
 *
 * dsh keeps this in `DockSurface` as `hitTest`: it is the one part of the drop
 * rules that needs the DOM, so it reads rectangles and hands the decision to
 * the pure geometry. The attributes it walks are the same ones the live browser
 * probe asserts, so a test and the code cannot disagree about what a pane is.
 */
import {
  containsPoint,
  halvesFit,
  horizontalSide,
  insertionIndex,
  type DropZone,
} from "./dock-geometry.ts";

/** Where a release would land if it happened now. */
export type DropTarget =
  /** Onto a tab strip at an explicit slot: a reorder or a cross-pane move. */
  | { readonly kind: "strip"; readonly paneId: string; readonly index: number }
  /** Onto a pane body: the middle moves the tab in, a half splits the pane. */
  | { readonly kind: "zone"; readonly paneId: string; readonly zone: DropZone };

/** A pane element, carrying its id. */
export const PANE_ATTR = "data-rb-pane";
/** A pane's tab strip. */
export const STRIP_ATTR = "data-rb-strip";
/** One chip. */
export const TAB_ATTR = "data-rb-tab";

/**
 * Where a pointer is inside the docked row.
 *
 * A point in a strip resolves to an insertion slot, which is why the strip is
 * tested before the pane's own rectangle: the strip is *inside* the pane, and
 * a release among the chips means "put it here in this strip" rather than
 * anything about halves.
 * @param root - the docked row element.
 * @param x - pointer x in viewport coordinates.
 * @param y - pointer y in viewport coordinates.
 * @param canSplit - whether the pane budget allows another docked pane.
 * @returns the target, or null when the pointer is over no pane at all.
 */
export function hitTest(
  root: HTMLElement,
  x: number,
  y: number,
  canSplit: boolean,
): DropTarget | null {
  for (const pane of root.querySelectorAll<HTMLElement>(`[${PANE_ATTR}]`)) {
    const paneId = pane.getAttribute(PANE_ATTR);
    if (paneId === null) continue;
    const rect = pane.getBoundingClientRect();
    if (!containsPoint(rect, x, y)) continue;
    const strip = pane.querySelector<HTMLElement>(`[${STRIP_ATTR}]`);
    if (strip !== null && containsPoint(strip.getBoundingClientRect(), x, y)) {
      const chips = [...strip.querySelectorAll<HTMLElement>(`[${TAB_ATTR}]`)];
      return {
        kind: "strip",
        paneId,
        index: insertionIndex(
          chips.map((chip) => chip.getBoundingClientRect()),
          x,
        ),
      };
    }
    // The budget and the room rule decide whether an edge means anything at
    // all: when either says no, every point in the body is the middle and a
    // release moves the tab in instead of splitting. dsh reaches the same place
    // by resolving the zone to `'center'` in its horizontal drop mode.
    const zone: DropZone = canSplit && halvesFit(rect.width) ? horizontalSide(rect, x) : "center";
    return { kind: "zone", paneId, zone };
  }
  return null;
}

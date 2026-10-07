/**
 * Pure geometry for the right sidebar's docking gestures.
 *
 * Free of React and of DOM types, so every drop rule and every threshold can be
 * asserted without a browser: the component layer measures rectangles and calls
 * in here. The numbers are dsh's, taken from
 * `ui-dockkit/src/engine/{constraints,geometry}.ts` — including the pane
 * minimum, which the kit defaults to 0.12 and the right sidebar overrides to
 * 0.2 at its own call site (`SidebarRight.tsx`'s `minPaneFraction`). A rule and
 * its threshold are one decision; splitting them is how they drift.
 */

/** A measured rectangle in viewport coordinates. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Viewport rectangle of a floating panel, in CSS pixels. */
export interface FloatRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A width/height pair used as a floating panel's bound. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Where a dragged chip would land on a pane's body.
 *
 * dsh's `DockZone` has five members because its kit can stack panes as well as
 * sit them side by side. This surface cannot: the right sidebar's docked tree
 * is one row of at most two panes, so a release is one of the two halves or the
 * middle, and the two members that could only ever produce an unreachable
 * layout are left out rather than handled and never used.
 */
export type DropZone = "center" | "left" | "right";

/**
 * The narrowest half a split may produce, in pixels.
 *
 * dsh measures this off the DOM after every commit (`.strip`'s fixed controls
 * plus one chip at its minimum) and keeps a constant fallback for the case
 * where nothing can be measured. There is nothing to measure that this number
 * does not already say: the row splits into equal halves, so the rule is a
 * comparison against twice one half. 150 is the strip's own arithmetic, rounded
 * to a number a reader can hold — 14px of padding, a 24px add control, a 24px
 * split control, 12px of gaps and a 72px chip (`Rightbar.module.css`).
 */
export const HALF_MIN_WIDTH = 150;

/**
 * Whether splitting a pane this wide would leave two working halves.
 * @param paneWidth - the pane's measured width in CSS pixels.
 * @returns whether each half would still hold a strip with one readable chip.
 */
export function halvesFit(paneWidth: number): boolean {
  // An unmeasured pane (no layout, as under a static render) fits: the rule
  // only blocks on a positive reading, which is dsh's own guard.
  return !(paneWidth > 0) || paneWidth / 2 >= HALF_MIN_WIDTH;
}

/**
 * Smallest share a divider drag may leave a pane, as a fraction of the split.
 *
 * dsh's right sidebar, not the kit's 0.12: two panes in a 420px column are
 * already narrow, and a fifth of it is the point below which the second pane
 * stops being readable rather than merely small.
 */
export const MIN_PANE_FRACTION = 0.2;

/** Size a tab takes when it first floats, in CSS pixels. */
export const FLOAT_DEFAULT_SIZE: Size = { width: 380, height: 300 };

/** Smallest size a floating panel may be resized to, in CSS pixels. */
export const FLOAT_MIN_SIZE: Size = { width: 220, height: 140 };

/** Where the first floating panel appears, in viewport pixels. */
export const FLOAT_ORIGIN = { x: 160, y: 120 } as const;

/** Distance each newly floated panel steps down and right from the last. */
export const FLOAT_CASCADE_STEP = 24;

/** How far a new panel's origin sits above and left of the drop point. */
const GRAB_OFFSET = { x: 60, y: 14 } as const;

/** How far a pointer must travel before a press becomes a drag, in pixels. */
export const DRAG_THRESHOLD = 4;

/**
 * Whether a point is inside a rectangle, edges included.
 * @param rect - the rectangle.
 * @param x - point x in the same coordinates.
 * @param y - point y in the same coordinates.
 * @returns whether the point lies on or inside the rectangle.
 */
export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * Whether a press has travelled far enough to be a drag.
 * @param startX - press x.
 * @param startY - press y.
 * @param x - current pointer x.
 * @param y - current pointer y.
 * @returns whether either axis moved at least `DRAG_THRESHOLD`.
 */
export function passedThreshold(startX: number, startY: number, x: number, y: number): boolean {
  return Math.abs(x - startX) >= DRAG_THRESHOLD || Math.abs(y - startY) >= DRAG_THRESHOLD;
}

/**
 * Which half of a pane a point falls in.
 *
 * The right sidebar drops horizontally only (`dropZones="horizontal"` there):
 * with at most two panes side by side, a top or bottom band could only ever
 * make a second split the layout is not allowed to have, so the pointer's side
 * of the midline *is* the whole decision. The midline is the pane's own, so
 * both panes offer both halves.
 * @param rect - the pane's measured box.
 * @param x - pointer x in the same coordinates.
 * @returns the half a split would take.
 */
export function horizontalSide(rect: Rect, x: number): "left" | "right" {
  return x < rect.x + rect.width / 2 ? "left" : "right";
}

/**
 * Slot a tab would take in a strip, by comparing the pointer with each chip's midpoint.
 * @param tabRects - the strip's chip boxes in strip order.
 * @param x - pointer x.
 * @returns the insertion index, from 0 to `tabRects.length`.
 */
export function insertionIndex(tabRects: readonly Rect[], x: number): number {
  let index = 0;
  for (const rect of tabRects) {
    if (x < rect.x + rect.width / 2) break;
    index += 1;
  }
  return index;
}

/**
 * Clamp divider sizes so no pane falls under `minimum`.
 * @param sizes - candidate fractions from the drag preview.
 * @param minimum - smallest allowed share; defaults to the pane minimum.
 * @returns fractions summing to 1 with every entry at or above the floor.
 */
export function clampSizes(sizes: readonly number[], minimum = MIN_PANE_FRACTION): number[] {
  if (sizes.length === 0) return [];
  // A floor that cannot be met for this many children would pin every share and
  // leave nothing to distribute, so it is capped at an equal split.
  const floor = Math.min(minimum, 1 / sizes.length);
  const positive = sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0));
  const total = positive.reduce((sum, size) => sum + size, 0);
  let shares = total > 0 ? positive.map((size) => size / total) : positive.map(() => 1 / sizes.length);
  // Pin every share under the floor at the floor and hand the remainder to the
  // others in proportion; a share that only now drops under joins the pinned set
  // on the next pass, so the result holds the floor exactly. The free shares sit
  // at or above the floor and sum to at least the remainder, so at least one
  // stays free and their total stays positive.
  const pinned = new Set<number>();
  for (;;) {
    const under = shares.flatMap((share, index) =>
      !pinned.has(index) && share < floor ? [index] : [],
    );
    if (under.length === 0) return shares;
    for (const index of under) pinned.add(index);
    const remainder = 1 - pinned.size * floor;
    const freeTotal = shares.reduce((sum, share, index) => (pinned.has(index) ? sum : sum + share), 0);
    shares = shares.map((share, index) =>
      pinned.has(index) ? floor : (share / freeTotal) * remainder,
    );
  }
}

/**
 * Split fractions after a divider drag.
 * @param sizes - the split's current fractions.
 * @param index - divider position: the boundary between `index` and `index + 1`.
 * @param delta - pointer travel along the split axis, as a fraction of the split's extent.
 * @returns new fractions; the two neighbours absorb the whole change.
 */
export function dividerSizes(
  sizes: readonly number[],
  index: number,
  delta: number,
): number[] {
  const before = sizes[index];
  const after = sizes[index + 1];
  if (before === undefined || after === undefined) return [...sizes];
  const next = [...sizes];
  next[index] = before + delta;
  next[index + 1] = after - delta;
  return next;
}

/** Fractions closer than this are the same split: renormalising moves them by no more. */
const SIZE_TOLERANCE = 1e-9;

/**
 * Whether two fraction lists describe the same split.
 * @param a - one list.
 * @param b - the other.
 * @returns whether every entry agrees within `SIZE_TOLERANCE`.
 */
export function sameSizes(a: readonly number[], b: readonly number[]): boolean {
  return (
    a.length === b.length &&
    a.every((size, index) => {
      const other = b[index];
      return other !== undefined && Math.abs(size - other) < SIZE_TOLERANCE;
    })
  );
}

/**
 * A floating panel's rectangle after a drag, kept on the viewport.
 *
 * dsh lets a panel's origin go negative and leaves the recovery to the user,
 * clamping only the top against the Windows caption. A header dragged past the
 * top-left corner is a panel whose only handle is off screen, so this clamps
 * both axes at zero — the one place this geometry is not a copy.
 * @param rect - the rectangle the gesture started from.
 * @param dx - pointer travel on x.
 * @param dy - pointer travel on y.
 * @returns the moved rectangle; the size is unchanged.
 */
export function movedRect(rect: FloatRect, dx: number, dy: number): FloatRect {
  return { ...rect, x: Math.max(0, rect.x + dx), y: Math.max(0, rect.y + dy) };
}

/**
 * A floating panel's rectangle after a bottom-right resize.
 * @param rect - the rectangle the gesture started from.
 * @param dx - pointer travel on x.
 * @param dy - pointer travel on y.
 * @param min - smallest size the panel may take.
 * @returns the resized rectangle; the origin is unchanged.
 */
export function resizedRect(rect: FloatRect, dx: number, dy: number, min: Size): FloatRect {
  return {
    ...rect,
    width: Math.max(min.width, rect.width + dx),
    height: Math.max(min.height, rect.height + dy),
  };
}

/**
 * Where a panel should appear when a tab is dropped outside the docked area.
 * @param x - drop point x.
 * @param y - drop point y.
 * @param size - the panel's size.
 * @returns a rectangle whose header sits under the drop point.
 */
export function floatRectAt(x: number, y: number, size: Size): FloatRect {
  return { x: Math.max(0, x - GRAB_OFFSET.x), y: Math.max(0, y - GRAB_OFFSET.y), ...size };
}

/**
 * The rectangle the next floating panel would take, cascading from the last.
 * @param count - how many panels are already floating.
 * @returns the default rectangle for the next one.
 */
export function cascadedRect(count: number): FloatRect {
  const step = count * FLOAT_CASCADE_STEP;
  return {
    x: FLOAT_ORIGIN.x + step,
    y: FLOAT_ORIGIN.y + step,
    width: FLOAT_DEFAULT_SIZE.width,
    height: FLOAT_DEFAULT_SIZE.height,
  };
}

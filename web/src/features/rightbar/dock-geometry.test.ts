import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD,
  FLOAT_CASCADE_STEP,
  FLOAT_DEFAULT_SIZE,
  FLOAT_MIN_SIZE,
  FLOAT_ORIGIN,
  HALF_MIN_WIDTH,
  MIN_PANE_FRACTION,
  cascadedRect,
  clampSizes,
  containsPoint,
  dividerSizes,
  floatRectAt,
  halvesFit,
  horizontalSide,
  insertionIndex,
  movedRect,
  passedThreshold,
  resizedRect,
  sameSizes,
  type FloatRect,
  type Rect,
} from "./dock-geometry.ts";

/** A rectangle from its left edge and width, which is how the strip reads. */
function box(x: number, width: number, y = 0, height = 20): Rect {
  return { x, y, width, height };
}

describe("containsPoint", () => {
  it("counts the edges as inside", () => {
    const rect = box(10, 100, 20, 40);
    expect(containsPoint(rect, 10, 20)).toBe(true);
    expect(containsPoint(rect, 110, 60)).toBe(true);
    expect(containsPoint(rect, 9, 20)).toBe(false);
    expect(containsPoint(rect, 110, 61)).toBe(false);
  });
});

describe("passedThreshold", () => {
  it("needs one axis to travel the whole threshold", () => {
    expect(passedThreshold(0, 0, DRAG_THRESHOLD - 1, 0)).toBe(false);
    // Either axis alone is enough: a chip is mostly dragged sideways, but a
    // gesture that only moves vertically is a drag too.
    expect(passedThreshold(0, 0, 0, DRAG_THRESHOLD)).toBe(true);
    expect(passedThreshold(100, 100, 100 - DRAG_THRESHOLD, 100)).toBe(true);
  });

  it("does not let two small steps add up", () => {
    // Each axis is compared on its own, so a diagonal wobble of 3px stays a
    // click rather than becoming a drag by accumulation.
    expect(passedThreshold(0, 0, DRAG_THRESHOLD - 1, DRAG_THRESHOLD - 1)).toBe(false);
  });
});

describe("horizontalSide", () => {
  const rect = box(100, 200);

  it("puts the pointer on its own side of the pane's midline", () => {
    expect(horizontalSide(rect, 150)).toBe("left");
    expect(horizontalSide(rect, 260)).toBe("right");
  });

  it("gives the right half the exact midline", () => {
    // 200 + 100 is the midline; a pointer exactly on it has to fall somewhere,
    // and "right" is the half that keeps a left edge meaningful.
    expect(horizontalSide(rect, 200)).toBe("right");
  });
});

describe("insertionIndex", () => {
  // Three 80px chips with a 4px gap, starting at 0.
  const chips = [box(0, 80), box(84, 80), box(168, 80)];

  it("counts the chips whose midpoint the pointer has passed", () => {
    expect(insertionIndex(chips, 0)).toBe(0);
    expect(insertionIndex(chips, 39)).toBe(0);
    expect(insertionIndex(chips, 41)).toBe(1);
    expect(insertionIndex(chips, 130)).toBe(2);
  });

  it("reaches one past the last chip", () => {
    expect(insertionIndex(chips, 500)).toBe(3);
  });

  it("is zero for an empty strip", () => {
    expect(insertionIndex([], 500)).toBe(0);
  });
});

describe("halvesFit", () => {
  it("measures a half against the strip's own arithmetic", () => {
    expect(halvesFit(HALF_MIN_WIDTH * 2)).toBe(true);
    expect(halvesFit(HALF_MIN_WIDTH * 2 - 1)).toBe(false);
  });

  it("allows an unmeasured pane", () => {
    // A static render has no layout, so the reading is zero — and a control
    // that refuses on a reading nobody took is worse than one that offers.
    expect(halvesFit(0)).toBe(true);
    expect(halvesFit(Number.NaN)).toBe(true);
  });
});

describe("clampSizes", () => {
  it("keeps the floor and hands the remainder to the other pane", () => {
    expect(clampSizes([0.9, 0.1])).toEqual([0.8, MIN_PANE_FRACTION]);
    expect(clampSizes([0.1, 0.9])).toEqual([MIN_PANE_FRACTION, 0.8]);
  });

  it("leaves a legal split alone", () => {
    expect(clampSizes([0.5, 0.5])).toEqual([0.5, 0.5]);
    expect(clampSizes([0.7, 0.3])).toEqual([0.7, 0.3]);
  });

  it("joins a share that only drops under on a later pass", () => {
    // 0.2 is free to begin with and falls to ~0.1975 once the pinned share's
    // remainder is spread, so a single pass would leave a pane under the floor.
    expect(clampSizes([0.19, 0.2, 0.61], 0.2)).toEqual([0.2, 0.2, 0.6]);
  });

  it("caps an impossible floor at an equal split", () => {
    // A floor of 0.6 across three children cannot be met; pinning all three
    // would leave nothing to distribute, so the floor yields instead.
    expect(clampSizes([0.5, 0.5], 0.6)).toEqual([0.5, 0.5]);
  });

  it("normalises whatever it is given", () => {
    expect(clampSizes([2, 2])).toEqual([0.5, 0.5]);
  });

  it("treats a share that is not a usable number as nothing at all", () => {
    expect(clampSizes([Number.NaN, Number.NaN])).toEqual([0.5, 0.5]);
    expect(clampSizes([0, 0])).toEqual([0.5, 0.5]);
    // An unbounded share is not a width; it is dropped and the pane keeps the
    // floor rather than taking the whole split.
    expect(clampSizes([Number.POSITIVE_INFINITY, 1])).toEqual([MIN_PANE_FRACTION, 0.8]);
  });

  it("answers an empty list with one", () => {
    expect(clampSizes([])).toEqual([]);
  });
});

describe("dividerSizes", () => {
  it("moves the boundary, and only the two panes beside it", () => {
    expect(dividerSizes([0.25, 0.25, 0.5], 0, 0.1)).toEqual([0.35, 0.15, 0.5]);
    expect(dividerSizes([0.25, 0.25, 0.5], 1, 0.1)[2]).toBe(0.4);
  });

  it("hands back an unchanged copy for a boundary that does not exist", () => {
    const sizes = [1];
    const next = dividerSizes(sizes, 0, 0.5);
    expect(next).toEqual([1]);
    expect(next).not.toBe(sizes);
  });
});

describe("sameSizes", () => {
  it("compares within the slider's own resolution", () => {
    expect(sameSizes([0.5, 0.5], [0.5, 0.5])).toBe(true);
    // A renormalised split lands a few ulps away and is still the same split.
    expect(sameSizes([0.5, 0.5], [0.5 + 1e-12, 0.5 - 1e-12])).toBe(true);
    expect(sameSizes([0.5, 0.5], [0.51, 0.49])).toBe(false);
  });

  it("does not call two different lengths the same", () => {
    expect(sameSizes([0.5, 0.5], [1])).toBe(false);
  });
});

describe("movedRect", () => {
  const rect: FloatRect = { x: 100, y: 100, width: 380, height: 300 };

  it("adds the pointer's travel to the origin and keeps the size", () => {
    expect(movedRect(rect, 40, -20)).toEqual({ x: 140, y: 80, width: 380, height: 300 });
  });

  it("clamps both axes at zero", () => {
    // The one place this geometry is not dsh's: a panel whose header has been
    // dragged off the top-left corner has lost the only handle it has, and dsh
    // leaves the recovery to the user.
    expect(movedRect(rect, -500, -500)).toEqual({ x: 0, y: 0, width: 380, height: 300 });
  });

  it("lets the panel hang off the far edges, where the resize grip still is", () => {
    expect(movedRect(rect, 9999, 9999)).toMatchObject({ x: 10099, y: 10099 });
  });
});

describe("resizedRect", () => {
  const rect: FloatRect = { x: 100, y: 100, width: 380, height: 300 };

  it("grows from the corner and keeps the origin", () => {
    expect(resizedRect(rect, 20, 30, FLOAT_MIN_SIZE)).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 330,
    });
  });

  it("stops at the minimum rather than inverting the panel", () => {
    expect(resizedRect(rect, -9999, -9999, FLOAT_MIN_SIZE)).toEqual({
      x: 100,
      y: 100,
      width: FLOAT_MIN_SIZE.width,
      height: FLOAT_MIN_SIZE.height,
    });
  });
});

describe("floatRectAt", () => {
  it("puts the panel's header under the drop point", () => {
    // The header is grabbed 60px from the panel's left and 14px from its top,
    // so a release at (500, 400) lands a panel whose header is under the
    // pointer — not one whose corner is.
    expect(floatRectAt(500, 400, FLOAT_DEFAULT_SIZE)).toEqual({
      x: 440,
      y: 386,
      width: FLOAT_DEFAULT_SIZE.width,
      height: FLOAT_DEFAULT_SIZE.height,
    });
  });

  it("clamps a release near the top-left corner", () => {
    expect(floatRectAt(10, 10, FLOAT_DEFAULT_SIZE)).toMatchObject({ x: 0, y: 0 });
  });
});

describe("cascadedRect", () => {
  it("steps each panel off the last", () => {
    expect(cascadedRect(0)).toEqual({ ...FLOAT_ORIGIN, ...FLOAT_DEFAULT_SIZE });
    expect(cascadedRect(2)).toEqual({
      x: FLOAT_ORIGIN.x + 2 * FLOAT_CASCADE_STEP,
      y: FLOAT_ORIGIN.y + 2 * FLOAT_CASCADE_STEP,
      ...FLOAT_DEFAULT_SIZE,
    });
  });
});

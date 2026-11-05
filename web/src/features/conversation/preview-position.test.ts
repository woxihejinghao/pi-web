import { describe, expect, it } from "vitest";
import {
  PREVIEW_ANCHOR_GAP,
  PREVIEW_INSET,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_VIEWPORT_MARGIN,
  previewPlacement,
  previewTopMargin,
  type Rect,
} from "./preview-position.ts";

const VIEWPORT = { width: 1280, height: 900 };

/** A box, from the pieces a placement test actually varies. */
function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/** A row of the ordinary height, in a card of the ordinary width. */
const ROW = rect(124, 400, 652, 32);
const CARD = rect(100, 200, 700, 300);

describe("previewPlacement", () => {
  it("sizes and insets the panel inside the card it belongs to", () => {
    const placed = previewPlacement(ROW, CARD, 200, VIEWPORT, PREVIEW_VIEWPORT_MARGIN);

    expect(placed.width).toBe(CARD.width - PREVIEW_INSET * 2);
    expect(placed.left).toBe(CARD.left + PREVIEW_INSET);
  });

  it("opens above the row when the room below is the smaller one", () => {
    const row = rect(124, 800, 652, 32);
    const placed = previewPlacement(row, CARD, 200, VIEWPORT, PREVIEW_VIEWPORT_MARGIN);

    expect(placed.maxHeight).toBe(PREVIEW_MAX_HEIGHT);
    expect(placed.top).toBe(row.top - 200 - PREVIEW_ANCHOR_GAP);
  });

  it("opens under the row when the room above is the smaller one", () => {
    const row = rect(124, 40, 652, 32);
    const placed = previewPlacement(row, CARD, 200, VIEWPORT, PREVIEW_VIEWPORT_MARGIN);

    expect(placed.top).toBe(row.bottom + PREVIEW_ANCHOR_GAP);
    expect(placed.maxHeight).toBe(PREVIEW_MAX_HEIGHT);
  });

  it("hangs a tall panel off a row near the bottom, capped and inside the viewport", () => {
    const row = rect(124, 800, 652, 32);
    // The panel is taller than the room above it (784px) is wide: the cap is
    // what is compared, so a 900px panel still opens upward.
    const placed = previewPlacement(row, CARD, 900, VIEWPORT, PREVIEW_VIEWPORT_MARGIN);

    expect(placed.maxHeight).toBe(PREVIEW_MAX_HEIGHT);
    expect(placed.top).toBe(row.top - PREVIEW_MAX_HEIGHT - PREVIEW_ANCHOR_GAP);
    expect(placed.top).toBeGreaterThanOrEqual(PREVIEW_VIEWPORT_MARGIN);
  });

  it("keeps a card that runs off the viewport edge inside it", () => {
    const card = rect(1200, 200, 700, 300);
    const placed = previewPlacement(ROW, card, 200, VIEWPORT, PREVIEW_VIEWPORT_MARGIN);

    expect(placed.width).toBe(card.width - PREVIEW_INSET * 2);
    expect(placed.left).toBe(VIEWPORT.width - placed.width - PREVIEW_VIEWPORT_MARGIN);
  });

  it("narrows the panel to fit a narrow viewport", () => {
    const placed = previewPlacement(ROW, CARD, 200, { width: 300, height: 700 }, PREVIEW_VIEWPORT_MARGIN);

    expect(placed.width).toBe(300 - PREVIEW_VIEWPORT_MARGIN * 2);
    expect(placed.left).toBe(PREVIEW_VIEWPORT_MARGIN);
  });

  it("never lets the top edge into the frame's reserved strip", () => {
    const row = rect(124, 30, 652, 10);
    const placed = previewPlacement(row, CARD, 200, VIEWPORT, 68);

    expect(placed.top).toBe(68);
  });

  it("takes the measured panel height into account once it has one", () => {
    const row = rect(124, 800, 652, 32);
    const unmeasured = previewPlacement(row, CARD, 0, VIEWPORT, PREVIEW_VIEWPORT_MARGIN);
    const measured = previewPlacement(row, CARD, 120, VIEWPORT, PREVIEW_VIEWPORT_MARGIN);

    expect(unmeasured.top).toBe(row.top - PREVIEW_ANCHOR_GAP);
    expect(measured.top).toBe(row.top - 120 - PREVIEW_ANCHOR_GAP);
  });
});

describe("previewTopMargin", () => {
  it("falls back to the overlay margin when the app never declared a strip", () => {
    expect(previewTopMargin("")).toBe(PREVIEW_VIEWPORT_MARGIN);
    expect(previewTopMargin("auto")).toBe(PREVIEW_VIEWPORT_MARGIN);
  });

  it("clears the frame's strip by dsh's own 20px", () => {
    expect(previewTopMargin("48px")).toBe(68);
  });

  it("keeps the floor when the strip is thinner than it", () => {
    expect(previewTopMargin("0px")).toBe(20);
  });
});

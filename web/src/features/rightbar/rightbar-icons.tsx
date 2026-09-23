import type { SVGProps } from "react";

/**
 * The right sidebar's own glyphs.
 *
 * dsh draws the panel toggle from its layout package and the browser toolbar
 * from its primitives; neither exists in this app's two icon modules, and each
 * one here follows their conventions: a 16px viewBox, a single stroked path set
 * at the 1.4 baseline `icons.tsx` uses, and `currentColor` so a row can inherit
 * its state colour.
 */
const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...props,
});

/** One pane split into a main area and a right column: the panel itself. */
export const PanelRightIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <rect x={2} y={3} width={12} height={10} rx={1.5} />
    <path d="M9.75 3v10" />
  </svg>
);

/** A page opening outside this app. */
export const ExternalIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M9.5 3h3.5v3.5" />
    <path d="M13 3 7.5 8.5" />
    <path d="M11.5 9.5V12a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" />
  </svg>
);

/** Four corners pushing outward: "cover the viewport". */
export const FullscreenIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6" />
    <path d="M10 2.5h2.5a1 1 0 0 1 1 1V6" />
    <path d="M13.5 10v2.5a1 1 0 0 1-1 1H10" />
    <path d="M6 13.5H3.5a1 1 0 0 1-1-1V10" />
  </svg>
);

/** Four corners pulling inward: "back into the column". */
export const RestoreIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M5.5 2.5V5a1 1 0 0 1-1 1H2" />
    <path d="M10.5 2.5V5a1 1 0 0 0 1 1H14" />
    <path d="M5.5 13.5V11a1 1 0 0 0-1-1H2" />
    <path d="M10.5 13.5V11a1 1 0 0 1 1-1H14" />
  </svg>
);

/** The document glyph on a file row and on a preview tab chip. */
export const FileIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M4 2.5h5l3 3V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" />
    <path d="M9 2.5v3h3" />
  </svg>
);

/** Tree disclosure, pointing at the level it opens. */
export const TreeChevronIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M6.5 4 10 8l-3.5 4" />
  </svg>
);

/**
 * Two stacked change bars: the diff tab's glyph.
 *
 * dsh has no diff glyph of its own to copy (it shows diffs inside tool rows, not
 * as their own surface), so this one follows the same rules as the rest of the
 * module rather than reproducing an original.
 */
export const DiffIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M8 2.6v5.8M5.1 5.5h5.8" />
    <path d="M5.1 12.4h5.8" />
  </svg>
);

/** The staged/unstaged actions' glyphs: a plain minus and a revert arrow. */
export const MinusIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M3.5 8h9" />
  </svg>
);

export const UndoIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M3 8a5 5 0 1 0 5-5H4.5" />
    <path d="M6.5 1 3 3l3.5 2" />
  </svg>
);

export const BackIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </svg>
);

export const ForwardIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
);

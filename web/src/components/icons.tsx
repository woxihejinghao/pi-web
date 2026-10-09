import type { SVGProps } from "react";

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

/**
 * dsh's `IconGaugeOutline16`, the glyph on the session-statistics pill.
 *
 * Stroked at 1.25 rather than this file's 1.4: the dial is one open arc, and the
 * thicker stroke closes the gap the outline is drawn with.
 */
export const GaugeIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden
    {...props}
  >
    <path d="M3.49 13.26A6.375 6.375 0 1 1 12.51 13.26" stroke="currentColor" strokeWidth={1.25} />
    <path d="M8 8.75L11.4 5.35" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" />
    <circle cx={8} cy={8.75} r={1.55} fill="currentColor" />
  </svg>
);

export const FolderIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2c.4 0 .78.16 1.06.44L7.8 4.5h4.7A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
  </svg>
);

/**
 * dsh's `IconFolderCloseRegular` (its `FolderCloseArtwork`, 1px stroke) — the
 * closed folder the hero's workspace chip wears before a workspace is chosen.
 *
 * Copied rather than mapped onto `FolderIcon` above: this file's own 16px
 * outline is stroked at 1.4, which at chip size reads heavier than the chip's
 * 13px label it sits beside. dsh draws that folder and its open twin from one
 * artwork set, so both live here for the same reason.
 */
export const FolderCloseIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 16 16"
    fill="none"
    strokeWidth={1}
    aria-hidden
    {...props}
  >
    <path
      d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z"
      stroke="currentColor"
    />
    <path d="M3.63501 7.66614H12.3647" stroke="currentColor" />
  </svg>
);

/**
 * dsh's `IconFolderOpenRegular` — the open folder the chip wears once a
 * workspace is chosen, so the glyph itself says the chip points at a real
 * directory. Fill-only geometry (with the 0.16 lid tint), weight-independent.
 */
export const FolderOpenIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden
    {...props}
  >
    <path
      d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z"
      fill="currentColor"
      opacity={0.16}
    />
    <path
      d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z"
      fill="currentColor"
    />
    <path
      d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z"
      fill="currentColor"
    />
  </svg>
);

export const PlusIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

export const EyeOffIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M2 2l12 12M6.3 6.4a2.2 2.2 0 0 0 3.1 3.1M4.2 4.4C2.9 5.3 2 6.6 2 8c0 2 2.7 4 6 4 1.2 0 2.3-.3 3.2-.9M13.4 9.9c.4-.6.6-1.2.6-1.9 0-2-2.7-4-6-4-.5 0-1 .06-1.5.17" />
  </svg>
);

export const ChatIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M13.5 8c0 2.6-2.5 4.7-5.5 4.7-.7 0-1.4-.1-2-.3L3 13.5l.9-2.4A4.4 4.4 0 0 1 2.5 8c0-2.6 2.5-4.7 5.5-4.7s5.5 2.1 5.5 4.7z" />
  </svg>
);

/**
 * The square on dsh's primary disc, taken from the inline `<svg>` in its
 * `InputBar.tsx` — not from `ui-primitives`' own `IconStopFill`, which is a
 * different mark: that one is 11x11 at rx 1, this one is 10x10 at rx 3. Only
 * this one shares a button with `SendIcon`.
 */
export const StopIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden {...props}>
    <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
  </svg>
);

export const RefreshIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3" />
  </svg>
);

/**
 * The arrow on dsh's primary disc, byte-identical to the inline `<svg>` in its
 * `InputBar.tsx`. A filled glyph spanning nearly the whole 16px box, because a
 * 1.4px outline of that size reads hollow against the blue fill — this is the
 * composer's own artwork, not the stroked `IconSendOutline` the icon set
 * carries under the same name.
 */
export const SendIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden {...props}>
    <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
  </svg>
);

export const ChevronIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M6 4l4 4-4 4" />
  </svg>
);

/**
 * dsh's `IconChevronDownOutlineRegular` (1px stroke, 14px default): the caret
 * on the hero's workspace chip. A drawn-down glyph rather than a rotated
 * `ChevronIcon` — the rotation turns the corner but keeps the 1.4px weight,
 * while dsh ships this as its own lighter artwork.
 */
export const ChevronDownIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden {...props}>
    <path
      d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"
      stroke="currentColor"
    />
  </svg>
);

export const WrenchIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M10.4 2.6a3.2 3.2 0 0 0-4 4L2.8 10.2a1.4 1.4 0 0 0 2 2l3.6-3.6a3.2 3.2 0 0 0 4-4l-1.9 1.9-1.6-1.6z" />
  </svg>
);

export const AlertIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M8 2.8 14 13H2zM8 6.6v3.1M8 11.4h.01" />
  </svg>
);

export const ArrowUpIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M8 12.5V3.5M4 7.5 8 3.5l4 4" />
  </svg>
);

export const CloseIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

/** The tick on the model menu's current row. dsh has no stroked check glyph to
 * copy (its menus use a different marker), so this follows `icons.tsx`'s own
 * 16px / 1.4 stroke baseline. */
export const CheckIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

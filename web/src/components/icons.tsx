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

export const PlusIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

export const PencilIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M11.2 2.8a1.6 1.6 0 0 1 2.3 2.3L6 12.5l-3 .7.7-3z" />
  </svg>
);

export const TrashIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" />
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

export const StopIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </svg>
);

export const RefreshIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3" />
  </svg>
);

export const SendIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M13.5 2.5 7 9M13.5 2.5 9.6 13.2 7 9 2.5 6.6z" />
  </svg>
);

export const ChevronIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <path d="M6 4l4 4-4 4" />
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

export const SearchIcon = (props: SVGProps<SVGSVGElement>) => (
  <svg {...base(props)}>
    <circle cx="7.2" cy="7.2" r="4.2" />
    <path d="m10.6 10.6 2.9 2.9" />
  </svg>
);

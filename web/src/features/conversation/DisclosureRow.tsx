import type { ReactNode } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import styles from "./DisclosureRow.module.css";

/**
 * The one expandable row every tool call and reasoning block renders through.
 *
 * Ported from dsh's `DisclosureRow` primitive. The behaviour worth naming:
 *
 * - The leading slot shows the tool's own icon, and on hover cross-fades in a
 *   chevron *in the same 16px box* — there is no separate chevron column, which
 *   is why a collapsed row is exactly as wide as its content.
 * - `expandOnRowClick` makes the whole row the button (`role`, `tabIndex`, and
 *   Enter/Space) rather than just the icon. When it is off but the row is still
 *   expandable, only the icon is a real `<button>`.
 * - Once open the chevron pins and turns to point up, so the row stops
 *   advertising "click me" and starts advertising "click to close". dsh swaps in
 *   a second, upward glyph; this rotates the one chevron instead, because a
 *   swapped node cannot transition and the flip is the only motion the fold has.
 * - The row owns its colour: tertiary at rest, secondary while hovered, with the
 *   title, the glyph, and the chevron all inheriting it.
 * - `collapsedContent` (the separator dot and summary) is dropped while open
 *   unless `keepContentWhenOpen`, because the expanded body already says it.
 */
export function DisclosureRow({
  icon,
  title,
  open,
  expandable,
  onToggle,
  expandOnRowClick = false,
  previewChevron = expandable,
  keepContentWhenOpen = false,
  collapsedContent,
  children,
  className,
  rowClassName,
  leadingClassName,
  titleClassName,
}: {
  icon: ReactNode;
  title: ReactNode;
  open: boolean;
  expandable: boolean;
  onToggle: () => void;
  expandOnRowClick?: boolean;
  previewChevron?: boolean;
  keepContentWhenOpen?: boolean;
  collapsedContent?: ReactNode;
  children?: ReactNode;
  className?: string;
  rowClassName?: string;
  leadingClassName?: string;
  titleClassName?: string;
}) {
  const clickable = expandable && expandOnRowClick;

  const stopAndToggle = (event: React.MouseEvent): void => {
    event.stopPropagation();
    onToggle();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!clickable) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle();
  };

  // The chevron stays mounted in both states, which is what lets its 180deg
  // rotation animate: dsh renders a second up-chevron element when the row opens,
  // and a freshly mounted node has no transform to transition from, so the fold
  // would snap. `data-chevron-preview` carries `previewChevron` down to CSS,
  // where the hover cross-fade is the only thing it gates — it is deliberately
  // not called `data-preview`, which is dsh's own name for whether a *reasoning
  // row* shows its summary line.
  const leading = (
    <>
      <span className={styles.iconIdle}>{icon}</span>
      {expandable ? (
        <Glyph name="chevronDown" className={styles.chevron} />
      ) : null}
    </>
  );

  return (
    <div className={clsx(styles.root, className)} data-open={open || undefined}>
      <div
        className={clsx(styles.row, rowClassName)}
        data-disclosure-row
        data-chevron-preview={expandable && previewChevron ? "true" : undefined}
        data-expandable={clickable || undefined}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-expanded={clickable ? open : undefined}
        onClick={clickable ? onToggle : undefined}
        onKeyDown={clickable ? onKeyDown : undefined}
      >
        {expandable && !clickable ? (
          <button
            type="button"
            className={clsx(styles.leading, leadingClassName)}
            aria-expanded={open}
            onClick={stopAndToggle}
          >
            {leading}
          </button>
        ) : (
          <span className={clsx(styles.leading, leadingClassName)}>{leading}</span>
        )}
        <span className={clsx(styles.title, titleClassName)}>{title}</span>
        {(keepContentWhenOpen || !open) && collapsedContent}
      </div>
      {open && children}
    </div>
  );
}

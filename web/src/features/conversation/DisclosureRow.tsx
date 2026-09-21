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
 * - Once open, the leading slot pins the chevron instead of cross-fading, so the
 *   row stops advertising "click me" and starts advertising "click to close".
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
  chevronClassName,
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
  chevronClassName?: string;
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

  const idle = previewChevron ? (
    <>
      <span className={styles.iconIdle}>{icon}</span>
      <Glyph name="chevronDown" className={clsx(chevronClassName, styles.chevronHover)} />
    </>
  ) : (
    icon
  );

  const leading = open ? <Glyph name="chevronDown" className={chevronClassName} /> : idle;

  return (
    <div className={clsx(styles.root, className)} data-open={open || undefined}>
      <div
        className={clsx(styles.row, rowClassName)}
        data-disclosure-row
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

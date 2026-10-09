import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import styles from "../../layout/Sidebar.module.css";

/** Where a menu is anchored, in viewport coordinates. */
export interface MenuAnchor {
  top: number;
  right: number;
}

/**
 * A menu floating over the sidebar.
 *
 * Rendered into `document.body` because the sidebar's list is a scroll
 * container — an absolutely positioned menu would be clipped by it. `fixed`
 * coordinates come from the trigger and the menu is right-aligned to it, which
 * is the direction both the row menu and the view-options menu open in.
 *
 * The dismissal rules are dsh's: the trigger counts as part of the menu (so
 * clicking it again toggles rather than close-then-reopen from the
 * `pointerdown`), Escape closes, and a scroll dismisses instead of leaving the
 * menu pinned to a trigger that has moved away from it.
 */
export function SidebarMenu({
  anchor,
  triggerRef,
  onClose,
  ariaLabel,
  className,
  children,
}: {
  anchor: MenuAnchor;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  /** The menu's accessible name; the trigger's own label is not read here. */
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onScroll = (): void => onClose();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose, triggerRef]);

  return createPortal(
    <div
      ref={menuRef}
      className={clsx(styles.projectMenu, className)}
      role="menu"
      aria-label={ariaLabel}
      style={{ top: anchor.top, right: anchor.right }}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * Anchor a menu under its trigger.
 *
 * Viewport coordinates, because the menu is portalled out of the scrolling
 * list; `right` is measured from the viewport edge so the menu grows leftward
 * from the trigger instead of off the sidebar.
 */
export function anchorBelow(trigger: HTMLElement | null | undefined): MenuAnchor | null {
  const rect = trigger?.getBoundingClientRect();
  if (rect === undefined) return null;
  return { top: rect.bottom + 4, right: window.innerWidth - rect.right };
}

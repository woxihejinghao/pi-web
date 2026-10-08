/**
 * The chip's context menu: what a secondary press on a tab offers.
 *
 * dsh's kit menu carries exactly one item of its own — close this tab — and lets
 * the embedder append the rest (its tab menu is a slot for precisely that).
 * Appended here: a rename, offered only for the two kinds that carry a name of
 * their own, and two group closes — with a strip of shells and previews, closing
 * them one at a time is the chore a menu exists to remove. The kit's own item
 * stays first, where a reader looks for it, and it is the only one that survives
 * when there is nothing else to offer — three names for one action is worse than
 * one.
 *
 * Rendered into `document.body` rather than next to the chip: the strip scrolls
 * its overflow on purpose (so four tabs do not shrink every title to two
 * characters), and a menu drawn inside it would be clipped and scrolled with it.
 * dsh portals its tab menu for the same reason. React still bubbles a portal's
 * synthetic events up to the chip, which is why the press guards below stay.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/app-state.ts";
import styles from "./Rightbar.module.css";

/** Gap kept between the menu and the pointer, and between it and the viewport. */
const MENU_GAP = 2;

/** Where the secondary press landed, in viewport coordinates. */
export interface TabMenuPosition {
  x: number;
  y: number;
}

/** What the menu can be asked to do. */
export type TabMenuAction = "close" | "rename" | "closeOthers" | "closeAll";

/**
 * The actions that make sense for a tab on a strip of this size.
 *
 * `canRename` is about the tab, not the strip: a preview is named after its file
 * and a terminal after its shell (or whatever the user last called it), so both
 * have a name to change, while files / changes / browser are named by the message
 * table and a title written on them would never be read.
 *
 * Order: the kit's own item first, then the one action on *this* tab, then the
 * two that reach across the strip. A reader looking for "close" finds it in the
 * same place every time, and the two nested-thirds that close other tabs are
 * kept away from the single-tab entries they would otherwise sit beside.
 */
export function tabMenuActions(
  canRename: boolean,
  hasSiblings: boolean,
): readonly TabMenuAction[] {
  return [
    "close",
    ...(canRename ? (["rename"] as const) : []),
    ...(hasSiblings ? (["closeOthers", "closeAll"] as const) : []),
  ];
}

/**
 * Fit the menu inside the window.
 *
 * It opens down-right from the pointer and flips to the other side of it when
 * that would run off the edge — which it does for a chip near the right of the
 * window, the common case here, since the strip lives at the right.
 *
 * Takes the measurement rather than an element so the arithmetic can be checked
 * without a layout engine; `menu` only has to answer `offsetWidth`/`offsetHeight`.
 */
export function placeMenu(
  position: TabMenuPosition,
  menu: { offsetWidth: number; offsetHeight: number },
  viewport: { width: number; height: number },
): CSSProperties {
  return {
    top:
      position.y + menu.offsetHeight + MENU_GAP > viewport.height
        ? Math.max(MENU_GAP, position.y - menu.offsetHeight)
        : position.y,
    left:
      position.x + menu.offsetWidth + MENU_GAP > viewport.width
        ? Math.max(MENU_GAP, position.x - menu.offsetWidth)
        : position.x,
  };
}

/**
 * The items, as markup.
 *
 * Split from the portalled shell because React's *server* renderer refuses
 * portals outright, and this is the part with a rule worth pinning: which items
 * a strip of this size offers, in which words. The shell below — placement,
 * dismissal, focus — is DOM behavior this repo has no environment for, and its
 * sibling in `projects/ProjectTree.tsx` is uncovered for the same reason.
 */
export function TabMenuItems({
  tabTitle,
  canRename,
  hasSiblings,
  onPick,
}: {
  tabTitle: string;
  canRename: boolean;
  hasSiblings: boolean;
  onPick: (action: TabMenuAction) => void;
}) {
  const t = useT();
  // A map rather than nested ternaries: with four actions the chain was deeper
  // than the thing it described.
  const label = (action: TabMenuAction): string => {
    if (action === "close") return t("rightbar.closeTab", { title: tabTitle });
    if (action === "rename") return t("rightbar.renameTab");
    if (action === "closeOthers") return t("rightbar.closeOtherTabs");
    return t("rightbar.closeAllTabs");
  };
  return (
    <>
      {tabMenuActions(canRename, hasSiblings).map((action) => (
        <button
          key={action}
          type="button"
          className={styles.menuItem}
          role="menuitem"
          onClick={() => onPick(action)}
        >
          {label(action)}
        </button>
      ))}
    </>
  );
}

export interface TabMenuProps {
  /** The chip that was pressed; focus returns here when the menu closes. */
  readonly anchor: HTMLElement;
  readonly position: TabMenuPosition;
  /** The tab's display name, for the close item's wording. */
  readonly tabTitle: string;
  /** Whether this kind carries a name of its own — see `tabMenuActions`. */
  readonly canRename: boolean;
  /** Whether the strip holds another tab, i.e. whether a group can be closed. */
  readonly hasSiblings: boolean;
  /** Close the menu without acting — what every dismissal gesture calls. */
  readonly onDismiss: () => void;
  /**
   * Act. The menu dismisses itself first: two of the three actions leave the
   * pressed tab on screen, so waiting for the tab to disappear would leave the
   * menu hanging over a strip it no longer describes.
   */
  readonly onPick: (action: TabMenuAction) => void;
}

export function TabMenu({
  anchor,
  position,
  tabTitle,
  canRename,
  hasSiblings,
  onDismiss,
  onPick,
}: TabMenuProps) {
  const t = useT();
  const self = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<CSSProperties | null>(null);

  // Measured, then positioned: the width a menu needs is only known once it has
  // been laid out, so it spends one pass at the origin, invisible.
  useLayoutEffect(() => {
    if (self.current === null) return;
    setPlaced(
      placeMenu(position, self.current, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [position]);

  useEffect(() => {
    const menu = self.current;
    if (menu === null) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      // A keydown that belongs to an IME composition belongs to the IME.
      if (event.isComposing) return;
      event.preventDefault();
      // Only take focus back if the menu had it: a menu opened with the mouse
      // must not pull focus out of wherever the reader was typing.
      const hadFocus = menu.contains(document.activeElement);
      onDismiss();
      if (hadFocus) anchor.focus();
    };
    // Capture, and on the window: a press on another chip has to dismiss this
    // one before that chip's own handlers run.
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      onDismiss();
    };
    // The menu is placed in viewport coordinates, so anything that moves the
    // chip under it makes those coordinates wrong. Dismissing is cheaper than
    // re-measuring a menu the reader is leaving anyway.
    const onMove = (): void => onDismiss();

    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [anchor, onDismiss]);

  return createPortal(
    <div
      ref={self}
      className={styles.menu}
      role="menu"
      aria-label={t("rightbar.tabMenu")}
      // `fixed` comes from here rather than the stylesheet: this menu shares the
      // "+" menu's box, and that one hangs off its own trigger.
      style={{ position: "fixed", left: 0, top: 0, ...(placed ?? { visibility: "hidden" }) }}
      // React bubbles these to the chip; stopping them keeps a press on an item
      // from also reaching the tab that item is about to close.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      <TabMenuItems
        tabTitle={tabTitle}
        canRename={canRename}
        hasSiblings={hasSiblings}
        onPick={(action) => {
          onDismiss();
          onPick(action);
        }}
      />
    </div>,
    document.body,
  );
}

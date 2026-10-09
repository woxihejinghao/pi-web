import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import clsx from "clsx";
import { CloseIcon, PlusIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { halvesFit } from "./dock-geometry.ts";
import { STRIP_ATTR, TAB_ATTR, type DropTarget } from "./dock-hit.ts";
import { DiffIcon, FileIcon } from "./rightbar-icons.tsx";
import {
  canSplitDock,
  rightbarActions,
  paneTabs,
  tabTitle,
  type RightbarPane,
  type RightbarSurface,
  type RightbarTab,
  type RightbarTabKind,
} from "./rightbar-state.ts";
import { TabBody } from "./TabBody.tsx";
import { shortcutTitle } from "./shortcuts.ts";
import { terminalActions, terminalStore } from "./terminal-state.ts";
// Named `paneCss` rather than `pane`: this component's own prop is called
// `pane`, and a shadowed CSS import silently resolves to the prop — the
// `pane.note` placeholder below then reads as a property of `RightbarPane`.
import paneCss from "./Pane.module.css";
import styles from "./Rightbar.module.css";

/** Why a pane's split control cannot act right now. */
export type SplitBlock = "budget" | "width";

/** The glyph on a tab chip, by what that tab is showing. */
export function TabIcon({ kind }: { kind: RightbarTabKind }) {
  if (kind === "files") return <Glyph name="checklist" size={13} />;
  if (kind === "browser") return <Glyph name="browse" size={13} />;
  if (kind === "terminal") return <Glyph name="terminal" size={13} />;
  if (kind === "changes" || kind === "changes-review") return <DiffIcon width={13} height={13} />;
  return <FileIcon width={13} height={13} />;
}

/**
 * The split control's glyph: a frame with the seam drawn down the middle, which
 * is the shape a split makes and the reason it needs no label to be understood.
 */
function SplitIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="13" height="13" rx="1" stroke="currentColor" />
      <path d="M8 1.5V14.5" stroke="currentColor" />
    </svg>
  );
}

/** One dock region's glyph: the frame with the half a release would take, filled. */
function ZoneIcon({ zone }: { zone: "center" | "left" | "right" }) {
  return (
    <svg width={20} height={20} viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" />
      {zone === "left" ? <path d="M3 3h5v10H3z" fill="currentColor" /> : null}
      {zone === "right" ? <path d="M8 3h5v10H8z" fill="currentColor" /> : null}
      {zone === "center" ? <path d="M5 5h6v6H5z" fill="currentColor" /> : null}
    </svg>
  );
}

/**
 * The insertion caret for a chip being dragged into this strip.
 *
 * Absolutely positioned rather than a slot between the chips, and that is not
 * only about looks: a caret that took layout width would push the chips after
 * it, which moves the very midpoints `insertionIndex` compares against — a
 * pointer resting near one of those midpoints would flip the index, move the
 * caret, undo the shift that caused the flip, and do it again every frame. dsh
 * sidesteps the same loop by always reserving its slot's width at rest;
 * reserving nothing is the cheaper way to the same guarantee.
 */
function Caret({ box, index }: { box: RefObject<HTMLDivElement | null>; index: number }) {
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const strip = box.current;
    if (strip === null) return;
    const chips = [...strip.querySelectorAll<HTMLElement>(`[${TAB_ATTR}]`)];
    const bounds = strip.getBoundingClientRect();
    const before = chips[index - 1]?.getBoundingClientRect();
    const after = chips[index]?.getBoundingClientRect();
    // Between the two chips the caret would sit between; at either end of the
    // strip it hangs off the last chip it can see.
    const edge =
      before === undefined
        ? (after?.left ?? bounds.left)
        : after === undefined
          ? before.right
          : (before.right + after.left) / 2;
    // The box scrolls, and a positioned child scrolls with it.
    setLeft(edge - bounds.left + strip.scrollLeft);
  }, [box, index]);
  if (left === null) return null;
  return (
    <span
      className={styles.caret}
      data-rb-caret={index}
      style={{ left: `${String(left)}px` }}
      aria-hidden
    />
  );
}

/**
 * The landing cards a dragged chip shows over a pane's body.
 *
 * One card per region a release could take, drawn as a dashed frame with the
 * glyph of the half it would fill and its caption. When an edge is targeted
 * both halves are drawn — the one under the pointer brighter — so the reader
 * can see where the *other* release would land instead of discovering it by
 * trying. dsh's kit draws the same pair in its horizontal drop mode.
 */
function DropHints({ zone }: { zone: "center" | "left" | "right" }) {
  const t = useT();
  const card = (which: "center" | "left" | "right") => (
    <div
      className={clsx(styles.dropCard, which === zone && styles.dropCardActive)}
      data-rb-drop={which}
      data-rb-drop-active={which === zone ? "" : undefined}
    >
      <ZoneIcon zone={which} />
      <span className={styles.dropLabel}>
        {which === "center"
          ? t("rightbar.dropCenter")
          : which === "left"
            ? t("rightbar.dropLeft")
            : t("rightbar.dropRight")}
      </span>
    </div>
  );
  return (
    <div className={styles.dropLayer} aria-hidden>
      <div className={styles.dropScrim} />
      {zone === "center" ? (
        <div className={clsx(styles.dropSlot, styles.dropSlotCenter)}>{card("center")}</div>
      ) : (
        <>
          <div className={clsx(styles.dropSlot, styles.dropSlotLeft)}>{card("left")}</div>
          <div className={clsx(styles.dropSlot, styles.dropSlotRight)}>{card("right")}</div>
        </>
      )}
    </div>
  );
}

/**
 * One pane: its tab strip and the showing tab's body.
 *
 * A pane is the unit both a docked column and a floating panel are made of, so
 * everything here works the same in either; what differs is the host it sits
 * in. The strip carries the pane's own `+`, its split control, and — on the
 * top-right pane only — the panel's own controls, exactly as dsh arranges it:
 * the strip *is* the panel's top edge, and a header of its own would be a
 * second row saying nothing.
 */
export function PaneView({
  sessionPath,
  projectId,
  projectPath,
  surface,
  pane,
  grow,
  marked,
  chrome,
  draggingTabId,
  dropTarget,
  onTabPressed,
  onOpenMenu,
  onSplit,
  onFocusPane,
  onOpenFile,
}: {
  sessionPath: string;
  projectId: string;
  projectPath: string;
  surface: RightbarSurface;
  pane: RightbarPane;
  /** This pane's share of the row; the divider drag changes it live. */
  grow: number;
  /** Whether this pane is the focus among several; a lone pane is never marked. */
  marked: boolean;
  /** The panel's own controls, drawn at the top-right pane's strip end. */
  chrome: ReactNode | null;
  draggingTabId: string | null;
  dropTarget: DropTarget | null;
  onTabPressed: (tabId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onOpenMenu: (tabId: string, anchor: HTMLElement, x: number, y: number) => void;
  onSplit: () => void;
  onFocusPane: () => void;
  onOpenFile: (path: string) => void;
}) {
  const t = useT();
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  const tabs = paneTabs(surface, pane);
  const active = tabs.find((tab) => tab.id === pane.activeTabId) ?? tabs[0] ?? null;

  // The room rule reads pixels, which the model does not carry: the pane
  // measures itself and the split control says why it is disabled. A reading
  // never changes the layout, so this renders the tooltip and nothing else.
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = paneRef.current;
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
  }, [pane.id, surface.panes.length, surface.width, surface.mode]);
  useEffect(() => {
    const element = paneRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setWidth(element.getBoundingClientRect().width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const block: SplitBlock | undefined = !canSplitDock(surface)
    ? "budget"
    : halvesFit(width)
      ? undefined
      : "width";
  const blockReason =
    block === "budget"
      ? t("rightbar.splitFull")
      : block === "width"
        ? t("rightbar.splitNarrow")
        : null;

  const drop = dropTarget !== null && dropTarget.paneId === pane.id ? dropTarget : null;

  return (
    <section
      ref={paneRef}
      className={clsx(styles.pane, marked && styles.paneMarked)}
      style={{ flexGrow: grow }}
      data-rb-pane={pane.id}
      data-rb-pane-active={surface.activePaneId === pane.id ? "" : undefined}
      // Focusing is a click anywhere in the pane: dsh records the same intent
      // from the pane's own click handler, and the focused pane is what the
      // split and fullscreen commands act on.
      onClick={onFocusPane}
    >
      <div className={styles.strip} data-rb-strip={pane.id}>
        <div className={styles.chips} ref={chipsRef}>
          {tabs.map((tab) => (
            <Chip
              key={tab.id}
              sessionPath={sessionPath}
              tab={tab}
              title={tabTitle(tab, t)}
              selected={tab.id === active?.id}
              dragging={tab.id === draggingTabId}
              onPress={onTabPressed}
              onOpenMenu={onOpenMenu}
              onClose={() => rightbarActions.closeTabs(sessionPath, [tab.id])}
            />
          ))}
          {drop?.kind === "strip" ? <Caret box={chipsRef} index={drop.index} /> : null}
        </div>
        <AddTabMenu sessionPath={sessionPath} paneId={pane.id} />
        <span className={styles.stripSpacer} />
        {/* Offered but disabled rather than hidden when it cannot act — dsh keeps
            it visible for the same reason: the sentence explaining *why* is the
            only thing the reader wants at that moment. The wrapper carries it,
            because a disabled button receives no pointer events. */}
        <span
          className={styles.splitWrap}
          tabIndex={block === undefined ? undefined : 0}
          aria-label={blockReason ?? undefined}
          title={
            block === undefined
              ? shortcutTitle(t, t("rightbar.split"), "rightbar.split")
              : (blockReason ?? undefined)
          }
        >
          <button
            type="button"
            className={styles.panelControl}
            aria-label={t("rightbar.split")}
            disabled={block !== undefined}
            data-rb-split={pane.id}
            data-rb-split-blocked={block}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSplit();
            }}
          >
            <SplitIcon />
          </button>
        </span>
        {chrome}
      </div>
      <div className={styles.paneBody}>
        {active === null ? (
          <p className={paneCss.note} data-rb-empty>
            {t("rightbar.emptyPane")}
          </p>
        ) : (
          <TabBody
            key={active.id}
            sessionPath={sessionPath}
            projectId={projectId}
            projectPath={projectPath}
            tab={active}
            onOpenFile={onOpenFile}
          />
        )}
        {drop?.kind === "zone" ? <DropHints zone={drop.zone} /> : null}
      </div>
    </section>
  );
}

/** One chip: its title, its ✕, its drag, and its context menu. */
function Chip({
  sessionPath,
  tab,
  title,
  selected,
  dragging,
  onPress,
  onOpenMenu,
  onClose,
}: {
  sessionPath: string;
  tab: RightbarTab;
  title: string;
  selected: boolean;
  dragging: boolean;
  onPress: (tabId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onOpenMenu: (tabId: string, anchor: HTMLElement, x: number, y: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div
      className={clsx(styles.chip, selected && styles.chipActive, dragging && styles.chipDragging)}
      data-rb-tab={tab.id}
      // Focus lands on click, not on press: a state change between pointerdown
      // and the first pointermove rebuilds this subtree, and Chromium cancels
      // the pointer when the pressed element is replaced — which would abandon
      // the drag. A drag that ends elsewhere fires no click, and the operation
      // its release records carries the focus itself.
      onPointerDown={(event) => {
        // A secondary press is the menu, never a drag.
        if (event.button === 2) return;
        onPress(tab.id, event);
      }}
      onClick={(event) => {
        event.stopPropagation();
        rightbarActions.selectTab(sessionPath, tab.id);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        const anchor = event.currentTarget;
        // A keyboard-invoked context menu (Shift+F10, the context-menu key)
        // arrives with zeroed coordinates, so it hangs off the chip's own
        // bottom-left corner instead of the window's.
        const keyboard = event.clientX === 0 && event.clientY === 0;
        const rect = anchor.getBoundingClientRect();
        onOpenMenu(
          tab.id,
          anchor,
          keyboard ? rect.left : event.clientX,
          keyboard ? rect.bottom : event.clientY,
        );
      }}
    >
      <button type="button" className={styles.chipBody} title={title}>
        <TabIcon kind={tab.kind} />
        <span className={styles.chipTitle}>{title}</span>
      </button>
      <button
        type="button"
        className={styles.chipClose}
        aria-label={t("rightbar.closeTab", { title })}
        // A nested control stops its own press: otherwise the press would start
        // a drag, capture the pointer, and this click would never land.
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <CloseIcon width={11} height={11} />
      </button>
    </div>
  );
}

/** The strip's "+": the tab kinds a user can add directly, into this pane. */
function AddTabMenu({ sessionPath, paneId }: { sessionPath: string; paneId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const support = useStore(terminalStore).support;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Asked when the menu opens rather than when the panel does: a sidebar opened
  // to read a file has no business asking the host about shells.
  useEffect(() => {
    if (!open) return;
    if (terminalStore.get().support === null) void terminalActions.probe();
  }, [open]);

  // null means the answer has not landed yet. The entry stays live in that
  // case — the tab itself knows how to report a host that cannot open a shell.
  const terminalOff = support !== null && !support.available;

  const pick = (kind: "files" | "changes" | "browser" | "terminal"): void => {
    setOpen(false);
    if (kind === "files") rightbarActions.openFilesTab(sessionPath, paneId);
    else if (kind === "changes") rightbarActions.openChangesTab(sessionPath, paneId);
    else if (kind === "terminal") rightbarActions.openTerminalTab(sessionPath, paneId);
    else rightbarActions.openBrowserTab(sessionPath, "", paneId);
  };

  return (
    <div className={styles.addWrap} ref={rootRef}>
      <button
        type="button"
        className={styles.addButton}
        title={t("rightbar.newTab")}
        aria-label={t("rightbar.newTab")}
        aria-expanded={open}
        data-rb-add-tab={paneId}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <PlusIcon width={13} height={13} />
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            title={shortcutTitle(t, t("tab.files"), "rightbar.files")}
            onClick={() => {
              pick("files");
            }}
          >
            <Glyph name="checklist" size={13} />
            {t("tab.files")}
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              pick("changes");
            }}
          >
            <DiffIcon width={13} height={13} />
            {t("tab.changes")}
          </button>
          {/* Offered but disabled rather than hidden: a machine without a
              prebuilt node-pty still wants to know the tab exists and why it
              is not there, and the reason is one hover away. */}
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            disabled={terminalOff}
            title={
              terminalOff
                ? support?.reason
                : shortcutTitle(t, t("tab.terminal"), "rightbar.terminal")
            }
            onClick={() => {
              pick("terminal");
            }}
          >
            <Glyph name="terminal" size={13} />
            {t("tab.terminal")}
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            title={shortcutTitle(t, t("tab.browser"), "rightbar.browser")}
            onClick={() => {
              pick("browser");
            }}
          >
            <Glyph name="browse" size={13} />
            {t("tab.browser")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

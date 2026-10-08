import { Fragment, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { appStore, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import {
  containsPoint,
  dividerSizes,
  floatRectAt,
  FLOAT_DEFAULT_SIZE,
  MIN_PANE_FRACTION,
  passedThreshold,
  sameSizes,
  clampSizes,
} from "./dock-geometry.ts";
import { hitTest } from "./dock-hit.ts";
import type { DropTarget } from "./dock-hit.ts";
import { FullscreenIcon, PanelRightIcon, RestoreIcon } from "./rightbar-icons.tsx";
import { PaneView } from "./PaneView.tsx";
import { FloatLayer } from "./FloatLayer.tsx";
import {
  WIDTH_DEFAULT,
  canRenameTab,
  canSplitDock,
  rightbarActions,
  rightbarStore,
  tabTitle,
  type RightbarSurface,
  type RightbarTab,
} from "./rightbar-state.ts";
import { TabMenu } from "./TabMenu.tsx";
import { closeTabs } from "./close-tabs.ts";
import { shortcutTitle } from "./shortcuts.ts";
import { useGesture } from "./pointer.ts";
import styles from "./Rightbar.module.css";

/** The chip whose context menu is open, and where the press landed. */
interface MenuState {
  readonly tabId: string;
  readonly anchor: HTMLElement;
  readonly x: number;
  readonly y: number;
}

/**
 * Rename a tab from its context menu.
 *
 * `window.prompt` rather than an editor drawn into the chip: the sidebar renames
 * sessions and workspaces the same way, and the platform supplies the keyboard,
 * the screen reader and the IME for free. One rename gesture in the app beats
 * three that each behave slightly differently.
 *
 * An empty answer is treated as a cancellation rather than as a name: storing it
 * would make `tabTitle` fall back to the kind's own wording, so the tab would
 * read as reset instead of renamed — and there is no way to tell that apart from
 * a rename that worked badly.
 */
function renameTab(key: string, tab: RightbarTab, label: string, prompt: string): void {
  const next = window.prompt(prompt, label);
  if (next === null) return;
  const name = next.trim();
  if (name.length === 0) return;
  rightbarActions.setTabTitle(key, tab.id, name);
}

/** The chip being dragged, and where its release would land right now. */
interface ChipDrag {
  readonly tabId: string;
  readonly target: DropTarget | null;
}

/**
 * The right sidebar.
 *
 * One panel, mounted beside the conversation for the selected session: a row of
 * one or two panes, each with a tab strip on top and its showing tab's body
 * below. It is deliberately *not* a window manager — the panes, the tabs, their
 * order, their addresses, the divider and the panel's width are the whole model,
 * and a session's layout survives a reload through localStorage (see
 * `rightbar-state.ts`).
 *
 * The panel is only half of what this draws. A tab dragged clear of the row
 * becomes a **floating panel**, and a floating panel outlives the column that
 * spawned it: collapsing the sidebar takes the docked row away, not the
 * overlays, which is dsh's rule too (`aria-hidden` there is false whenever any
 * pane floats). That is why this no longer returns nothing when the surface is
 * closed — only the `<aside>` is conditional.
 *
 * Nothing renders without a session: the panel is addressed by session path, and
 * the hero (which has none) is the one screen where there is nothing for a file
 * tree or a preview to belong to.
 */
export function Rightbar() {
  const state = useStore(rightbarStore);
  const app = useStore(appStore);
  const sessionPath = app.selectedSessionPath ?? "";
  const project = app.projects.find((item) => item.id === app.selectedProjectId) ?? null;
  const surface = state.surfaces[sessionPath];

  // Load this session's saved layout the first time the panel appears for it.
  useEffect(() => {
    rightbarActions.ensureSurface(sessionPath);
  }, [sessionPath]);

  if (sessionPath.length === 0 || project === null) return null;
  if (surface === undefined) return null;

  return (
    <>
      {surface.open ? (
        // Keyed by session so the open menu and any half-finished gesture do not
        // survive a switch: they belong to a layout rather than to the panel.
        <Panel
          key={sessionPath}
          sessionPath={sessionPath}
          projectId={project.id}
          projectPath={project.path}
          surface={surface}
        />
      ) : null}
      <FloatLayer
        sessionPath={sessionPath}
        projectId={project.id}
        projectPath={project.path}
        surface={surface}
        onOpenFile={(path) => {
          rightbarActions.openPreviewTab(sessionPath, path);
        }}
      />
    </>
  );
}

/** The docked column: its panes, the divider between them, and the drags over them. */
function Panel({
  sessionPath,
  projectId,
  projectPath,
  surface,
}: {
  sessionPath: string;
  projectId: string;
  projectPath: string;
  surface: RightbarSurface;
}) {
  const t = useT();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<ChipDrag | null>(null);
  // The divider drag's live fractions. The layout follows the pointer and only
  // the release is written, which is what keeps a persisted layout at one write
  // per gesture instead of one per frame.
  const [sizes, setSizes] = useState<number[] | null>(null);
  const begin = useGesture(() => {
    setDrag(null);
    setSizes(null);
  });

  const fullscreen = surface.mode === "fullscreen";
  const splitAllowed = canSplitDock(surface);
  const menuTab = menu === null ? null : (surface.tabs[menu.tabId] ?? null);
  const shares = surface.panes.length === 2 ? (sizes ?? surface.sizes ?? [0.5, 0.5]) : [1];

  /**
   * Begin dragging a chip.
   *
   * A press is not yet a drag: nothing is previewed until the pointer has
   * travelled the threshold, so a click that moves a pixel is still a click. A
   * release clear of the row floats the tab; one inside the row but over no
   * pane is not a move at all.
   */
  const onTabPressed = (tabId: string, event: ReactPointerEvent<HTMLElement>): void => {
    const root = rowRef.current;
    if (root === null) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    begin(event.currentTarget, event.pointerId, {
      // A chip is not a handle: it says what it is with its shape, and there is
      // no cursor dsh shows for carrying one. `default` is the neutral thing to
      // show over whatever the pointer is passing across.
      cursor: "default",
      move: (moved) => {
        if (!dragging) {
          if (!passedThreshold(startX, startY, moved.clientX, moved.clientY)) return;
          dragging = true;
        }
        setDrag({ tabId, target: hitTest(root, moved.clientX, moved.clientY, splitAllowed) });
      },
      up: (released) => {
        if (!dragging) return;
        const target = hitTest(root, released.clientX, released.clientY, splitAllowed);
        if (target === null) {
          if (containsPoint(root.getBoundingClientRect(), released.clientX, released.clientY)) return;
          rightbarActions.floatTab(
            sessionPath,
            tabId,
            floatRectAt(released.clientX, released.clientY, FLOAT_DEFAULT_SIZE),
          );
          return;
        }
        if (target.kind === "strip") {
          rightbarActions.placeTab(sessionPath, tabId, target.paneId, target.index);
        } else {
          rightbarActions.dropTab(sessionPath, tabId, target.paneId, target.zone);
        }
      },
    });
  };

  /** Begin dragging the seam between two panes. */
  const onDividerPressed = (event: ReactPointerEvent<HTMLElement>): void => {
    const container = event.currentTarget.parentElement;
    if (container === null) return;
    const recorded = surface.sizes ?? [0.5, 0.5];
    const box = container.getBoundingClientRect();
    const start = { origin: event.clientX, extent: box.width, sizes: recorded };
    const reached = (x: number): number[] =>
      clampSizes(dividerSizes(start.sizes, 0, start.extent > 0 ? (x - start.origin) / start.extent : 0), MIN_PANE_FRACTION);
    // A release that left the fractions where they were — a click on the seam,
    // or a drag pushed further into the clamp — is not a resize and writes
    // nothing.
    begin(event.currentTarget, event.pointerId, {
      // dsh's own value for the seam it draws the same way.
      cursor: "col-resize",
      move: (moved) => {
        setSizes(reached(moved.clientX));
      },
      up: (released) => {
        const next = reached(released.clientX);
        if (sameSizes(next, start.sizes)) return;
        rightbarActions.resizePanes(sessionPath, next);
      },
    });
  };

  const chrome = (
    <>
      <button
        type="button"
        className={styles.panelControl}
        title={shortcutTitle(
          t,
          fullscreen ? t("rightbar.exitFullscreen") : t("rightbar.fullscreen"),
          "rightbar.fullscreen",
        )}
        aria-label={fullscreen ? t("rightbar.exitFullscreen") : t("rightbar.fullscreen")}
        data-rb-mode={fullscreen ? "push" : "fullscreen"}
        onClick={(event) => {
          event.stopPropagation();
          rightbarActions.setMode(sessionPath, fullscreen ? "push" : "fullscreen");
        }}
      >
        {fullscreen ? <RestoreIcon width={14} height={14} /> : <FullscreenIcon width={14} height={14} />}
      </button>
      <button
        type="button"
        className={styles.panelControl}
        title={shortcutTitle(t, t("rightbar.collapse"), "rightbar.toggle")}
        aria-label={t("rightbar.collapse")}
        data-rb-collapse
        onClick={(event) => {
          event.stopPropagation();
          rightbarActions.close(sessionPath);
        }}
      >
        <PanelRightIcon width={14} height={14} />
      </button>
    </>
  );

  return (
    <aside
      className={clsx(styles.panel, fullscreen && styles.fullscreen)}
      style={fullscreen ? undefined : { width: `${String(surface.width)}px` }}
      aria-label={t("rightbar.title")}
      data-rb-panel
    >
      {fullscreen ? null : <ResizeHandle sessionPath={sessionPath} width={surface.width} />}
      {/* The row scrolls in two dimensions never: a pane's own body is the only
          scroller, and a strip's chips scroll on their own. */}
      <div className={styles.row} ref={rowRef} data-rb-row>
        {surface.panes.map((pane, index) => (
          <Fragment key={pane.id}>
            {/* The seam comes before every pane but the first, which is what
                puts it *between* two panes: after the map it would be a last
                child of the row, drawing its hairline and its 8px target at the
                row's trailing edge, where there is no seam to grab. dsh nests
                its cells the same way, for the same reason. */}
            {index > 0 ? (
              <div
                className={styles.rowDivider}
                data-rb-divider
                role="separator"
                aria-orientation="vertical"
                aria-label={t("rightbar.resizePanes")}
                onPointerDown={onDividerPressed}
              />
            ) : null}
            <PaneView
              sessionPath={sessionPath}
              projectId={projectId}
              projectPath={projectPath}
              surface={surface}
              pane={pane}
              grow={shares[index] ?? 1}
              // The accent rule under the strip is the focus, and focus only means
              // something once there are two panes to choose between: a lone pane
              // is the focus by definition, and a marker on it is noise. This is
              // the same fact `data-rb-pane-active` carries, drawn.
              marked={surface.panes.length > 1 && surface.activePaneId === pane.id}
              chrome={pane.id === surface.panes.at(-1)?.id ? chrome : null}
              draggingTabId={drag?.tabId ?? null}
              dropTarget={drag?.target ?? null}
              onTabPressed={onTabPressed}
              onOpenMenu={(tabId, anchor, x, y) => {
                setMenu({ tabId, anchor, x, y });
              }}
              onSplit={() => {
                // The split control is the pane's own, so it is the one that says
                // which pane — never the focus, which a click on the button would
                // have just moved here anyway.
                rightbarActions.focusPane(sessionPath, pane.id);
                rightbarActions.splitPane(sessionPath, pane.id);
              }}
              onFocusPane={() => {
                rightbarActions.focusPane(sessionPath, pane.id);
              }}
              onOpenFile={(path) => {
                rightbarActions.openPreviewTab(sessionPath, path, pane.id);
              }}
            />
          </Fragment>
        ))}
      </div>

      {menu === null || menuTab === null ? null : (
        <TabMenu
          anchor={menu.anchor}
          position={{ x: menu.x, y: menu.y }}
          tabTitle={tabTitle(menuTab, t)}
          canRename={canRenameTab(menuTab.kind)}
          hasSiblings={Object.keys(surface.tabs).length > 1}
          onDismiss={() => {
            setMenu(null);
          }}
          onPick={(action) => {
            if (action === "close") closeTabs(sessionPath, [menuTab.id]);
            else if (action === "rename") {
              renameTab(sessionPath, menuTab, tabTitle(menuTab, t), t("rightbar.renamePrompt"));
            } else if (action === "closeOthers") {
              closeTabs(
                sessionPath,
                Object.keys(surface.tabs).filter((id) => id !== menuTab.id),
              );
            } else closeTabs(sessionPath, Object.keys(surface.tabs));
          }}
        />
      )}
    </aside>
  );
}

/**
 * The grab strip on the panel's left edge.
 *
 * The width follows the pointer during the drag and is written to storage only
 * on release: a persisted layout is worth one write per gesture, not one per
 * frame. The press runs through the same gesture the seams inside the column
 * use, so it is captured and covered the same way — its early `onPointerMove`
 * handlers only ever worked while the pointer stayed in this document, and the
 * panel's own body is not the only thing to the left of it.
 */
function ResizeHandle({ sessionPath, width }: { sessionPath: string; width: number }) {
  const t = useT();
  const begin = useGesture(() => {
    // Nothing to clear: this gesture previews no state of its own, it writes
    // the width as it goes.
  });

  return (
    <div
      className={styles.resizeHandle}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("rightbar.resize")}
      onPointerDown={(event) => {
        event.preventDefault();
        const start = { x: event.clientX, width };
        begin(event.currentTarget, event.pointerId, {
          cursor: "col-resize",
          move: (moved) => {
            // Dragging left widens the panel, which is the edge the pointer holds.
            rightbarActions.setWidth(sessionPath, start.width + (start.x - moved.clientX), false);
          },
          up: () => {
            rightbarActions.setWidth(
              sessionPath,
              rightbarStore.get().surfaces[sessionPath]?.width ?? WIDTH_DEFAULT,
            );
          },
        });
      }}
    />
  );
}

import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { CloseIcon } from "../../components/icons.tsx";
import { useT } from "../../lib/app-state.ts";
import { FLOAT_MIN_SIZE, movedRect, resizedRect, type FloatRect } from "./dock-geometry.ts";
import { TabIcon } from "./PaneView.tsx";
import { PanelRightIcon } from "./rightbar-icons.tsx";
import {
  paneTabs,
  rightbarActions,
  tabTitle,
  type RightbarPane,
  type RightbarSurface,
} from "./rightbar-state.ts";
import { TabBody } from "./TabBody.tsx";
import { closeTabs } from "./close-tabs.ts";
import { useGesture } from "./pointer.ts";
import styles from "./Rightbar.module.css";

/** A floating-panel gesture: what it moves and where it started. */
interface FloatDrag {
  readonly mode: "move" | "resize";
  readonly originX: number;
  readonly originY: number;
  readonly rect: FloatRect;
}

/** The rectangle a gesture has reached. */
function draggedRect(drag: FloatDrag, x: number, y: number): FloatRect {
  const dx = x - drag.originX;
  const dy = y - drag.originY;
  return drag.mode === "move"
    ? movedRect(drag.rect, dx, dy)
    : resizedRect(drag.rect, dx, dy, FLOAT_MIN_SIZE);
}

/** Whether two rectangles agree in every coordinate. */
function sameRect(a: FloatRect, b: FloatRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * The floating panels: one overlay per floating pane, bottom to top.
 *
 * A floating panel is not a second kind of thing — it is a pane whose tab
 * cannot be docked, and it holds exactly one because a viewport overlay you
 * cannot switch tabs in has no strip to switch with. So its header is the tab's
 * own chip (a label, never a control: there is nothing to select against and
 * the ✕ beside it is the way out), it draws the same body through the same
 * `TabBody`, and everything about the tab — its shell, its scroll, its address
 * — survives moving it.
 *
 * Rendered through a portal into `document.body`, like the tab menu and for the
 * same reason: a panel is positioned in viewport coordinates, and any ancestor
 * that clipped or established a containing block for fixed-position descendants
 * (an `overflow: hidden` column, a transform on the way in or out of
 * fullscreen) would move it somewhere nobody can see.
 */
export function FloatLayer({
  sessionPath,
  projectId,
  projectPath,
  surface,
  onOpenFile,
}: {
  sessionPath: string;
  projectId: string;
  projectPath: string;
  surface: RightbarSurface;
  onOpenFile: (path: string) => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<{ paneId: string; rect: FloatRect } | null>(null);
  const begin = useGesture(() => {
    setPreview(null);
  });

  /**
   * Focus and raise a panel from a press or click on it, unless it is already
   * focused and on top — raising what is already raised is one store write and
   * one re-render for nothing.
   */
  const raise = (paneId: string): void => {
    if (surface.activePaneId === paneId && surface.floats.at(-1)?.id === paneId) return;
    rightbarActions.focusPane(sessionPath, paneId);
  };

  /**
   * Start a move or a resize from the panel's header or its corner.
   *
   * The press stops here: the panel's own press-to-focus would record a focus
   * entry before the drag's, and the release below decides which of the two the
   * gesture was — a release that moved nothing is a click, and a click raises.
   */
  const drag = (mode: "move" | "resize", paneId: string, event: ReactPointerEvent<HTMLElement>): void => {
    event.stopPropagation();
    const panel = surface.floats.find((entry) => entry.id === paneId);
    if (panel?.rect === undefined) return;
    const start: FloatDrag = {
      mode,
      originX: event.clientX,
      originY: event.clientY,
      rect: panel.rect,
    };
    begin(event.currentTarget, event.pointerId, {
      // The grip's own cursor, so a panel being carried looks the way it looks
      // before the press: `move` on the header, `nwse-resize` on the corner,
      // both as dsh draws them.
      cursor: mode === "move" ? "move" : "nwse-resize",
      move: (moved) => {
        setPreview({ paneId, rect: draggedRect(start, moved.clientX, moved.clientY) });
      },
      up: (released) => {
        const rect = draggedRect(start, released.clientX, released.clientY);
        if (sameRect(rect, start.rect)) raise(paneId);
        else if (mode === "move") rightbarActions.moveFloat(sessionPath, paneId, rect.x, rect.y);
        else rightbarActions.resizeFloat(sessionPath, paneId, rect);
      },
    });
  };

  if (typeof document === "undefined" || surface.floats.length === 0) return null;

  return createPortal(
    <>
      {surface.floats.map((panel) => {
        const tab = paneTabs(surface, panel)[0];
        if (tab === undefined || panel.rect === undefined) return null;
        const lifted = preview?.paneId === panel.id ? preview.rect : null;
        const live = lifted ?? panel.rect;
        return (
          <section
            key={panel.id}
            className={clsx(styles.float, lifted !== null && styles.floatLifted)}
            data-rb-float={panel.id}
            data-rb-float-active={surface.activePaneId === panel.id ? "" : undefined}
            style={{
              left: `${String(live.x)}px`,
              top: `${String(live.y)}px`,
              width: `${String(live.width)}px`,
              height: `${String(live.height)}px`,
            }}
            onPointerDown={() => {
              raise(panel.id);
            }}
          >
            <FloatHeader
              panel={panel}
              title={tabTitle(tab, t)}
              kind={tab.kind}
              onDrag={(event) => {
                drag("move", panel.id, event);
              }}
              onDock={() => {
                rightbarActions.unfloatPane(sessionPath, panel.id);
              }}
              onClose={() => {
                closeTabs(sessionPath, [tab.id]);
              }}
            />
            <div className={styles.floatBody}>
              <TabBody
                key={tab.id}
                sessionPath={sessionPath}
                projectId={projectId}
                projectPath={projectPath}
                tab={tab}
                onOpenFile={onOpenFile}
              />
            </div>
            <div
              className={styles.floatResize}
              data-rb-float-resize={panel.id}
              // A tooltip, not a label: the grip is a 20px corner with no role
              // of its own — dsh draws the same div bare — and the title is the
              // only hint a pointer can pick up before committing to a drag.
              title={t("rightbar.floatResize")}
              onPointerDown={(event) => {
                drag("resize", panel.id, event);
              }}
            />
          </section>
        );
      })}
    </>,
    document.body,
  );
}

/**
 * A panel's header, which is the whole of it that is a control: the title, the
 * way back into the column, and the way out.
 *
 * The title is text, not a chip: dsh draws the same row from its strip's
 * classes and says so — a floating pane holds one tab, so there is nothing to
 * select against and nothing for a close on the chip to mean.
 */
function FloatHeader({
  panel,
  title,
  kind,
  onDrag,
  onDock,
  onClose,
}: {
  panel: RightbarPane;
  title: string;
  kind: Parameters<typeof TabIcon>[0]["kind"];
  onDrag: (event: ReactPointerEvent<HTMLElement>) => void;
  onDock: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <header className={clsx(styles.strip, styles.floatHeader)} data-rb-float-grip={panel.id} onPointerDown={onDrag}>
      <span className={styles.floatTitle}>
        <TabIcon kind={kind} />
        <span className={styles.chipTitle}>{title}</span>
      </span>
      <span className={styles.stripSpacer} />
      <button
        type="button"
        className={styles.panelControl}
        title={t("rightbar.dockFloat")}
        aria-label={t("rightbar.dockFloat")}
        data-rb-float-dock={panel.id}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onDock();
        }}
      >
        <PanelRightIcon width={14} height={14} />
      </button>
      <button
        type="button"
        className={styles.panelControl}
        title={t("rightbar.closeTab", { title })}
        aria-label={t("rightbar.closeTab", { title })}
        data-rb-float-close={panel.id}
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
    </header>
  );
}

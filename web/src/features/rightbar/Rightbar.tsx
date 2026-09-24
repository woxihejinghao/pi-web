import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { CloseIcon, PlusIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { appStore, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { BrowserTab } from "./BrowserTab.tsx";
import { ChangesTab } from "./ChangesTab.tsx";
import { FilesTab } from "./FilesTab.tsx";
import { PreviewTab } from "./PreviewTab.tsx";
import {
  DiffIcon,
  FileIcon,
  FullscreenIcon,
  PanelRightIcon,
  RestoreIcon,
} from "./rightbar-icons.tsx";
import {
  WIDTH_DEFAULT,
  rightbarActions,
  rightbarStore,
  tabTitle,
  type RightbarTab,
  type RightbarTabKind,
} from "./rightbar-state.ts";
import styles from "./Rightbar.module.css";

/** The glyph on a tab chip, by what that tab is showing. */
function TabIcon({ kind }: { kind: RightbarTabKind }) {
  if (kind === "files") return <Glyph name="checklist" size={13} />;
  if (kind === "browser") return <Glyph name="browse" size={13} />;
  if (kind === "changes") return <DiffIcon width={13} height={13} />;
  return <FileIcon width={13} height={13} />;
}

/**
 * The right sidebar.
 *
 * One panel, mounted beside the conversation for the selected session: a tab
 * strip on top and the active tab's body below. It is deliberately *not* a
 * window manager — the tabs, their order, their addresses and the panel's width
 * are the whole model, and a session's layout survives a reload through
 * localStorage (see `rightbar-state.ts`).
 *
 * Nothing renders without a session: the panel is addressed by session path, and
 * the hero (which has none) is the one screen where there is nothing for a file
 * tree or a preview to belong to.
 */
export function Rightbar() {
  const t = useT();
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
  if (surface === undefined || !surface.open) return null;

  const active =
    surface.tabs.find((tab) => tab.id === surface.activeTabId) ?? surface.tabs[0] ?? null;

  return (
    <aside
      className={clsx(styles.panel, surface.mode === "fullscreen" && styles.fullscreen)}
      style={surface.mode === "fullscreen" ? undefined : { width: `${String(surface.width)}px` }}
      aria-label={t("rightbar.title")}
    >
      {surface.mode === "push" ? (
        <ResizeHandle sessionPath={sessionPath} width={surface.width} />
      ) : null}
      <div className={styles.strip}>
        {/* The chips scroll on their own; the strip itself must not clip, or the
            "+" menu would be cut off at the strip's edge. */}
        <div className={styles.chips}>
          {surface.tabs.map((tab) => (
            <div
              key={tab.id}
              className={clsx(styles.chip, tab.id === active?.id && styles.chipActive)}
            >
              <button
                type="button"
                className={styles.chipBody}
                title={tabTitle(tab, t)}
                onClick={() => rightbarActions.selectTab(sessionPath, tab.id)}
              >
                <TabIcon kind={tab.kind} />
                <span className={styles.chipTitle}>{tabTitle(tab, t)}</span>
              </button>
              <button
                type="button"
                className={styles.chipClose}
                aria-label={t("rightbar.closeTab", { title: tabTitle(tab, t) })}
                onClick={() => rightbarActions.closeTab(sessionPath, tab.id)}
              >
                <CloseIcon width={11} height={11} />
              </button>
            </div>
          ))}
        </div>
        <AddTabMenu
          onPick={(kind) => {
            if (kind === "files") rightbarActions.openFilesTab(sessionPath);
            else if (kind === "changes") rightbarActions.openChangesTab(sessionPath);
            else rightbarActions.openBrowserTab(sessionPath, "");
          }}
        />
        <span className={styles.stripSpacer} />
        <button
          type="button"
          className={styles.panelControl}
          title={surface.mode === "fullscreen" ? t("rightbar.exitFullscreen") : t("rightbar.fullscreen")}
          aria-label={surface.mode === "fullscreen" ? t("rightbar.exitFullscreen") : t("rightbar.fullscreen")}
          onClick={() =>
            rightbarActions.setMode(sessionPath, surface.mode === "fullscreen" ? "push" : "fullscreen")
          }
        >
          {surface.mode === "fullscreen" ? (
            <RestoreIcon width={14} height={14} />
          ) : (
            <FullscreenIcon width={14} height={14} />
          )}
        </button>
        <button
          type="button"
          className={styles.panelControl}
          title={t("rightbar.collapse")}
          aria-label={t("rightbar.collapse")}
          onClick={() => rightbarActions.close(sessionPath)}
        >
          <PanelRightIcon width={14} height={14} />
        </button>
      </div>

      <div className={styles.body}>
        {active === null ? null : active.kind === "files" ? (
          <FilesTab
            key={project.id}
            projectId={project.id}
            rootLabel={project.path}
            onOpenFile={(path) => rightbarActions.openPreviewTab(sessionPath, path)}
          />
        ) : active.kind === "preview" ? (
          // Keyed by tab id so two tabs previewing the same file keep their own
          // scroll position and load state.
          <PreviewTab key={active.id} projectId={project.id} tab={active} />
        ) : active.kind === "changes" ? (
          <ChangesTab
            key={active.id}
            projectId={project.id}
            onOpenFile={(path) => rightbarActions.openPreviewTab(sessionPath, path)}
          />
        ) : (
          <BrowserTab key={active.id} sessionPath={sessionPath} tab={active} />
        )}
      </div>
    </aside>
  );
}

/**
 * The grab strip on the panel's left edge.
 *
 * The width follows the pointer during the drag and is written to storage only
 * on release: a persisted layout is worth one write per gesture, not one per
 * frame. Pointer capture keeps the drag alive when the pointer leaves the 5px
 * handle, which it does immediately.
 */
function ResizeHandle({ sessionPath, width }: { sessionPath: string; width: number }) {
  const t = useT();
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  return (
    <div
      className={styles.resizeHandle}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("rightbar.resize")}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { startX: event.clientX, startWidth: width };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        // Dragging left widens the panel, which is the edge the pointer holds.
        rightbarActions.setWidth(sessionPath, drag.startWidth + (drag.startX - event.clientX), false);
      }}
      onPointerUp={(event) => {
        if (dragRef.current === null) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        rightbarActions.setWidth(
          sessionPath,
          rightbarStore.get().surfaces[sessionPath]?.width ?? WIDTH_DEFAULT,
        );
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    />
  );
}

/** The strip's "+": the tab kinds a user can add directly. */
function AddTabMenu({ onPick }: { onPick: (kind: "files" | "changes" | "browser") => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className={styles.addWrap} ref={rootRef}>
      <button
        type="button"
        className={styles.addButton}
        title={t("rightbar.newTab")}
        aria-label={t("rightbar.newTab")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PlusIcon width={13} height={13} />
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onPick("files");
            }}
          >
            <Glyph name="checklist" size={13} />{t("tab.files")}</button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onPick("changes");
            }}
          >
            <DiffIcon width={13} height={13} />{t("tab.changes")}</button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onPick("browser");
            }}
          >
            <Glyph name="browse" size={13} />{t("tab.browser")}</button>
        </div>
      ) : null}
    </div>
  );
}

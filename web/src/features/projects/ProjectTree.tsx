import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  EyeOffIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "../../components/icons.tsx";
import { actions, appStore, isDraftSession, useT } from "../../lib/app-state.ts";
import { Glyph } from "../../components/dsh-icons.tsx";
import { formatRelativeTime } from "../../lib/format.ts";
import type { ProjectNode } from "../../lib/project-tree.ts";
import { useStore } from "../../lib/store.ts";
import styles from "../../layout/Sidebar.module.css";

/** dsh shows five sessions per workspace before folding the rest. */
const PAGE_SIZE = 5;

/** Where a workspace's overflow menu is anchored, in viewport coordinates. */
interface MenuAnchor {
  top: number;
  right: number;
}

/**
 * The workspace row's overflow menu: rename and remove, folded behind the `...`
 * that dsh puts there.
 *
 * Rendered into `document.body` because the sidebar's list is a scroll
 * container — an absolutely positioned menu would be clipped by it. `fixed`
 * coordinates come from the trigger and the menu is right-aligned to it, which
 * is the direction dsh opens it in.
 */
function ProjectRowMenu({
  anchor,
  triggerRef,
  onClose,
  onRename,
  onRemove,
}: {
  anchor: MenuAnchor;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The trigger is part of the menu for dismissal purposes: clicking `...`
    // again has to toggle, not close-then-reopen from the pointerdown below.
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
    // Scrolling moves the trigger but not the menu, so dismiss rather than
    // leave the menu pinned to nothing.
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
      className={styles.projectMenu}
      role="menu"
      aria-label={t("project.actions")}
      style={{ top: anchor.top, right: anchor.right }}
    >
      <button
        type="button"
        className={styles.projectMenuItem}
        role="menuitem"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <PencilIcon width={14} height={14} />{t("project.rename")}</button>
      <button
        type="button"
        className={clsx(styles.projectMenuItem, styles.projectMenuItemDanger)}
        role="menuitem"
        onClick={() => {
          onClose();
          onRemove();
        }}
      >
        <TrashIcon width={14} height={14} />{t("project.delete")}</button>
    </div>,
    document.body,
  );
}

interface RowProps {
  indent: number;
}

function SessionRow({
  sessionPath,
  title,
  time,
  active,
  external,
  indent,
  canDelete = true,
}: RowProps & {
  sessionPath: string;
  title: string;
  time: string;
  active: boolean;
  external: boolean;
  /** False for a row that has no file on disk yet, so there is nothing to remove. */
  canDelete?: boolean;
}) {
  const t = useT();
  const rename = async (): Promise<void> => {
    const next = window.prompt(t("session.renamePrompt"), title);
    if (next === null) return;
    await actions.renameSession(sessionPath, next);
  };

  const hide = async (): Promise<void> => {
    await actions.setSessionHidden(sessionPath, true);
    if (appStore.get().selectedSessionPath === sessionPath) actions.selectSession(null);
  };

  const remove = async (): Promise<void> => {
    const confirmed = window.confirm(t("session.deleteConfirm", { title }));
    if (!confirmed) return;
    await actions.deleteSession(sessionPath);
  };

  return (
    <div
      className={clsx(styles.sessionRow, active && styles.sessionRowActive)}
      style={{ marginLeft: indent }}
      title={sessionPath}
    >
      <button
        type="button"
        className={styles.sessionTitle}
        onClick={() => actions.selectSession(sessionPath)}
      >
        {title}
      </button>
      {external ? <span className={styles.externalDot} title={t("session.external")} /> : null}
      <span className={styles.sessionTime}>{time}</span>
      <div className={styles.rowActions}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t("session.renameLabel", { title })}
          title={t("session.rename")}
          onClick={() => void rename()}
        >
          <PencilIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t("session.hideLabel", { title })}
          title={t("session.hide")}
          onClick={() => void hide()}
        >
          <EyeOffIcon />
        </button>
        {canDelete ? (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("session.deleteLabel", { title })}
            title={t("session.delete")}
            onClick={() => void remove()}
          >
            <TrashIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** One workspace and the sessions nested underneath it. */
export function ProjectTreeItem({ node }: { node: ProjectNode }) {
  const t = useT();
  const state = useStore(appStore);
  const project = node.project;
  const indent = node.depth * 16;
  const sessionIndent = indent + 26;

  const expanded = Boolean(state.expandedProjects[project.id]);
  const current = project.id === state.selectedProjectId;
  const query = state.sessionQuery.trim().toLowerCase();
  const searching = query.length > 0;

  const all = state.sessions[project.id] ?? [];
  const visible = all.filter((session) => !session.hidden);
  const matched = searching
    ? visible.filter((session) => session.title.toLowerCase().includes(query))
    : visible;

  const limit = searching ? matched.length : (state.revealedSessions[project.id] ?? PAGE_SIZE);
  const shown = matched.slice(0, limit);
  const remaining = matched.length - shown.length;

  // A draft, or a real session whose file has not been written yet, is not in
  // `all` — it still needs a row, pinned to the top like dsh's "新会话".
  //
  // `draftProjectId` is the ownership check: selecting a workspace does not
  // close the conversation you were reading, so a session opened elsewhere
  // also fails `all.some(...)` here. Without it, expanding any workspace while
  // one of its neighbours holds the selection pinned a phantom "新会话" under
  // it until a real session in that workspace was clicked.
  const selected = state.selectedSessionPath;
  const provisional =
    selected !== null &&
    project.id === state.selectedProjectId &&
    state.draftProjectId === project.id &&
    (isDraftSession(selected) || !all.some((session) => session.path === selected));

  if (searching && matched.length === 0 && !project.title.toLowerCase().includes(query)) {
    return null;
  }

  const renameProject = async (): Promise<void> => {
    const next = window.prompt(t("project.renamePrompt"), project.title);
    if (next === null) return;
    await actions.renameProject(project.id, next);
  };

  const removeProject = async (): Promise<void> => {
    const confirmed = window.confirm(
      t("project.deleteConfirm", { title: project.title }),
    );
    if (!confirmed) return;
    await actions.removeProject(project.id);
  };

  const [menuAt, setMenuAt] = useState<MenuAnchor | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    setMenuAt(null);
  }, []);

  /**
   * The selected workspace's mark only reads in the brand color while it is open:
   * a collapsed workspace is not the one the transcript is showing, and tinting
   * it would claim otherwise. The name keeps the ordinary label color.
   */
  const accented = current && expanded;

  /**
   * Open the overflow menu under its own trigger.
   *
   * Viewport coordinates, because the menu is portalled out of the scrolling
   * list; `right` is measured from the viewport edge so the menu grows leftward
   * from the trigger instead of off the sidebar.
   */
  const toggleMenu = (): void => {
    if (menuAt !== null) {
      setMenuAt(null);
      return;
    }
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setMenuAt({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  };

  return (
    <>
      <div
        className={clsx(styles.projectRow, current && styles.projectRowCurrent)}
        style={{ marginLeft: indent }}
        title={project.path}
      >
        <button
          type="button"
          className={styles.projectMain}
          aria-expanded={expanded}
          onClick={() => {
            void actions.selectProject(project.id);
            actions.toggleProjectExpanded(project.id);
          }}
        >
          <span className={clsx(styles.projectGlyph, accented && styles.projectGlyphAccent)}>
            {/* dsh's rule: the marker states whether the workspace is open — a
                closed folder or an open one — and the caret replaces it under
                the pointer. */}
            <span className={styles.projectFolder}>
              <Glyph name={expanded ? "folderOpen" : "folderClose"} size={16} />
            </span>
            <span className={clsx(styles.projectCaret, expanded && styles.projectCaretOpen)}>
              <Glyph name="caretRight" size={14} />
            </span>
          </span>
          <span className={styles.projectTitle}>{project.title}</span>
          {project.exists ? null : <span className={styles.missing}>{t("project.missing")}</span>}
        </button>
        <div className={styles.rowActions}>
          <button
            type="button"
            ref={menuButtonRef}
            className={styles.iconButton}
            aria-label={t("project.moreLabel", { title: project.title })}
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
            title={t("project.more")}
            onClick={toggleMenu}
          >
            <Glyph name="ellipsis" size={16} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("project.newSessionIn", { title: project.title })}
            title={t("project.newSession")}
            onClick={() => {
              setMenuAt(null);
              // Selecting the workspace first is what points the hero (and the
              // pi process it warms) at this project rather than the current one.
              void actions.selectProject(project.id);
              actions.enterNewSession();
            }}
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      {menuAt === null ? null : (
        <ProjectRowMenu
          anchor={menuAt}
          triggerRef={menuButtonRef}
          onClose={closeMenu}
          onRename={() => void renameProject()}
          onRemove={() => void removeProject()}
        />
      )}

      {expanded ? (
        <>
          {provisional && selected ? (
            <SessionRow
              sessionPath={selected}
              title={t("sidebar.newSession")}
              time={isDraftSession(selected) ? t("session.preparing") : t("session.unsaved")}
              active
              external={false}
              indent={sessionIndent}
              canDelete={false}
            />
          ) : null}

          {shown.map((session) => (
            <SessionRow
              key={session.path}
              sessionPath={session.path}
              title={session.title}
              time={formatRelativeTime(session.modified, t)}
              active={session.path === selected}
              external={Boolean(state.externalChanged[session.path])}
              indent={sessionIndent}
            />
          ))}

          {remaining > 0 ? (
            <button
              type="button"
              className={styles.revealMore}
              style={{ marginLeft: sessionIndent }}
              onClick={() => actions.revealMoreSessions(project.id, limit + PAGE_SIZE)}
            >
              {t("session.expandAll", { count: remaining })}
            </button>
          ) : null}

          {!provisional && shown.length === 0 && !searching ? (
            <p className={styles.emptyList} style={{ marginLeft: sessionIndent }}>{t("session.empty")}</p>
          ) : null}
        </>
      ) : null}

      {node.children.map((child) => (
        <ProjectTreeItem key={child.project.id} node={child} />
      ))}
    </>
  );
}

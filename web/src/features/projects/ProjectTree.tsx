import { useCallback, useRef, useState, type RefObject } from "react";
import clsx from "clsx";
import { EyeOffIcon } from "../../components/icons.tsx";
import { actions, appStore, isDraftSession, SESSIONS_PAGE_SIZE, useT } from "../../lib/app-state.ts";
import { Glyph } from "../../components/dsh-icons.tsx";
import { StateDot, type StateDotState } from "../../components/StateDot.tsx";
import type { MessageKey } from "../../lib/i18n/index.ts";
import { formatRelativeTime } from "../../lib/format.ts";
import type { ProjectNode } from "../../lib/project-tree.ts";
import { useStore } from "../../lib/store.ts";
import styles from "../../layout/Sidebar.module.css";
import { sessionRowsOf } from "./session-rows.ts";
import { NO_DRAG, type RowDragHandlers, type SidebarDrag } from "./use-sidebar-drag.ts";
import { SidebarMenu, anchorBelow, type MenuAnchor } from "./SidebarMenu.tsx";

/**
 * The workspace row's overflow menu: rename and remove, folded behind the `...`
 * that dsh puts there.
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

  return (
    <SidebarMenu
      anchor={anchor}
      triggerRef={triggerRef}
      onClose={onClose}
      ariaLabel={t("project.actions")}
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
        <Glyph name="editOutline" size={16} />{t("project.rename")}</button>
      <button
        type="button"
        className={clsx(styles.projectMenuItem, styles.projectMenuItemDanger)}
        role="menuitem"
        onClick={() => {
          onClose();
          onRemove();
        }}
      >
        <Glyph name="trash" size={16} />{t("project.delete")}</button>
    </SidebarMenu>
  );
}

interface RowProps {
  indent: number;
}

/**
 * dsh's session status mark. A pending question outranks live activity, which
 * outranks a finished run the user has not opened — the same order as dsh's
 * `sessionStatuses`. `label` is the wording a screen reader hears; the mark
 * carries it visually.
 */
interface SessionStatus {
  state: StateDotState;
  label: MessageKey;
}

/** The run-state mark one session row shows, from its two inputs. */
export function sessionStatus(
  activity: "ongoing" | "done" | undefined,
  pending: boolean,
): SessionStatus | undefined {
  if (pending) return { state: "warning", label: "session.statusWaitingAnswer" };
  if (activity === "ongoing") return { state: "ongoing", label: "session.statusRunning" };
  if (activity === "done") return { state: "done", label: "session.statusCompleted" };
  return undefined;
}

/**
 * One session row: a status slot, the title, and the actions the pointer
 * reveals. Exported because the one-list grouping draws the same row with no
 * workspace standing over it.
 */
export function SessionRow({
  sessionPath,
  title,
  time,
  active,
  external,
  status,
  indent,
  drag,
  canDelete = true,
}: RowProps & {
  sessionPath: string;
  title: string;
  time: string;
  active: boolean;
  external: boolean;
  /** dsh's status mark; undefined leaves the leading slot empty. */
  status?: SessionStatus;
  /** The row's drag wiring; `draggable` is false for a row with no file yet. */
  drag: RowDragHandlers;
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
      className={clsx(
        styles.sessionRow,
        active && styles.sessionRowActive,
        drag.marker === "before" && styles.dropBefore,
        drag.marker === "after" && styles.dropAfter,
      )}
      style={{ paddingLeft: 8 + indent }}
      title={sessionPath}
      draggable={drag.draggable}
      onDragStart={drag.onDragStart}
      onDragEnd={drag.onDragEnd}
      onDragOver={drag.onDragOver}
      onDrop={drag.onDrop}
    >
      {/*
       * dsh's leading slot is always in the row: a session with no run-state
       * mark still reserves the same 16px cell, so every title in the column
       * starts at the same x whatever the mark is doing. Only the mark inside
       * is conditional.
       */}
      <span className={styles.sessionStatus}>
        {status === undefined ? null : (
          <>
            <StateDot state={status.state} />
            {/* dsh labels the mark for screen readers instead of the pointer. */}
            <span className={styles.visuallyHidden}>{t(status.label)}</span>
          </>
        )}
      </span>
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
          <Glyph name="editOutline" size={16} />
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
            <Glyph name="trash" size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** One workspace and the sessions nested underneath it. */
export function ProjectTreeItem({
  node,
  drag = NO_DRAG,
}: {
  node: ProjectNode;
  /** The tree-wide drag wiring; left out by a standalone render, which then draws static rows. */
  drag?: SidebarDrag;
}) {
  const t = useT();
  const state = useStore(appStore);
  const project = node.project;
  // dsh's geometry, applied the way dsh applies it: 12px per nesting level, and
  // as the row's own leading *padding* rather than a margin — a row that is
  // pushed over by a margin drags its hover and selected fill with it, and the
  // fill is supposed to span the column (see `Rows.module.css` upstream).
  //
  // Session rows take their workspace's indent, not an extra step of their own:
  // upstream gives the workspace header and its sessions one shared
  // `--dsh-workspace-indent`. The workspace row also marks itself as a group
  // opening, which is what gives the 4px rhythm between groups.
  const indent = node.depth * 12;

  const expanded = Boolean(state.expandedProjects[project.id]);
  const current = project.id === state.selectedProjectId;
  const query = state.sessionQuery.trim().toLowerCase();
  const searching = query.length > 0;

  // Which rows this workspace draws, in which order. The search filter, the
  // manual arrangement, the revealed-page cut and the drafts that lead the
  // column all live in `sessionRowsOf`, because the drag handler has to permute
  // exactly the list that is on screen.
  const rows = sessionRowsOf(state, project.id);
  const shown = rows.sessions;
  const unsaved = rows.drafts;
  const remaining = rows.remaining;

  const selected = state.selectedSessionPath;
  /** True when this row's session is the one an extension is blocked on. */
  const pendingFor = (path: string | null): boolean =>
    path !== null && state.pendingUiRequests.some((item) => item.sessionPath === path);

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

  // A workspace with nothing to show under the current query folds away
  // entirely — but **after** every hook. Bailing out above them makes this
  // component call fewer hooks than on its previous render, and React treats
  // that as a crash ("Rendered fewer hooks than expected"), not as a row that
  // disappeared.
  if (searching && rows.sessions.length === 0 && !project.title.toLowerCase().includes(query)) {
    return null;
  }

  /**
   * The selected workspace's mark only reads in the brand color while it is open:
   * a collapsed workspace is not the one the transcript is showing, and tinting
   * it would claim otherwise. The name keeps the ordinary label color.
   */
  const accented = current && expanded;

  /** Open the overflow menu under its own trigger, or fold it back up. */
  const toggleMenu = (): void => {
    if (menuAt !== null) {
      setMenuAt(null);
      return;
    }
    const anchor = anchorBelow(menuButtonRef.current);
    if (anchor !== null) setMenuAt(anchor);
  };

  const projectDrag = drag.projectRow(project.id);

  return (
    <>
      <div
        className={clsx(
          styles.projectRow,
          current && styles.projectRowCurrent,
          menuAt !== null && styles.menuOpen,
          projectDrag.marker === "before" && styles.dropBefore,
          projectDrag.marker === "after" && styles.dropAfter,
        )}
        data-workspace-row=""
        style={{ paddingLeft: 8 + indent }}
        title={project.path}
        draggable={projectDrag.draggable}
        onDragStart={projectDrag.onDragStart}
        onDragEnd={projectDrag.onDragEnd}
        onDragOver={projectDrag.onDragOver}
        onDrop={projectDrag.onDrop}
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
            <Glyph name="newChatOutline" size={16} />
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
          {unsaved.map((path) => (
            <SessionRow
              key={path}
              sessionPath={path}
              title={t("sidebar.newSession")}
              time={isDraftSession(path) ? t("session.preparing") : t("session.unsaved")}
              active={path === selected}
              external={false}
              status={sessionStatus(state.sessionActivity[path], pendingFor(path))}
              indent={indent}
              drag={drag.sessionRow(project.id, path)}
              canDelete={false}
            />
          ))}

          {shown.map((session) => (
            <SessionRow
              key={session.path}
              sessionPath={session.path}
              title={session.title}
              time={formatRelativeTime(session.modified, t)}
              active={session.path === selected}
              external={Boolean(state.externalChanged[session.path])}
              status={sessionStatus(
                state.sessionActivity[session.path],
                pendingFor(session.path),
              )}
              indent={indent}
              drag={drag.sessionRow(project.id, session.path)}
            />
          ))}

          {remaining > 0 ? (
            <button
              type="button"
              className={styles.revealMore}
              style={{ paddingLeft: 28 + indent }}
              onClick={() => actions.revealMoreSessions(project.id, rows.limit + SESSIONS_PAGE_SIZE)}
            >
              {t("session.expandAll", { count: remaining })}
            </button>
          ) : null}

          {unsaved.length === 0 && shown.length === 0 && !searching ? (
            <p className={styles.emptyList} style={{ marginLeft: indent }}>{t("session.empty")}</p>
          ) : null}
        </>
      ) : null}

      {node.children.map((child) => (
        <ProjectTreeItem key={child.project.id} node={child} drag={drag} />
      ))}
    </>
  );
}

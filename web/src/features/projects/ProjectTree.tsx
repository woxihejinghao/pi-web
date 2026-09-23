import clsx from "clsx";
import {
  ChevronIcon,
  EyeOffIcon,
  FolderIcon,
  PencilIcon,
  TrashIcon,
} from "../../components/icons.tsx";
import { actions, appStore, isDraftSession } from "../../lib/app-state.ts";
import { formatRelativeTime } from "../../lib/format.ts";
import type { ProjectNode } from "../../lib/project-tree.ts";
import { useStore } from "../../lib/store.ts";
import styles from "../../layout/Sidebar.module.css";

/** dsh shows five sessions per workspace before folding the rest. */
const PAGE_SIZE = 5;

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
  const rename = async (): Promise<void> => {
    const next = window.prompt("会话名称", title);
    if (next === null) return;
    await actions.renameSession(sessionPath, next);
  };

  const hide = async (): Promise<void> => {
    await actions.setSessionHidden(sessionPath, true);
    if (appStore.get().selectedSessionPath === sessionPath) actions.selectSession(null);
  };

  const remove = async (): Promise<void> => {
    const confirmed = window.confirm(
      `删除会话「${title}」？\n\n` +
        "系统装有 trash 命令时会移入废纸篓，否则将永久删除。会话内容只有一份，不在 Web 端保留备份。",
    );
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
      {external ? <span className={styles.externalDot} title="被其他进程修改" /> : null}
      <span className={styles.sessionTime}>{time}</span>
      <div className={styles.rowActions}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`重命名 ${title}`}
          title="重命名"
          onClick={() => void rename()}
        >
          <PencilIcon />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`隐藏 ${title}`}
          title="从列表中隐藏（不删除文件）"
          onClick={() => void hide()}
        >
          <EyeOffIcon />
        </button>
        {canDelete ? (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`删除 ${title}`}
            title="删除会话"
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
  const selected = state.selectedSessionPath;
  const provisional =
    selected !== null &&
    project.id === state.selectedProjectId &&
    (isDraftSession(selected) || !all.some((session) => session.path === selected));

  if (searching && matched.length === 0 && !project.title.toLowerCase().includes(query)) {
    return null;
  }

  const renameProject = async (): Promise<void> => {
    const next = window.prompt("项目名称", project.title);
    if (next === null) return;
    await actions.renameProject(project.id, next);
  };

  const removeProject = async (): Promise<void> => {
    const confirmed = window.confirm(
      `移除项目「${project.title}」？\n\n目录和会话历史都不会被删除。`,
    );
    if (!confirmed) return;
    await actions.removeProject(project.id);
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
          <span className={clsx(styles.projectChevron, expanded && styles.projectChevronOpen)}>
            <ChevronIcon />
          </span>
          <span className={styles.projectGlyph}>
            <FolderIcon />
          </span>
          <span className={styles.projectTitle}>{project.title}</span>
          {project.exists ? null : <span className={styles.missing}>缺失</span>}
        </button>
        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`重命名 ${project.title}`}
            title="重命名"
            onClick={() => void renameProject()}
          >
            <PencilIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`移除 ${project.title}`}
            title="移除项目"
            onClick={() => void removeProject()}
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      {expanded ? (
        <>
          {provisional && selected ? (
            <SessionRow
              sessionPath={selected}
              title="新会话"
              time={isDraftSession(selected) ? "准备中" : "未保存"}
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
              time={formatRelativeTime(session.modified)}
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
              展开其余 {remaining} 个会话
            </button>
          ) : null}

          {!provisional && shown.length === 0 && !searching ? (
            <p className={styles.emptyList} style={{ marginLeft: sessionIndent }}>
              还没有会话。
            </p>
          ) : null}
        </>
      ) : null}

      {node.children.map((child) => (
        <ProjectTreeItem key={child.project.id} node={child} />
      ))}
    </>
  );
}

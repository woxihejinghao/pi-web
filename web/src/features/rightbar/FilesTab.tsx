import { useCallback, useEffect, useState, type CSSProperties } from "react";
import clsx from "clsx";
import { FolderIcon, RefreshIcon } from "../../components/icons.tsx";
import { api } from "../../lib/api.ts";
import type { WorkspaceEntry } from "../../lib/types.ts";
import { FileIcon, TreeChevronIcon } from "./rightbar-icons.tsx";
import { PathLabel } from "./rightbar-path.tsx";
import pane from "./Pane.module.css";
import styles from "./FilesTab.module.css";
import { useT } from "../../lib/app-state.ts";

interface Level {
  status: "loading" | "ready" | "failed";
  entries: WorkspaceEntry[];
  truncated: boolean;
  error: string | null;
}

/**
 * The session's project as a tree, one level at a time.
 *
 * The root is the project directory this app opened the session in, and every
 * level below it is fetched the first time it is expanded — a deep workspace
 * would otherwise turn the panel's first paint into a recursive walk. A level
 * that has been fetched stays in memory while it is collapsed, so folding and
 * unfolding a directory does not re-list it.
 */
export function FilesTab({
  projectId,
  rootLabel,
  onOpenFile,
}: {
  projectId: string;
  /** The project directory, shown as the pane's header path. */
  rootLabel: string;
  onOpenFile(path: string): void;
}) {
  const t = useT();
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const [expanded, setExpanded] = useState<Record<string, true>>({ "": true });

  const load = useCallback(
    async (path: string): Promise<void> => {
      setLevels((previous) => ({
        ...previous,
        [path]: {
          status: "loading",
          entries: previous[path]?.entries ?? [],
          truncated: previous[path]?.truncated ?? false,
          error: null,
        },
      }));
      try {
        const listing = await api.listWorkspaceFiles(projectId, path);
        setLevels((previous) => ({
          ...previous,
          [path]: {
            status: "ready",
            entries: listing.entries,
            truncated: listing.truncated,
            error: null,
          },
        }));
      } catch (err) {
        setLevels((previous) => ({
          ...previous,
          [path]: { status: "failed", entries: [], truncated: false, error: (err as Error).message },
        }));
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  /** Drop the cached levels so the tree is read from disk again. */
  const reload = useCallback((): void => {
    setLevels({});
    setExpanded((previous) => {
      // Every level that was open is asked for again; the ones that were
      // collapsed are fetched when they next open, as usual.
      for (const path of Object.keys(previous)) void load(path);
      return previous;
    });
  }, [load]);

  const toggle = useCallback(
    (path: string): void => {
      setExpanded((previous) => {
        if (previous[path]) {
          const next = { ...previous };
          delete next[path];
          return next;
        }
        return { ...previous, [path]: true };
      });
      if (!expanded[path] && levels[path] === undefined) void load(path);
    },
    [expanded, levels, load],
  );

  const renderLevel = (path: string, depth: number): React.ReactNode[] => {
    const level = levels[path];
    if (level === undefined) return [];
    if (level.status === "failed") {
      return [
        <div key={`${path}:error`} className={styles.rowNote} style={indent(depth)}>
          {level.error}
        </div>,
      ];
    }
    if (level.status === "loading" && level.entries.length === 0) {
      return [
        <div key={`${path}:loading`} className={styles.rowNote} style={indent(depth)}>{t("common.loading")}</div>,
      ];
    }
    if (level.entries.length === 0) {
      return [
        <div key={`${path}:empty`} className={styles.rowNote} style={indent(depth)}>{t("files.empty")}</div>,
      ];
    }

    const rows: React.ReactNode[] = [];
    for (const entry of level.entries) {
      if (entry.type === "other") {
        rows.push(
          <div key={entry.path} className={styles.rowDisabled} style={indent(depth)}>
            <span className={styles.name}>{entry.name}</span>
          </div>,
        );
        continue;
      }
      if (entry.type === "directory") {
        const open = expanded[entry.path] === true;
        rows.push(
          <button
            key={entry.path}
            type="button"
            className={styles.row}
            style={indent(depth)}
            aria-expanded={open}
            onClick={() => toggle(entry.path)}
          >
            <span className={clsx(styles.chevron, open && styles.chevronOpen)}>
              <TreeChevronIcon width={12} height={12} />
            </span>
            <FolderIcon width={13} height={13} />
            <span className={styles.name}>{entry.name}</span>
          </button>,
        );
        if (open) rows.push(...renderLevel(entry.path, depth + 1));
        continue;
      }
      rows.push(
        <button
          key={entry.path}
          type="button"
          className={styles.row}
          style={indent(depth)}
          title={entry.path}
          onClick={() => onOpenFile(entry.path)}
        >
          <span className={styles.chevron} />
          <FileIcon width={13} height={13} />
          <span className={styles.name}>{entry.name}</span>
        </button>,
      );
    }
    if (level.truncated) {
      rows.push(
        <div key={`${path}:truncated`} className={styles.rowNote} style={indent(depth)}>{t("files.tooMany")}</div>,
      );
    }
    return rows;
  };

  return (
    <div className={pane.pane}>
      <div className={pane.header}>
        <span className={pane.path} title={rootLabel}>
          <PathLabel path={rootLabel} />
        </span>
        <button
          type="button"
          className={pane.action}
          title={t("common.refresh")}
          aria-label={t("files.refreshLabel")}
          onClick={reload}
        >
          <RefreshIcon width={14} height={14} />
        </button>
      </div>
      <div className={clsx(pane.scroll, styles.tree)}>{renderLevel("", 0)}</div>
    </div>
  );
}

/** Left padding for one tree row; the depth is the only thing that varies. */
function indent(depth: number): CSSProperties {
  return { paddingLeft: `${String(8 + depth * 12)}px` };
}

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { RefreshIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { api } from "../../lib/api.ts";
import type { WorkspaceEntry } from "../../lib/types.ts";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { PathLabel } from "./rightbar-path.tsx";
import pane from "./Pane.module.css";
import styles from "./FilesTab.module.css";
import { useT } from "../../lib/app-state.ts";

/** One directory level of the tree, as the panel holds it. */
export interface TreeLevel {
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
 *
 * Fetching and drawing are split: the cache lives here, and {@link FilesLevel}
 * draws whatever level it is handed. That is what lets the recursion pass the
 * `levels` record down to the nested lists instead of closing over a function
 * defined in this body.
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
  const [levels, setLevels] = useState<Record<string, TreeLevel>>({});
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
      <div className={clsx(pane.scroll, styles.tree)}>
        <FilesNode path="" levels={levels} expanded={expanded} onToggle={toggle} onOpenFile={onOpenFile} />
      </div>
    </div>
  );
}

/** One level from the cache: nothing is drawn until it has been listed. */
function FilesNode({
  path,
  levels,
  expanded,
  onToggle,
  onOpenFile,
}: {
  path: string;
  levels: Readonly<Record<string, TreeLevel>>;
  expanded: Readonly<Record<string, true>>;
  onToggle(path: string): void;
  onOpenFile(path: string): void;
}): React.ReactNode {
  const level = levels[path];
  if (level === undefined) return null;
  return (
    <FilesLevel
      level={level}
      levels={levels}
      expanded={expanded}
      onToggle={onToggle}
      onOpenFile={onOpenFile}
    />
  );
}

/**
 * One level of the tree, drawn from levels that are already in memory.
 *
 * Drawing is a function of its inputs, which is what makes this the half a test
 * can render directly: lists in, rows out, no fetching and no state of its own.
 * A level that is still loading, or that could not be read, is a note row in
 * place of its entries.
 *
 * The level is one `<ul>` and a directory's children are a `<ul>` inside its
 * `<li>`, so the indent is the nesting depth rather than a padding number
 * threaded through the recursion.
 */
export function FilesLevel({
  level,
  levels,
  expanded,
  onToggle,
  onOpenFile,
}: {
  level: TreeLevel;
  levels: Readonly<Record<string, TreeLevel>>;
  expanded: Readonly<Record<string, true>>;
  onToggle(path: string): void;
  onOpenFile(path: string): void;
}): React.ReactNode {
  const t = useT();
  if (level.status === "failed") {
    return (
      <ul className={styles.level}>
        <li className={styles.item}>
          <div className={styles.rowNote}>{level.error}</div>
        </li>
      </ul>
    );
  }
  if (level.status === "loading" && level.entries.length === 0) {
    return (
      <ul className={styles.level}>
        <li className={styles.item}>
          <div className={styles.rowNote}>{t("common.loading")}</div>
        </li>
      </ul>
    );
  }
  if (level.entries.length === 0) {
    return (
      <ul className={styles.level}>
        <li className={styles.item}>
          <div className={styles.rowNote}>{t("files.empty")}</div>
        </li>
      </ul>
    );
  }

  const rows: React.ReactNode[] = [];
  for (const entry of level.entries) {
    if (entry.type === "other") {
      rows.push(
        <li key={entry.path} className={styles.item}>
          <div className={styles.rowDisabled}>
            <span className={styles.name}>{entry.name}</span>
          </div>
        </li>,
      );
    } else if (entry.type === "directory") {
      rows.push(
        <li key={entry.path} className={styles.item}>
          <DirectoryNode
            entry={entry}
            levels={levels}
            expanded={expanded}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
          />
        </li>,
      );
    } else {
      rows.push(
        <li key={entry.path} className={styles.item}>
          <button
            type="button"
            className={styles.row}
            title={entry.path}
            onClick={() => onOpenFile(entry.path)}
          >
            <FileTypeIcon name={entry.name} size={16} />
            <span className={styles.name}>{entry.name}</span>
          </button>
        </li>,
      );
    }
  }
  if (level.truncated) {
    rows.push(
      <li key="truncated" className={styles.item}>
        <div className={styles.rowNote}>{t("files.tooMany")}</div>
      </li>,
    );
  }
  return <ul className={styles.level}>{rows}</ul>;
}

/**
 * A directory row and, when it is open, the level beneath it.
 *
 * The two glyphs are dsh's two folders — `folderOpen` is not a tint of
 * `folderClose` but its own drawing — so an open workspace reads as a different
 * mark rather than a hue.
 */
function DirectoryNode({
  entry,
  levels,
  expanded,
  onToggle,
  onOpenFile,
}: {
  entry: WorkspaceEntry;
  levels: Readonly<Record<string, TreeLevel>>;
  expanded: Readonly<Record<string, true>>;
  onToggle(path: string): void;
  onOpenFile(path: string): void;
}): React.ReactNode {
  const open = expanded[entry.path] === true;
  return (
    <>
      <button
        type="button"
        className={styles.row}
        aria-expanded={open}
        onClick={() => onToggle(entry.path)}
      >
        <span className={styles.folderIcon}>
          <Glyph name={open ? "folderOpen" : "folderClose"} size={16} />
        </span>
        <span className={styles.name}>{entry.name}</span>
      </button>
      {open ? (
        <FilesNode
          path={entry.path}
          levels={levels}
          expanded={expanded}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { RefreshIcon } from "../../components/icons.tsx";
import { api } from "../../lib/api.ts";
import type { GitFileEntry, GitStatusView } from "../../lib/types.ts";
import { ChangesFile } from "./ChangesFile.tsx";
import { CommitBar, HistoryList } from "./ChangesFooter.tsx";
import { TreeChevronIcon } from "./rightbar-icons.tsx";
import pane from "./Pane.module.css";
import styles from "./ChangesTab.module.css";
import { appStore, useT, workspaceChanged } from "../../lib/app-state.ts";
import { useStoreSelector } from "../../lib/store.ts";

/**
 * The project's changes, with the four things a git panel is for: committing,
 * pushing, staging, and reading the diff before any of them.
 *
 * The commit box sits at the top, above the lists rather than under them: it is
 * the one control a user reaches for after reading any of the file rows, and at
 * the bottom of a long change set it would mean scrolling past everything to
 * reach it. The file lists (and the history) take the scrolling area below.
 *
 * There is one scope: the project's working tree. A second, session-filtered
 * scope was built and removed — the same file is usually interesting for the
 * same reason, and a switch that mostly showed a subset of the list above it
 * cost more attention than it saved.
 */
export function ChangesTab({
  projectId,
  onOpenFile,
}: {
  projectId: string;
  onOpenFile(path: string): void;
}) {
  const t = useT();
  const [view, setView] = useState<GitStatusView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Invalidates in-flight reads so an older reply cannot overwrite a newer one. */
  const requestRef = useRef(0);
  /** Read by the workspace subscription, which must not refresh under a write. */
  const busyRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    setLoadError(null);
    try {
      const next = await api.getGitStatus(projectId);
      if (request === requestRef.current) setView(next);
    } catch (err) {
      if (request === requestRef.current) setLoadError((err as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const projects = useStoreSelector(appStore, (state) => state.projects);
  const projectPath = useMemo(
    () => projects.find((project) => project.id === projectId)?.path ?? null,
    [projects, projectId],
  );

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  /**
   * Follow edits made outside this panel — an editor save, a formatter, or a
   * `git` command in a terminal. The server watches the working tree and says
   * only that something moved; whether that is worth a `git status` read is
   * decided here, and only while the panel is on screen, since this effect is
   * the mount.
   */
  useEffect(() => {
    if (projectPath === null) return;
    let timer: number | null = null;
    const unsubscribe = workspaceChanged.subscribe((payload) => {
      if (payload.projectPath !== projectPath) return;
      // A write re-reads on its own; refreshing underneath it would race its
      // own reply back to a stale list.
      if (busyRef.current) return;
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void load();
      }, 300);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [projectPath, load]);

  /**
   * Every write goes through here.
   *
   * The reply is the re-read state rather than an acknowledgement, so the panel
   * never shows a list it computed from what it expected git to do; a failure
   * lands next to the buttons that caused it, in git's own words.
   */
  const run = useCallback(async (action: () => Promise<GitStatusView>) => {
    setBusy(true);
    // A write outranks any read still in flight; its reply is the truth.
    requestRef.current += 1;
    setActionError(null);
    setNotice(null);
    try {
      setView(await action());
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const staged = useMemo(() => view?.staged ?? [], [view]);
  const unstaged = useMemo(() => view?.unstaged ?? [], [view]);

  const stage = useCallback(
    (paths: string[] | null, nextStaged: boolean) => {
      void run(() =>
        api.stagePaths(
          projectId,
          paths === null ? { all: true, staged: nextStaged } : { paths, staged: nextStaged },
        ),
      );
    },
    [projectId, run],
  );

  const discard = useCallback(
    (path: string) => {
      // Discarding is the one action here that destroys work, and it cannot be
      // undone; the confirmation names the file rather than asking "are you sure".
      if (!window.confirm(t("changes.restoreConfirm", { path }))) return;
      void run(() => api.discardPaths(projectId, [path]));
    },
    [projectId, run],
  );

  const commit = useCallback(
    async (message: string): Promise<boolean> => {
      setBusy(true);
      requestRef.current += 1;
      setActionError(null);
      setNotice(null);
      try {
        const result = await api.commitChanges(projectId, message);
        setView(result.view);
        setNotice(t("changes.committed", { hash: result.hash }));
        return true;
      } catch (err) {
        setActionError((err as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const push = useCallback(() => {
    setBusy(true);
    requestRef.current += 1;
    setActionError(null);
    setNotice(null);
    api
      .pushBranch(projectId)
      .then((result) => {
        setView(result.view);
        setNotice(result.message);
      })
      .catch((err: unknown) => setActionError((err as Error).message))
      .finally(() => setBusy(false));
  }, [projectId]);

  const checkout = useCallback(
    (branch: string) => {
      void run(() => api.checkoutBranch(projectId, branch));
    },
    [projectId, run],
  );

  const repository = view?.repository === true;

  return (
    <div className={pane.pane}>
      {repository ? (
        <>
          <CommitBar view={view} busy={busy} error={actionError} onCommit={commit} onPush={push} />
          <BranchRow
            view={view}
            busy={busy}
            onRefresh={() => void load()}
            onCheckout={checkout}
          />
        </>
      ) : (
        <div className={pane.header}>
          <span className={styles.summaryMuted}>{t("changes.workspace")}</span>
          <button
            type="button"
            className={pane.action}
            title={t("common.refresh")}
            aria-label={t("changes.refresh")}
            onClick={() => void load()}
          >
            <RefreshIcon width={14} height={14} />
          </button>
        </div>
      )}

      <div className={clsx(pane.scroll, styles.body)}>
        {loadError !== null ? (
          <div className={pane.error}>{loadError}</div>
        ) : view === null ? (
          <div className={pane.note}>{t("changes.loading")}</div>
        ) : !repository ? (
          <div className={pane.note}>{view.error ?? t("changes.notGit")}</div>
        ) : (
          <>
            <FileSection
              title={t("changes.staged")}
              count={staged.length}
              action={
                staged.length > 0
                  ? { label: t("changes.unstageAll"), onClick: () => stage(null, false) }
                  : null
              }
              files={staged}
              side="staged"
              busy={busy}
              emptyText={t("changes.noStaged")}
              onStage={stage}
              onDiscard={discard}
              onOpenFile={onOpenFile}
            />

            <FileSection
              title={t("changes.unstaged")}
              count={unstaged.length}
              action={
                unstaged.length > 0
                  ? { label: t("changes.stageAll"), onClick: () => stage(null, true) }
                  : null
              }
              files={unstaged}
              side="unstaged"
              busy={busy}
              emptyText={t("changes.noUnstaged")}
              onStage={stage}
              onDiscard={discard}
              onOpenFile={onOpenFile}
            />

            {view.omittedFiles > 0 ? (
              <div className={pane.note}>
                {t("changes.omitted", { count: view.omittedFiles })}
              </div>
            ) : null}

            {notice !== null ? <div className={styles.notice}>{notice}</div> : null}

            <HistoryList log={view.log} />
          </>
        )}
      </div>
    </div>
  );
}

/** The branch chip, its switcher, and the panel's refresh. */
function BranchRow({
  view,
  busy,
  onRefresh,
  onCheckout,
}: {
  view: GitStatusView;
  busy: boolean;
  onRefresh(): void;
  onCheckout(branch: string): void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = document.getElementById("piws-branch-menu");
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className={pane.header}>
      <div className={styles.branchWrap}>
        <button
          type="button"
          className={styles.branchButton}
          disabled={busy || view.detached}
          title={view.detached ? t("changes.detached") : t("changes.switchBranch")}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={styles.branchName}>{view.branch ?? "—"}</span>
          <TreeChevronIcon width={11} height={11} />
        </button>
        {open ? (
          <div className={styles.branchMenu} id="piws-branch-menu" role="menu">
            {view.branches.map((branch) => (
              <button
                key={branch}
                type="button"
                role="menuitem"
                className={clsx(
                  styles.branchItem,
                  branch === view.branch && styles.branchItemActive,
                )}
                onClick={() => {
                  setOpen(false);
                  if (branch !== view.branch) onCheckout(branch);
                }}
              >
                {branch}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <span className={styles.summary}>
        {view.upstream === null ? (
          <span className={styles.summaryMuted}>{t("changes.noUpstream")}</span>
        ) : (
          <>
            <span className={styles.summaryMuted}>{view.upstream}</span>
            {view.ahead > 0 ? <span className={styles.added}>↑{view.ahead}</span> : null}
            {view.behind > 0 ? <span className={styles.removed}>↓{view.behind}</span> : null}
          </>
        )}
      </span>

      <button
        type="button"
        className={pane.action}
        title={t("common.refresh")}
        aria-label={t("changes.refresh")}
        onClick={onRefresh}
      >
        <RefreshIcon width={14} height={14} />
      </button>
    </div>
  );
}

/** One of the two file lists, with its count and its bulk action. */
function FileSection({
  title,
  count,
  action,
  files,
  side,
  busy,
  emptyText,
  onStage,
  onDiscard,
  onOpenFile,
}: {
  title: string;
  count: number;
  action: { label: string; onClick(): void } | null;
  files: GitFileEntry[];
  side: "staged" | "unstaged";
  busy: boolean;
  emptyText: string;
  onStage(paths: string[] | null, staged: boolean): void;
  onDiscard(path: string): void;
  onOpenFile(path: string): void;
}) {
  const t = useT();
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>
          {title} ({count})
        </span>
        {action !== null ? (
          <button
            type="button"
            className={styles.sectionAction}
            disabled={busy}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : null}
      </div>
      {files.length === 0 ? (
        <div className={styles.sectionEmpty}>{emptyText}</div>
      ) : (
        files.map((file) => (
          <div key={file.path}>
            <ChangesFile
              file={file}
              side={side}
              busy={busy}
              onStage={(path, staged) => onStage([path], staged)}
              onDiscard={onDiscard}
            />
            {file.status === "untracked" ? (
              <button
                type="button"
                className={styles.openFile}
                onClick={() => onOpenFile(file.path)}
              >{t("changes.viewFile")}</button>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import clsx from "clsx";
import { RefreshIcon } from "../../components/icons.tsx";
import { api } from "../../lib/api.ts";
import type { WorkspaceFileContent, WorkspaceTextPage } from "../../lib/types.ts";
import { Markdown } from "../conversation/Markdown.tsx";
import { CodeBlock } from "../conversation/CodeBlock.tsx";
import { CodeView } from "./CodeView.tsx";
import { languageFor, previewKindFor } from "./file-kind.ts";
import { buildFrameDocument } from "./html-frame.ts";
import { PathLabel } from "./rightbar-path.tsx";
import { PauseIcon, PlayIcon } from "./rightbar-icons.tsx";
import { OpenWithButton, useOpenWith, type OpenWithControls } from "./OpenWithButton.tsx";
import { previewChangedBy } from "./preview-refresh.ts";
import type { RightbarTab } from "./rightbar-state.ts";
import pane from "./Pane.module.css";
import styles from "./PreviewTab.module.css";
import { useT, workspaceChanged } from "../../lib/app-state.ts";

type PreviewState =
  | { status: "loading" }
  | { status: "failed"; error: string }
  /** `error` is a failed refresh: the version below it is still the last good one. */
  | { status: "ready"; file: WorkspaceFileContent; error?: string };

/**
 * One file, rendered by what it is.
 *
 * The server decides whether it will hand the file over at all; what to draw
 * with it is a pure function of the name and that verdict (see `file-kind.ts`).
 * Markdown and code reuse the conversation's own renderers, so a README in the
 * panel looks like a README in a transcript — and its shiki grammar arrives
 * through the same on-demand path.
 *
 * Two kinds are not drawn here at all. A PDF and a page are handed to the
 * browser's own renderers in a frame, which is why the body has two shapes: the
 * scrolling one everything else lives in, and a flex column that a frame can
 * fill.
 *
 * The tab follows edits made outside this app. The server's workspace watcher
 * names what moved, and when one of those paths covers this file the tab either
 * re-reads it (auto refresh, on by default) or says the content is stale and
 * offers the re-read — never both, and never silently.
 */
export function PreviewTab({
  projectId,
  projectPath,
  sessionPath,
  tab,
}: {
  sessionPath?: string;
  projectId: string;
  /** The project root the watcher reports paths against. */
  projectPath: string;
  tab: RightbarTab;
}) {
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  // Both of these are view state, not layout state: they belong to the tab while
  // it is mounted and are not written to the layout the sidebar persists. dsh
  // keeps the same pair in a per-tab store with the same defaults.
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [stale, setStale] = useState(false);
  // One query for the file, shared by both places the control appears — the
  // header and, for a file this app cannot render, the empty state. dsh shares
  // one per (file, query) for the same reason: two controls for one file must
  // not be able to disagree about what the host offers.
  // External transcript images are preview-only; native file actions retain
  // their project-relative boundary.
  const absoluteTarget = tab.target.startsWith("/") || /^[a-zA-Z]:/.test(tab.target);
  const openWith = useOpenWith(projectId, tab.target, !absoluteTarget);

  useEffect(() => {
    let cancelled = false;
    // A re-read keeps the version on screen: the point of following an edit is
    // to swap the content, not to blank the tab for a round trip. Only the
    // first read — nothing to keep — shows the loading state.
    setState((previous) => (previous.status === "ready" ? previous : { status: "loading" }));
    api
      .readWorkspaceFile(projectId, tab.target, absoluteTarget ? sessionPath : undefined)
      .then((file) => {
        if (!cancelled) setState({ status: "ready", file });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = (err as Error).message;
        // A failure *after* content arrived is a failed refresh, not an empty
        // tab: the old version stays and the error sits above it. Only a first
        // read that never landed has nothing to fall back to.
        setState((previous) =>
          previous.status === "ready"
            ? { status: "ready", file: previous.file, error: message }
            : { status: "failed", error: message },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, tab.target, attempt, absoluteTarget, sessionPath]);

  /**
   * Follow the file the way the changes panel follows the tree.
   *
   * A change that lands while this tab is still reading stays marked rather than
   * discarded: the read in flight will answer with a version that is already
   * behind, and the effect below re-reads once that reply lands.
   */
  useEffect(() => {
    const unsubscribe = workspaceChanged.subscribe((payload) => {
      if (payload.projectPath !== projectPath) return;
      if (!previewChangedBy(payload.paths, tab.target)) return;
      setStale(true);
    });
    return unsubscribe;
  }, [projectPath, tab.target]);

  /**
   * Auto refresh: re-read as soon as nothing else is in flight.
   *
   * The `loading` guard is the whole discipline here. Re-reading mid-request
   * would replace the reply that is coming and could leave the body showing a
   * mix of two versions, so a change that arrives during a read waits for it —
   * the status change re-runs this effect right after.
   */
  useEffect(() => {
    if (!stale || !autoRefresh || state.status === "loading") return;
    setStale(false);
    setAttempt((value) => value + 1);
  }, [stale, autoRefresh, state.status]);

  /** Re-read now: the header's control and the stale banner both land here. */
  const reload = (): void => {
    setStale(false);
    setAttempt((value) => value + 1);
  };

  const framed = state.status === "ready" && isFramed(state.file);

  return (
    <div className={pane.pane}>
      <div className={pane.header}>
        <span className={pane.path} title={tab.target}>
          <PathLabel path={tab.target} />
        </span>
        <button
          type="button"
          className={pane.action}
          aria-pressed={autoRefresh}
          aria-label={t("preview.autoRefresh")}
          title={autoRefresh ? t("preview.disableAutoRefresh") : t("preview.enableAutoRefresh")}
          data-preview-auto-refresh
          onClick={() => setAutoRefresh((value) => !value)}
        >
          {autoRefresh ? <PauseIcon width={14} height={14} /> : <PlayIcon width={14} height={14} />}
        </button>
        <button
          type="button"
          className={pane.action}
          title={t("pane.reload")}
          aria-label={t("preview.reloadLabel")}
          onClick={reload}
        >
          <RefreshIcon width={14} height={14} />
        </button>
        {/* Last in the header, after the panel's own controls, which is where
            dsh's `sidebar.right.tab.document.actions` slot puts it. */}
        {openWith.available ? (
          <OpenWithButton
            applications={openWith.applications}
            loading={openWith.loading}
            failed={openWith.failed}
            busy={openWith.busy}
            onAct={openWith.act}
          />
        ) : null}
      </div>
      {/* One row, two reasons: a failed refresh outranks "this is stale", the
          way dsh orders the same pair. Both offer the same re-read. */}
      {state.status === "ready" && state.error !== undefined ? (
        <p className={styles.changed} data-preview-failed-refresh>
          <span>{state.error}</span>
          <button type="button" className={styles.changedAction} onClick={reload}>
            {t("preview.reload")}
          </button>
        </p>
      ) : stale && state.status !== "loading" ? (
        <p className={styles.changed} data-preview-changed>
          <span>{t("preview.changed")}</span>
          <button type="button" className={styles.changedAction} onClick={reload}>
            {t("preview.reload")}
          </button>
        </p>
      ) : null}
      {/* A refused open or reveal, in the host's own words. Its own row rather
          than a toast: this app has no toast layer, and a sentence that
          disappears on a timer is the wrong shape for "the desktop said no". */}
      {openWith.failure !== null ? (
        <p className={styles.changed} data-preview-open-failed>
          <span>{openWith.failure}</span>
          <button type="button" className={styles.changedAction} onClick={openWith.dismissFailure}>
            {t("common.close")}
          </button>
        </p>
      ) : null}
      <div className={framed ? styles.framed : clsx(pane.scroll, styles.body)}>
        {state.status === "loading" ? (
          <div className={styles.centered}>
            <span className={styles.spinner} aria-hidden />{t("common.loading")}</div>
        ) : state.status === "failed" ? (
          <div className={pane.error}>{state.error}</div>
        ) : (
          <Body
            projectId={projectId}
            path={tab.target}
            attempt={attempt}
            file={state.file}
            openWith={openWith}
            // A reference's lines belong to the tab, so they are read back on
            // every render: a second chip pointing at the same file moves the
            // tab it already has rather than opening a neighbouring copy.
            {...(tab.line === undefined ? {} : { position: { line: tab.line, endLine: tab.endLine } })}
          />
        )}
      </div>
    </div>
  );
}

/** Kinds the browser draws for us, in a frame that fills the pane. */
function isFramed(file: WorkspaceFileContent): boolean {
  const kind = previewKindFor(file.name, file.kind);
  return kind === "pdf" || kind === "html";
}

function Body({
  projectId,
  path,
  attempt,
  file,
  position,
  openWith,
}: {
  projectId: string;
  path: string;
  attempt: number;
  file: WorkspaceFileContent;
  /** Lines a reference asked for; absent for an ordinary open. */
  position?: { line?: number | undefined; endLine?: number | undefined } | undefined;
  /** The file's open control, shared with the header. */
  openWith?: OpenWithControls | undefined;
}) {
  const t = useT();
  const kind = previewKindFor(file.name, file.kind);

  if (kind === "unsupported") {
    return (
      <div className={styles.centered}>
        <span className={styles.unsupportedName}>{file.name}</span>
        {file.reason ?? t("preview.unsupported")}
        {/* A file this app cannot draw is the one place where opening it
            elsewhere is the whole answer, so the control is offered at full size
            with the action spelled out — dsh's `unpreviewable` slot. */}
        {openWith !== undefined && openWith.available ? (
          <OpenWithButton
            applications={openWith.applications}
            loading={openWith.loading}
            failed={openWith.failed}
            busy={openWith.busy}
            prominent
            onAct={openWith.act}
          />
        ) : null}
      </div>
    );
  }

  if (kind === "image") {
    const src = `data:${file.mimeType ?? "application/octet-stream"};base64,${file.content}`;
    return (
      <div className={styles.imageWrap}>
        <img className={styles.image} src={src} alt={file.name} />
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <div className={styles.frameWrap}>
        {/*
         * The frame's `src` is the file's own URL, so the browser's viewer gets
         * the bytes with a real content type and can stream and range-request
         * them. Nothing about this path is this app's: it neither reads nor
         * re-encodes the document.
         */}
        <iframe
          key={attempt}
          className={styles.frame}
          src={api.workspaceRawUrl(projectId, path)}
          title={file.name}
        />
      </div>
    );
  }

  if (kind === "html") {
    return (
      <>
        <div className={styles.frameNotice}>
          {t("preview.htmlStatic")}
          {file.truncated ? " " + t("preview.tooLarge") : null}
        </div>
        <div className={styles.frameWrap}>
          {/*
           * `sandbox=""` is the whole sandbox: no scripts, no forms, no
           * navigation, and an opaque origin the document cannot read back
           * through. Nothing is passed alongside it on purpose — the usual
           * `allow-scripts allow-same-origin` pair would hand a local file the
           * run of this app's origin, which is exactly what a preview of
           * somebody else's markup must not do.
           */}
          <iframe
            key={attempt}
            className={styles.frame}
            sandbox=""
            srcDoc={buildFrameDocument(file.content)}
            title={file.name}
          />
        </div>
      </>
    );
  }

  /*
   * Everything below is text. When one read could not show all of it, the
   * truncated head is not worth drawing: the file is read a page at a time
   * instead, so nothing is announced as missing that the reader cannot reach.
   */
  if (file.truncated) {
    return <TextPager projectId={projectId} path={path} resetKey={attempt} focusLine={position?.line} />;
  }

  if (kind === "markdown") {
    return (
      <div className={styles.markdown}>
        <Markdown text={file.content} />
      </div>
    );
  }

  if (kind === "code") {
    return (
      <div className={styles.code}>
        {position?.line === undefined ? (
          <CodeBlock code={file.content} lang={languageFor(file.name)} />
        ) : (
          /* A read that asked for a line gets the row view, and one that did not
           * keeps the highlighted block it always had: colour is worth more
           * than a scroll target in a file nobody pointed into. */
          <CodeView
            code={file.content}
            lang={languageFor(file.name)}
            focusLine={position.line}
            focusEndLine={position.endLine}
          />
        )}
      </div>
    );
  }

  return <pre className={styles.text}>{file.content}</pre>;
}

/** A page already held, or the same page arriving twice, must not double up. */
function appendPage(held: WorkspaceTextPage[], page: WorkspaceTextPage): WorkspaceTextPage[] {
  return held.some((existing) => existing.offset === page.offset) ? held : [...held, page];
}

/**
 * How many pages the fallback may pull in while chasing its line.
 *
 * Twenty pages is 40k lines — far past the point where the reader is reading
 * source rather than scrolling a log, and a hard stop that keeps a stale line
 * number from walking the whole file a page at a time. Only the fallback path
 * ever reaches it; a line-addressed read lands in one request.
 */
const MAX_CHASE_PAGES = 20;

/**
 * A file too large to hand over whole, read a page at a time.
 *
 * The first page arrives on its own, and each page after it only when the reader
 * asks, so opening a multi-megabyte log costs one small request instead of a
 * megabyte and a lie about the rest. The walk is by byte offset — the offset the
 * previous page ended at — because a line number cannot be resolved without
 * re-reading everything before it.
 *
 * A reference is the one case that *does* need a line, so it is the one case the
 * server resolves it: the first request carries `fromLine`, the server scans to
 * it and answers with the page around it, and `startLine` numbers that page so
 * the rest of the walk can continue from it. Without that, a jump would have to
 * be approximated by reading pages until one covered the target.
 *
 * Pages are drawn as plain text rather than through the code renderer, even for
 * source files: the seam between two pages has to stay invisible, and a
 * highlighted block per page would put a language banner and a copy button in
 * the middle of a file that has no seam in it. The divider above each page is
 * what keeps the location readable instead — and a page that has been jumped to
 * is drawn as rows, because a line number only means something on a line that is
 * an element of its own.
 */
function TextPager({
  projectId,
  path,
  resetKey,
  focusLine,
}: {
  projectId: string;
  path: string;
  resetKey: number;
  /** A reference's line, which the pager reads toward; see the chase effect. */
  focusLine?: number | undefined;
}) {
  const t = useT();
  const [pages, setPages] = useState<WorkspaceTextPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `resetKey` is the header's reload: it re-reads the file from the first page
  // rather than leaving the reader where they were in a file that may have
  // changed under them. A reference's line is re-asked here too — the server
  // scans to it, so landing on a line deep in the file is one request.
  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setError(null);
    setBusy(true);
    api
      .readWorkspaceTextPage(projectId, path, 0, focusLine)
      .then((page) => {
        if (!cancelled) setPages((held) => appendPage(held, page));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, resetKey, focusLine]);

  const last = pages[pages.length - 1];
  const done = last !== undefined && last.eof;
  const nextOffset = last?.nextOffset ?? 0;
  const lines = pages.reduce((sum, page) => sum + page.lines, 0);

  /**
   * Chase the reference's line — the fallback path.
   *
   * A line-addressed read is answered by the server in one request, so this loop
   * only runs when that did not cover the target: an older server that ignored
   * `fromLine`, or a line past the end of the file where the last page is not
   * enough. It is bounded because a stale reference must not walk a gigabyte of
   * log one page at a time — at that point the honest answer is "the file is
   * longer than this panel will read", which the pager already says.
   */
  useEffect(() => {
    if (focusLine === undefined || busy || done) return;
    if (pages.length === 0 || pages.length >= MAX_CHASE_PAGES) return;
    // Compare against the line the loaded pages actually reach, not the number
    // of lines read: a page-addressed read starts partway into the file.
    if ((pages[0]?.startLine ?? 1) - 1 + lines >= focusLine) return;
    let cancelled = false;
    setBusy(true);
    api
      .readWorkspaceTextPage(projectId, path, nextOffset)
      .then((page) => {
        if (!cancelled) setPages((held) => appendPage(held, page));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [focusLine, busy, done, pages.length, lines, nextOffset, projectId, path]);

  // Line ranges are accumulated at render time rather than stored, because each
  // page only knows how many lines it holds — the count is what the server
  // answers with, and it is what keeps a page's own text free of padding. The
  // starting number comes from the page itself when the read was addressed by
  // line, and from 1 otherwise.
  let line = pages[0]?.startLine ?? 1;
  const blocks = pages.map((page) => {
    const start = line;
    line += page.lines;
    return { page, start, end: line - 1 };
  });

  const loadMore = (): void => {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    api
      .readWorkspaceTextPage(projectId, path, nextOffset)
      .then((page) => setPages((held) => appendPage(held, page)))
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      {blocks.map(({ page, start, end }) => (
        <div key={page.offset}>
          {start > 1 ? (
            <div className={styles.pageDivider}>
              {t("preview.pageRange", { from: start, to: end })}
            </div>
          ) : null}
          {/* An ordinary open keeps the wrapping plain-text page it always had.
              A reference's open switches the whole file to rows, because a line
              number only means something on a line that does not wrap. */}
          {focusLine === undefined ? (
            <pre className={styles.text}>{page.text}</pre>
          ) : (
            <CodeView
              code={page.text}
              gutter={false}
              firstLine={start}
              // Only the page that holds the target gets a target; the others
              // are context, and scrolling to a line they do not have is a
              // no-op `CodeView` already guards against.
              {...(focusLine >= start && focusLine <= end ? { focusLine } : {})}
            />
          )}
        </div>
      ))}
      {error !== null ? <div className={pane.error}>{error}</div> : null}
      <div className={styles.pager}>
        {done ? (
          <span className={styles.pagerCount}>{t("preview.loadedAll")}</span>
        ) : (
          <button
            type="button"
            className={styles.pagerButton}
            disabled={busy}
            onClick={loadMore}
          >
            {t("preview.loadMore")}
          </button>
        )}
        {pages.length > 0 ? (
          <span className={styles.pagerCount}>{t("preview.linesShown", { count: lines })}</span>
        ) : null}
      </div>
    </>
  );
}

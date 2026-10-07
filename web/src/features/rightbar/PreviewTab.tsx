import { useEffect, useState } from "react";
import clsx from "clsx";
import { RefreshIcon } from "../../components/icons.tsx";
import { api } from "../../lib/api.ts";
import type { WorkspaceFileContent, WorkspaceTextPage } from "../../lib/types.ts";
import { Markdown } from "../conversation/Markdown.tsx";
import { CodeBlock } from "../conversation/CodeBlock.tsx";
import { languageFor, previewKindFor } from "./file-kind.ts";
import { buildFrameDocument } from "./html-frame.ts";
import { PathLabel } from "./rightbar-path.tsx";
import type { RightbarTab } from "./rightbar-state.ts";
import pane from "./Pane.module.css";
import styles from "./PreviewTab.module.css";
import { useT } from "../../lib/app-state.ts";

type PreviewState =
  | { status: "loading" }
  | { status: "failed"; error: string }
  | { status: "ready"; file: WorkspaceFileContent };

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
 */
export function PreviewTab({ projectId, tab }: { projectId: string; tab: RightbarTab }) {
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api
      .readWorkspaceFile(projectId, tab.target)
      .then((file) => {
        if (!cancelled) setState({ status: "ready", file });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "failed", error: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, tab.target, attempt]);

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
          title={t("pane.reload")}
          aria-label={t("preview.reloadLabel")}
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RefreshIcon width={14} height={14} />
        </button>
      </div>
      <div className={framed ? styles.framed : clsx(pane.scroll, styles.body)}>
        {state.status === "loading" ? (
          <div className={styles.centered}>
            <span className={styles.spinner} aria-hidden />{t("common.loading")}</div>
        ) : state.status === "failed" ? (
          <div className={pane.error}>{state.error}</div>
        ) : (
          <Body projectId={projectId} path={tab.target} attempt={attempt} file={state.file} />
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
}: {
  projectId: string;
  path: string;
  attempt: number;
  file: WorkspaceFileContent;
}) {
  const t = useT();
  const kind = previewKindFor(file.name, file.kind);

  if (kind === "unsupported") {
    return (
      <div className={styles.centered}>
        <span className={styles.unsupportedName}>{file.name}</span>
        {file.reason ?? t("preview.unsupported")}
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
    return <TextPager projectId={projectId} path={path} resetKey={attempt} />;
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
        <CodeBlock code={file.content} lang={languageFor(file.name)} />
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
 * A file too large to hand over whole, read a page at a time.
 *
 * The first page arrives on its own, and each page after it only when the reader
 * asks, so opening a multi-megabyte log costs one small request instead of a
 * megabyte and a lie about the rest. The walk is by byte offset — the offset the
 * previous page ended at — because a line number cannot be resolved without
 * re-reading everything before it.
 *
 * Pages are drawn as plain text rather than through the code renderer, even for
 * source files: the seam between two pages has to stay invisible, and a
 * highlighted block per page would put a language banner and a copy button in
 * the middle of a file that has no seam in it. The divider above each page is
 * what keeps the location readable instead.
 */
function TextPager({
  projectId,
  path,
  resetKey,
}: {
  projectId: string;
  path: string;
  resetKey: number;
}) {
  const t = useT();
  const [pages, setPages] = useState<WorkspaceTextPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // `resetKey` is the header's reload: it re-reads the file from its first page
  // rather than leaving the reader where they were in a file that may have
  // changed under them.
  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setError(null);
    setBusy(true);
    api
      .readWorkspaceTextPage(projectId, path, 0)
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
  }, [projectId, path, resetKey]);

  const last = pages[pages.length - 1];
  const done = last !== undefined && last.eof;
  const nextOffset = last?.nextOffset ?? 0;
  const lines = pages.reduce((sum, page) => sum + page.lines, 0);

  // Line ranges are accumulated at render time rather than stored, because each
  // page only knows how many lines it holds — the count is what the server
  // answers with, and it is what keeps a page's own text free of padding.
  let line = 1;
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
          <pre className={styles.text}>{page.text}</pre>
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

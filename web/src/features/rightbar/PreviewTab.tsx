import { useEffect, useState } from "react";
import clsx from "clsx";
import { RefreshIcon } from "../../components/icons.tsx";
import { api } from "../../lib/api.ts";
import type { WorkspaceFileContent } from "../../lib/types.ts";
import { Markdown } from "../conversation/Markdown.tsx";
import { CodeBlock } from "../conversation/CodeBlock.tsx";
import { languageFor, previewKindFor } from "./file-kind.ts";
import { PathLabel } from "./rightbar-path.tsx";
import type { RightbarTab } from "./rightbar-state.ts";
import pane from "./Pane.module.css";
import styles from "./PreviewTab.module.css";

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
 */
export function PreviewTab({ projectId, tab }: { projectId: string; tab: RightbarTab }) {
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

  return (
    <div className={pane.pane}>
      <div className={pane.header}>
        <span className={pane.path} title={tab.target}>
          <PathLabel path={tab.target} />
        </span>
        <button
          type="button"
          className={pane.action}
          title="重新载入"
          aria-label="重新载入文件"
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RefreshIcon width={14} height={14} />
        </button>
      </div>
      <div className={clsx(pane.scroll, styles.body)}>
        {state.status === "loading" ? (
          <div className={styles.centered}>
            <span className={styles.spinner} aria-hidden />
            加载中…
          </div>
        ) : state.status === "failed" ? (
          <div className={pane.error}>{state.error}</div>
        ) : (
          <Body file={state.file} />
        )}
      </div>
    </div>
  );
}

function Body({ file }: { file: WorkspaceFileContent }) {
  const kind = previewKindFor(file.name, file.kind);

  if (kind === "unsupported") {
    return (
      <div className={styles.centered}>
        <span className={styles.unsupportedName}>{file.name}</span>
        {file.reason ?? "暂不支持预览这个文件"}
      </div>
    );
  }

  // A text file longer than the read cap ends mid-line; saying so above the
  // content is what stops the last line from looking like a truncated file.
  const notice = file.truncated ? (
    <div className={styles.notice}>文件过大，仅显示前 1 MB。</div>
  ) : null;

  if (kind === "image") {
    const src = `data:${file.mimeType ?? "application/octet-stream"};base64,${file.content}`;
    return (
      <div className={styles.imageWrap}>
        <img className={styles.image} src={src} alt={file.name} />
      </div>
    );
  }

  if (kind === "markdown") {
    return (
      <>
        {notice}
        <div className={styles.markdown}>
          <Markdown text={file.content} />
        </div>
      </>
    );
  }

  if (kind === "code") {
    return (
      <>
        {notice}
        <div className={styles.code}>
          <CodeBlock code={file.content} lang={languageFor(file.name)} />
        </div>
      </>
    );
  }

  return (
    <>
      {notice}
      <pre className={styles.text}>{file.content}</pre>
    </>
  );
}


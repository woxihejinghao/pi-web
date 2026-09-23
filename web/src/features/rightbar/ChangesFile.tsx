import { useMemo, useState } from "react";
import clsx from "clsx";
import type { GitFileEntry } from "../../lib/types.ts";
import { parseUnifiedDiff, type DiffHunk } from "./diff-parse.ts";
import { PlusIcon } from "../../components/icons.tsx";
import { MinusIcon, TreeChevronIcon, UndoIcon } from "./rightbar-icons.tsx";
import { PathLabel } from "./rightbar-path.tsx";
import styles from "./ChangesTab.module.css";

/** Hunk lines a file opens with before its own diffs start collapsed. */
const HUNK_OPEN_LINES = 80;

const STATUS_LABEL: Record<GitFileEntry["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

const STATUS_TITLE: Record<GitFileEntry["status"], string> = {
  modified: "已修改",
  added: "新增",
  deleted: "已删除",
  renamed: "重命名",
  untracked: "未跟踪",
  conflicted: "冲突",
};

/**
 * One file on one side of the change set.
 *
 * The row is the whole control surface for that file: the chevron draws its
 * diff, `+`/`−` moves it between the index and the work tree, and `↺` throws the
 * work-tree copy away (after a confirmation, and never for a file git has not
 * seen — there is no "restore" for something that was never committed).
 *
 * Counts come from the same parse that draws the lines, so a header can never
 * claim `+3 -1` over a diff showing something else.
 *
 * A row starts folded. A change set is usually many files and the useful first
 * answer is the *shape* of it — which files, how big — with the patch one click
 * away; opening the panel is not by itself a request to render every line.
 */
export function ChangesFile({
  file,
  side,
  busy,
  onStage,
  onDiscard,
}: {
  file: GitFileEntry;
  /** Which list the row is in: it decides what the buttons mean. */
  side: "staged" | "unstaged";
  busy: boolean;
  onStage(path: string, staged: boolean): void;
  onDiscard(path: string): void;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(file.patch), [file.patch]);
  const [open, setOpen] = useState(false);

  const discardable = side === "unstaged" && file.status !== "untracked" && file.status !== "conflicted";

  return (
    <section className={styles.file}>
      <div className={styles.fileRow}>
        <button
          type="button"
          className={styles.fileMain}
          aria-expanded={open}
          title={file.path}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={clsx(styles.chevron, open && styles.chevronOpen)}>
            <TreeChevronIcon width={12} height={12} />
          </span>
          <span
            className={clsx(styles.badge, styles[`badge_${file.status}`])}
            title={STATUS_TITLE[file.status]}
          >
            {STATUS_LABEL[file.status]}
          </span>
          <span className={styles.filePath}>
            <PathLabel path={file.path} />
          </span>
          {file.patch.length > 0 && !file.truncated ? (
            <>
              <span className={styles.added}>+{parsed.additions}</span>
              <span className={styles.removed}>-{parsed.deletions}</span>
            </>
          ) : null}
        </button>

        {side === "unstaged" ? (
          <button
            type="button"
            className={styles.rowAction}
            disabled={busy}
            title="暂存这个文件"
            aria-label={`暂存 ${file.path}`}
            onClick={() => onStage(file.path, true)}
          >
            <PlusIcon width={13} height={13} />
          </button>
        ) : (
          <button
            type="button"
            className={styles.rowAction}
            disabled={busy}
            title="取消暂存"
            aria-label={`取消暂存 ${file.path}`}
            onClick={() => onStage(file.path, false)}
          >
            <MinusIcon width={13} height={13} />
          </button>
        )}
        {discardable ? (
          <button
            type="button"
            className={clsx(styles.rowAction, styles.rowActionDanger)}
            disabled={busy}
            title="还原到已提交状态"
            aria-label={`还原 ${file.path}`}
            onClick={() => onDiscard(file.path)}
          >
            <UndoIcon width={13} height={13} />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className={styles.fileBody}>
          <FilePatch file={file} parsed={parsed} />
        </div>
      ) : null}
    </section>
  );
}

/** The patch, or the reason there is none to draw. */
function FilePatch({
  file,
  parsed,
}: {
  file: GitFileEntry;
  parsed: ReturnType<typeof parseUnifiedDiff>;
}) {
  if (file.binary) {
    return <div className={styles.fileNote}>二进制文件，无法显示差异。</div>;
  }
  if (file.status === "untracked") {
    return <div className={styles.fileNote}>未跟踪的新文件，git 没有它的差异。</div>;
  }
  if (file.truncated) {
    return <div className={styles.fileNote}>改动过大，补丁已截断。</div>;
  }
  if (parsed.hunks.length === 0) {
    return <div className={styles.fileNote}>没有可显示的差异。</div>;
  }
  return (
    <div className={styles.patch}>
      {parsed.hunks.map((hunk) => (
        <Hunk key={hunk.header} hunk={hunk} />
      ))}
    </div>
  );
}

/**
 * One hunk, collapsible on its own.
 *
 * A single file can carry several distant hunks, and the interesting one is
 * often the smallest; folding per hunk (rather than per file) is what makes a
 * big diff readable. A hunk long enough to fill the panel starts folded, with
 * its line count on the header so nothing is hidden silently.
 */
function Hunk({ hunk }: { hunk: DiffHunk }) {
  const bodyLines = hunk.lines.filter((line) => line.kind !== "meta");
  const [open, setOpen] = useState(bodyLines.length <= HUNK_OPEN_LINES);

  return (
    <div className={styles.hunk}>
      <button
        type="button"
        className={styles.hunkHeader}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={clsx(styles.chevron, open && styles.chevronOpen)}>
          <TreeChevronIcon width={11} height={11} />
        </span>
        <span className={styles.hunkRange}>{hunk.header}</span>
        <span className={styles.hunkCount}>
          {bodyLines.length} 行{open ? "" : " · 点击展开"}
        </span>
      </button>
      {open
        ? hunk.lines.map((line, index) =>
            line.kind === "meta" ? null : (
              <div
                className={clsx(
                  styles.line,
                  line.kind === "add" && styles.lineAdd,
                  line.kind === "del" && styles.lineDel,
                )}
                key={`${String(index)}:${line.text}`}
              >
                <span className={styles.num}>{line.oldLine ?? ""}</span>
                <span className={styles.num}>{line.newLine ?? ""}</span>
                <span className={styles.marker}>
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                </span>
                <span className={styles.text}>{line.text}</span>
              </div>
            ),
          )
        : null}
    </div>
  );
}

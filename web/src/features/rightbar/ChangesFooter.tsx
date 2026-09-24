import { useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { ArrowUpIcon } from "../../components/icons.tsx";
import type { GitLogEntry, GitStatusView } from "../../lib/types.ts";
import styles from "./ChangesTab.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * The commit box and the push button.
 *
 * Both are about the index: 提交 sends what is staged (never `-a` — staging is
 * the user's decision and the list right above is the receipt), and 推送 sends
 * the branch. The push button says what it would send — a count of commits the
 * upstream does not have — or that this branch has no upstream yet, in which
 * case the server publishes it with `-u`.
 */
export function CommitBar({
  view,
  busy,
  error,
  onCommit,
  onPush,
}: {
  view: GitStatusView;
  busy: boolean;
  error: string | null;
  /** Resolves true when the commit landed, so the box can clear itself. */
  onCommit(message: string): Promise<boolean>;
  onPush(): void;
}) {
  const t = useT();
  const [message, setMessage] = useState("");
  const stagedCount = view.staged.length;
  const canCommit = stagedCount > 0 && message.trim().length > 0 && !busy;

  const submit = (): void => {
    if (!canCommit) return;
    const text = message.trim();
    // The message is cleared only once the commit landed: a rejected commit
    // (no identity configured, a failing hook) must not cost the user what they
    // typed.
    void onCommit(text).then((committed) => {
      if (committed) setMessage("");
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter") return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className={styles.commit}>
      <textarea
        className={styles.commitInput}
        value={message}
        rows={2}
        spellCheck={false}
        placeholder={
          stagedCount > 0
            ? t("footer.commitPlaceholder")
            : t("footer.stageFirst")
        }
        aria-label={t("footer.commitLabel")}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.commitActions}>
        <button
          type="button"
          className={styles.commitButton}
          disabled={!canCommit}
          onClick={submit}
        >
          {stagedCount > 0 ? t("footer.commitFiles", { count: stagedCount }) : t("footer.commit")}
        </button>
        <button
          type="button"
          className={styles.pushButton}
          disabled={busy || view.detached || view.branch === null}
          title={
            view.upstream === null
              ? t("footer.noUpstreamHint")
              : t("footer.pushTo", { upstream: view.upstream })
          }
          onClick={onPush}
        >
          <ArrowUpIcon width={13} height={13} />
          推送
          {view.ahead > 0 ? <span className={styles.pushCount}>{view.ahead}</span> : null}
        </button>
      </div>
      {error !== null ? <div className={styles.commitError}>{error}</div> : null}
    </div>
  );
}

/**
 * Recent commits.
 *
 * `refs` is where the branch and remote-tracking names come from: the first row
 * usually carries `HEAD -> main, origin/main`, which is how a reader can see at
 * a glance whether the branch they are on is the one at the top.
 */
export function HistoryList({ log }: { log: GitLogEntry[] }) {
  const t = useT();
  if (log.length === 0) return null;
  return (
    <div className={styles.history}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>{t("footer.history")}</span>
      </div>
      {log.map((entry) => (
        <div className={styles.logRow} key={entry.hash}>
          <span className={styles.logHash}>{entry.short}</span>
          <span className={styles.logBody}>
            <span className={styles.logSubject} title={entry.subject}>
              {entry.subject}
            </span>
            <span className={styles.logMeta}>
              {entry.refs.map((ref) => (
                <span className={clsx(styles.ref, styles[refClass(ref)])} key={ref}>
                  {ref}
                </span>
              ))}
              {entry.author} · {formatDate(entry.date)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Which colour a decoration gets: HEAD first, then remote-tracking, then tags. */
function refClass(ref: string): "refHead" | "refRemote" | "refTag" {
  if (ref.startsWith("HEAD") || ref.startsWith("tag:")) {
    return ref.startsWith("HEAD") ? "refHead" : "refTag";
  }
  return ref.includes("/") ? "refRemote" : "refHead";
}

/** git's ISO author date, shortened the way the log itself prints it. */
function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${String(parsed.getFullYear())}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}` +
    ` ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { formatMessageTime, formatTokens, formatTurnDuration } from "../../lib/duration.ts";
import type { MessageUsage } from "../../lib/types.ts";
import styles from "./MessageActions.module.css";

/**
 * The row of actions dsh draws under a message: copy, fork, and — for an
 * answer — how much it cost and how long it took.
 *
 * What is deliberately missing is the thumbs up/down pair from the reference
 * screenshot. dsh stores that feedback against a message; pi has no equivalent
 * field and no RPC, so the button would either do nothing or write somewhere
 * nothing reads. A control that cannot change anything is worse than an absent
 * one.
 */
export function MessageActions({
  text,
  usage,
  durationMs,
  timestamp,
  forkEntryId,
  onFork,
  align = "start",
}: {
  /** What the copy button puts on the clipboard. */
  text: string;
  /** Assistant-only. A turn's summed usage. */
  usage?: MessageUsage | null;
  /** Assistant-only. Wall-clock time from the user's message to this turn's end. */
  durationMs?: number | null;
  /** Epoch milliseconds; dsh renders `9月17日 21:00`. */
  timestamp?: number | null;
  /**
   * The entry this message forks from, when there is one. Absent means the
   * button is not offered at all rather than shown disabled: the reason it is
   * missing (no entry id in the transcript, a session read from disk that pi
   * would not fork from) is not something the reader can act on.
   */
  forkEntryId?: string | null;
  onFork?: (entryId: string) => void;
  align?: "start" | "end";
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = (): void => {
    // The clipboard API rejects on a non-secure origin; the shell is served
    // over plain http on localhost, which browsers do treat as secure, but the
    // rejection is still handled so a failure is not a silent no-op.
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className={align === "end" ? `${styles.row} ${styles.rowEnd}` : styles.row}>
      {/*
       * dsh puts the timestamp first on a user message (when it was sent) and
       * last on an answer (when it finished), and it is not worth inventing a
       * third arrangement: the two rows are read in the order they happened.
       */}
      {align === "end" && timestamp != null && (
        <span className={clsx(styles.stat, styles.time)}>{formatMessageTime(timestamp)}</span>
      )}

      <button
        type="button"
        className={styles.action}
        aria-label="复制"
        title="复制"
        onClick={copy}
      >
        <Glyph name="copy" size={16} />
      </button>

      {forkEntryId != null && forkEntryId.length > 0 && onFork !== undefined && (
        <button
          type="button"
          className={styles.action}
          aria-label="从此处分叉"
          title="从此处分叉"
          onClick={() => onFork(forkEntryId)}
        >
          <Glyph name="branch" size={16} />
        </button>
      )}

      {usage != null && (
        <span className={styles.stat} title="本轮所有模型调用累加的 token 数（含缓存读取）">
          <Glyph name="database" size={14} className={styles.statIcon} />
          用量 {formatTokens(usage.totalTokens)} tok
        </span>
      )}

      {durationMs != null && (
        <span className={styles.stat} title="从你的消息发出到本轮结束的墙上时间">
          <Glyph name="clock" size={14} className={styles.statIcon} />
          用时 {formatTurnDuration(durationMs)}
        </span>
      )}

      {timestamp != null && align !== "end" && (
        <span className={clsx(styles.stat, styles.time)}>{formatMessageTime(timestamp)}</span>
      )}

      {copied && <span className={styles.copied}>已复制</span>}
    </div>
  );
}

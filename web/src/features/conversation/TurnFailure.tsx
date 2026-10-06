import styles from "./TurnFailure.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * The row that stands in for an answer pi could not produce: the model request
 * failed and pi either stopped at once or ran out of automatic retries.
 *
 * Unlike `RetryNotice`, this is not live state. It is read from the transcript
 * (the assistant message pi persisted with `stopReason: "error"`), so it
 * survives a reload, a session switch, and a fresh page — the same way the rest
 * of the conversation does. The only thing the stream adds is `attempts`, which
 * a transcript cannot know.
 *
 * Shaped after `RetryNotice` on purpose: the two rows can sit in the same spot
 * one after the other, and a reader who expanded one should find the other
 * familiar. What changes is the colour — a failure is not a shimmer.
 */
export function TurnFailure({
  message,
  attempts,
  onRetry,
}: {
  /** The provider's own words, straight off the failed message. */
  message: string;
  /** Automatic retries pi made before giving up; 0 when it never tried. */
  attempts: number;
  /**
   * Re-send the turn. Absent when the conversation cannot take it back — no
   * session yet, or a transcript opened read-only — rather than shown disabled:
   * the reason is not something the reader can act on.
   */
  onRetry?: (() => void) | undefined;
}) {
  const t = useT();
  const title = attempts > 0 ? t("failure.afterRetries", { count: attempts }) : t("failure.title");
  // pi sets `errorMessage` wherever it stamps `stopReason: "error"`, but not in
  // every path it can do so from, and a disclosure that unfolds onto nothing is
  // worse than no disclosure.
  const summary = (
    <span className={styles.failureText} role="status">
      {title}
    </span>
  );

  return (
    <div className={styles.failureRow}>
      {message ? (
        <details className={styles.failureDisclosure}>
          <summary className={styles.failureSummary}>{summary}</summary>
          <div className={styles.failureDetails}>
            <div>
              <span className={styles.failureDetailLabel}>{t("retry.reason")}</span>
              {message}
            </div>
          </div>
        </details>
      ) : (
        summary
      )}
      {onRetry ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          {t("common.retry")}
        </button>
      ) : null}
    </div>
  );
}

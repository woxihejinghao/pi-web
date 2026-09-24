import { useEffect, useState } from "react";
import { secondsUntil } from "../../lib/duration.ts";
import type { RetryState } from "./useConversation.ts";
import styles from "./RetryNotice.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * The line that explains a silent stretch while pi retries a failed model
 * request.
 *
 * Ported from dsh's `ModelRetryItem`. Same `<details>` shape, same countdown,
 * same shimmer once the wait is over — so a throttle or a dropped connection
 * reads as "waiting 12s then trying again" instead of a frozen turn.
 *
 * One deliberate difference: dsh keeps a seconds figure on screen while the
 * retry is in flight, but it always computes to `1s` (its helper clamps at 1 and
 * the deadline has already passed). Printing a number that never changes would
 * be worse than printing none, so the in-flight state drops the clock and keeps
 * only the attempt counter.
 */
export function RetryNotice({ retry }: { retry: RetryState }) {
  const t = useT();
  const [remaining, setRemaining] = useState(() => secondsUntil(retry.deadline));
  const waiting = remaining > 0;

  useEffect(() => {
    setRemaining(secondsUntil(retry.deadline));
    if (secondsUntil(retry.deadline) <= 0) return;
    const id = window.setInterval(() => {
      setRemaining(secondsUntil(retry.deadline));
    }, 1000);
    return () => window.clearInterval(id);
  }, [retry.deadline]);

  const label = waiting ? t("retry.waiting") : t("retry.retrying");
  const counter = `${retry.attempt}/${retry.maxAttempts}`;

  return (
    <details className={styles.retryRow} data-active={waiting ? undefined : true}>
      <summary className={styles.retrySummary}>
        <span className={styles.retryText} role="status">
          {waiting ? `${label}（${counter}） · ${remaining}s` : `${label}（${counter}）`}
        </span>
      </summary>
      <div className={styles.retryDetails}>
        <div>
          <span className={styles.retryDetailLabel}>{t("retry.delay")}</span>
          {`${Math.round(retry.delayMs)}毫秒`}
        </div>
        {retry.errorMessage ? (
          <div>
            <span className={styles.retryDetailLabel}>{t("retry.reason")}</span>
            {retry.errorMessage}
          </div>
        ) : null}
      </div>
    </details>
  );
}

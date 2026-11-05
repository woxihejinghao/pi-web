import { useEffect, useState } from "react";
import { useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { terminalActions, terminalStore } from "./terminal-state.ts";
import styles from "./TerminalCleanup.module.css";

/**
 * Closes that removed the tab but could not end the process.
 *
 * The tab is already gone when this appears — the user asked for it to be gone —
 * so hiding the failure would leave a shell running where nothing can reach it.
 * A retry is enough because the host keeps the identity until `kill` succeeds.
 */
export function TerminalCleanup({ sessionPath }: { sessionPath: string }) {
  const t = useT();
  const failures = useStore(terminalStore).cleanup;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    void terminalActions.refreshCleanup().catch(() => {});
  }, [sessionPath]);

  // Failures are host-wide; the banner belongs to the panel, not to one session.
  const visible = failures.filter((failure) => !dismissed.has(failure.id));
  if (visible.length === 0) return null;

  return (
    <div className={styles.stack} role="status">
      {visible.map((failure) => (
        <div key={failure.id} className={styles.item}>
          <span className={styles.text}>
            {t("terminal.closeFailed", { message: failure.message })}
          </span>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              void terminalActions
                .retryCleanup(failure.id)
                .catch(() => {})
                .finally(() => {
                  // A failure that survives the retry stays visible; one that
                  // did not is dropped from the store by `refreshCleanup`.
                });
            }}
          >
            {t("terminal.retryClose")}
          </button>
          <button
            type="button"
            className={styles.dismiss}
            aria-label={t("terminal.dismiss")}
            onClick={() => {
              setDismissed((current) => new Set(current).add(failure.id));
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

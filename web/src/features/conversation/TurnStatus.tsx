import { useEffect, useState } from "react";
import { formatRunDuration } from "../../lib/duration.ts";
import { useT } from "../../lib/app-state.ts";
import styles from "./TurnStatus.module.css";

/**
 * The shimmering "working..." label under a turn that is still running.
 *
 * Ported from dsh's `TurnStatus`. Three details are load-bearing:
 *
 * - The label is *not* tied to token streaming. dsh keeps it up across the
 *   pre-first-token, tool-execution, and streaming phases alike, so the turn
 *   always has a visible heartbeat. We mount it for the whole `agent_start` →
 *   `agent_settled` window, which is the same span.
 * - The clock stays hidden for the first 15 seconds. Most turns finish before
 *   that, and a timer that appears and vanishes in a second is just noise.
 * - The shimmer is moving text, not a spinner: the string itself is painted with
 *   a gradient (`background-clip: text`, transparent fill) that slides across,
 *   so it costs no layout and keeps the line-height of ordinary text.
 */
export function TurnStatus({ startTime }: { startTime?: number | undefined }) {
  const t = useT();
  const [mountedAt] = useState(() => Date.now());
  const anchor = startTime ?? mountedAt;
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor));

  useEffect(() => {
    const tick = (): void => setElapsedMs(Math.max(0, Date.now() - anchor));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [anchor]);

  const showClock = elapsedMs >= 15_000;

  return (
    <div className={styles.turnStatus} role="status" aria-live="polite">
      working...
      {showClock ? (
        // Announced state is the shimmer text; a ticking number would make
        // screen readers re-announce every second.
        <span className={styles.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t)}
        </span>
      ) : null}
    </div>
  );
}

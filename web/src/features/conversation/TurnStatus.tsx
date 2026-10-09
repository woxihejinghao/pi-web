import { useEffect, useState } from "react";
import { useT } from "../../lib/app-state.ts";
import { PI_MARK_URL } from "../../lib/brand.ts";
import { formatRunDuration } from "../../lib/duration.ts";
import styles from "./TurnStatus.module.css";

/**
 * The shimmering running label under a turn that is still running, with the
 * hairline dsh draws above it and pi's own mark in front.
 *
 * Ported from dsh's `RunningStatus` (`ChatView.module.css`). Three details are
 * load-bearing:
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
/**
 * pi's own mark — the same artwork the sidebar brand and the desktop icon
 * draw — in the running row's icon box. dsh puts its whale tail here; this is
 * whose agent is working. The bitmap is square, so the radius below keeps it a
 * tile at this size instead of a stamp.
 */
function PiMark() {
  return <img className={styles.mark} src={PI_MARK_URL} alt="" draggable={false} />;
}

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
    <div className={styles.running} role="status" aria-live="polite">
      {/* dsh draws a hairline above the running label — the boundary between
          the work so far and the clock still counting (its `runningDivider`). */}
      <span className={styles.divider} aria-hidden />
      <span className={styles.content}>
        <PiMark />
        <span className={styles.status}>{t("turn.working")}</span>
        {showClock ? (
          // Announced state is the shimmer text; a ticking number would make
          // screen readers re-announce every second.
          <span className={styles.clock} aria-hidden>
            {formatRunDuration(elapsedMs, t)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { formatTokens } from "../../lib/duration.ts";
import type { ComposerContext } from "../../lib/types.ts";
import { StatPanel, StatRow } from "./StatPanel.tsx";
import styles from "./ContextMeter.module.css";

/** Radius and circumference of the ring in its 16px viewBox. */
const RADIUS = 6.4;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ContextMeterProps {
  context: ComposerContext | null;
  /**
   * Called when the panel opens without a figure to show. The context estimate
   * is only authoritative inside a running pi, so this is where a session that
   * was read from disk pays one cold start — at the user's request, rather than
   * on every sidebar click.
   */
  onRequestLive(): void;
}

/**
 * How full the context window is, as a ring next to the send button.
 *
 * The ring is a progress arc rather than a number because it sits in a toolbar
 * where horizontal space is contested: the figure itself is one click away in the
 * panel, and the shape answers "am I near the limit?" without being read.
 *
 * A ring with no arc is the honest rendering of "unknown" — pi reports a null
 * token count right after a compaction, and a session read from disk may have no
 * `contextWindow` to measure against. Nothing is drawn at all only when there is
 * no model to describe.
 */
export function ContextMeter({ context, onRequestLive }: ContextMeterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // Same dismissal contract as the stat pills: outside pointer or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (context === null) {
    return (
      <span className={styles.anchor} ref={rootRef}>
        <button
          type="button"
          className={styles.button}
          aria-label="上下文用量未知"
          title="上下文用量未知"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) onRequestLive();
          }}
        >
          <Ring percent={null} />
        </button>
        {open ? (
          <StatPanel align="end" icon={<Ring percent={null} />} title="上下文" note="这个会话还没有可用的上下文用量。">
            <StatRow label="上下文窗口" value="未知" />
          </StatPanel>
        ) : null}
      </span>
    );
  }

  const percent = context.percent;
  const label =
    percent === null || context.tokens === null
      ? "上下文用量未知"
      : `上下文 ${formatPercent(percent)}% · ${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}`;

  return (
    <span className={styles.anchor} ref={rootRef}>
      <button
        type="button"
        className={styles.button}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && context.tokens === null) onRequestLive();
        }}
      >
        <Ring percent={percent} />
      </button>
      {open ? (
        <StatPanel
          align="end"
          icon={<Ring percent={percent} />}
          title="上下文"
          value={
            context.tokens === null
              ? undefined
              : `${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}`
          }
          note="已用是 pi 的估算：最后一次模型回复上报的用量，加上其后每条消息的字符估算。刚压缩完时会短暂显示为未知，直到下一次回复。"
        >
          <StatRow label="上下文窗口" value={`${formatTokens(context.contextWindow)} tok`} />
          <StatRow
            label="已用"
            value={
              context.tokens === null
                ? "未知"
                : percent === null
                  ? `${formatTokens(context.tokens)} tok`
                  : `${formatTokens(context.tokens)} tok（${formatPercent(percent)}%）`
            }
          />
          <StatRow
            label="剩余"
            value={
              context.tokens === null
                ? "未知"
                : `${formatTokens(Math.max(0, context.contextWindow - context.tokens))} tok`
            }
          />
        </StatPanel>
      ) : null}
    </span>
  );
}

/**
 * Whole percents from ten up, one decimal below — the same shape dsh uses for
 * its cache-hit figure, and the same reason: rounding 0.6% to "1%" overstates
 * what was used, while rounding it to "0%" claims nothing was.
 */
function formatPercent(percent: number): string {
  const clamped = Math.max(0, percent);
  if (clamped > 0 && clamped < 1) return "<1";
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/**
 * The ring itself. `percent === null` draws the track only, which is how "no
 * figure" looks: an empty gauge, not a full one.
 */
function Ring({ percent }: { percent: number | null }) {
  const shown = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const tone =
    shown >= 90 ? styles.ringCritical : shown >= 75 ? styles.ringWarning : undefined;
  return (
    <svg
      className={clsx(styles.ring, tone)}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle
        className={styles.track}
        cx={8}
        cy={8}
        r={RADIUS}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      {shown > 0 ? (
        <circle
          cx={8}
          cy={8}
          r={RADIUS}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={`${(CIRCUMFERENCE * shown) / 100} ${CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
        />
      ) : null}
    </svg>
  );
}

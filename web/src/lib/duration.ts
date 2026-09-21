/**
 * `{minutes}分{seconds}秒` / `{seconds}秒` — the zh-CN `duration.*` templates
 * dsh uses for a running turn's clock.
 *
 * Seconds are zero-padded once minutes appear so the label does not change
 * width every second (the element is `tabular-nums`, but padding keeps the
 * string itself stable too).
 */
export function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}

/**
 * Whole seconds remaining until a deadline, rounded up so the last second still
 * shows `1s` rather than jumping to zero early. Zero (or past) means "now".
 *
 * dsh clamps this at 1 instead, which is why its in-flight retry row always
 * reads `1s`; zero is the more useful floor because it gives the caller a
 * distinct "the wait is over" state to branch on.
 */
export function secondsUntil(deadline: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * Compact duration, dsh's `formatDuration` in its zh locale:
 * `duration.compactSeconds` = "{seconds}秒" below a minute,
 * `duration.compactMinutes` = "{minutes}分{seconds}秒" from there on.
 *
 * The sub-minute branch keeps one decimal (42.5秒) exactly as dsh does, which
 * is why this is not `Math.round`.
 */
export function formatTurnDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}秒`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}分${whole % 60}秒`;
}

/**
 * Token counts the way dsh labels them ("760K tok"): plain below a thousand,
 * one decimal from a million up.
 *
 * The number is a turn's summed prompt+output across every model call in it,
 * including cache reads, so it grows with the conversation rather than with the
 * visible answer — a 400-token reply on a 30k-token context reports ~30k.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${Math.round(count / 1000)}K`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** A message timestamp as dsh shows it: `9月17日 21:00`. */
export function formatMessageTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

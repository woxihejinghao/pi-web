import type { Translate, UiLanguage } from "./i18n/index.ts";

/**
 * `{minutes}分{seconds}秒` / `{seconds}秒` — the `duration.*` templates, with
 * dsh's zh-CN wording kept as the source table and `1m 05s` / `5s` as the
 * English rendering.
 *
 * Seconds are zero-padded once minutes appear so the label does not change
 * width every second (the element is `tabular-nums`, but padding keeps the
 * string itself stable too).
 *
 * `t` comes in as an argument rather than from a hook: this is called from list
 * rows and pills that already hold the translator, and keeping it a plain
 * function is what lets the duration tests pin a language explicitly.
 */
export function formatRunDuration(ms: number, t: Translate): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0
    ? t("duration.minutesSeconds", { minutes, seconds: String(seconds).padStart(2, "0") })
    : t("duration.seconds", { seconds });
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
export function formatTurnDuration(ms: number, t: Translate): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return t("duration.secondsDecimal", { seconds: Math.round(seconds * 10) / 10 });
  }
  const whole = Math.round(seconds);
  return t("duration.minutesSeconds", { minutes: Math.floor(whole / 60), seconds: whole % 60 });
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

/**
 * Month names for the English rendering. Written out rather than delegated to
 * `Intl.DateTimeFormat` so the label is the same in every browser and in the
 * node test run — the format is fixed, only the language varies.
 */
const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A message timestamp as dsh shows it: `9月17日 21:00`, or `Sep 17, 21:00`. */
export function formatMessageTime(timestamp: number, language: UiLanguage): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return language === "zh-CN"
    ? `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
    : `${EN_MONTHS[d.getMonth()]} ${d.getDate()}, ${hh}:${mm}`;
}

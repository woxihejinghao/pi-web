import type { Translate } from "./i18n/index.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative time, matching dsh's sidebar: `刚刚` / `12分钟` / `3小时`
 * / `7天`. Short enough to sit in a narrow row without truncating the title.
 *
 * `t` is passed in rather than pulled from a hook so this stays a plain
 * function: it runs inside a list row that already has the translator, and the
 * English table maps the same units to `12m` / `3h` / `7d`.
 */
export function formatRelativeTime(iso: string, t: Translate): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < MINUTE) return t("time.justNow");
  if (diff < HOUR) return t("time.minutes", { count: Math.floor(diff / MINUTE) });
  if (diff < DAY) return t("time.hours", { count: Math.floor(diff / HOUR) });
  if (diff < 30 * DAY) return t("time.days", { count: Math.floor(diff / DAY) });
  if (diff < 365 * DAY) return t("time.months", { count: Math.floor(diff / (30 * DAY)) });
  return t("time.years", { count: Math.floor(diff / (365 * DAY)) });
}

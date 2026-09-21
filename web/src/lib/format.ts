const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative time, matching dsh's sidebar: `刚刚` / `12分钟` / `3小时`
 * / `7天`. Short enough to sit in a narrow row without truncating the title.
 */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}天`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}个月`;
  return `${Math.floor(diff / (365 * DAY))}年`;
}

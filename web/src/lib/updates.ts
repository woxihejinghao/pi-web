import type { ExtensionUpdate, PiVersionInfo, UpdatesView } from "./types.ts";

/**
 * Pure projections of the update payload.
 *
 * Three surfaces read the same answer — the sidebar badge, the settings page's
 * 关于 rows, and the plugins page's rows and summary — so the wording and the
 * matching rule live here rather than being re-derived in each of them. Nothing
 * here touches React or the store, which is what lets the rule be tested on its
 * own.
 */

/**
 * The update row for one installed package.
 *
 * Matching is by pi's own source string: `checkForAvailableUpdates` reports the
 * source exactly as pi's settings record it, and `ExtensionItem.source` is that
 * same string — the only identity the two lists share. A multi-entry package
 * contributes several extension rows but one update row, so all of them light
 * up together, which is correct: updating the package updates every entry.
 */
export function updateForSource(
  view: UpdatesView | null,
  source: string,
): ExtensionUpdate | null {
  if (view === null) return null;
  return view.extensions.find((entry) => entry.source === source) ?? null;
}

/** How many installed packages are behind their upstream. */
export function extensionUpdateCount(view: UpdatesView | null): number {
  return view?.extensions.length ?? 0;
}

/**
 * True when anything is behind: pi itself or one of its packages. This is the
 * sidebar badge's question — it should appear for either reason.
 */
export function hasAnyUpdate(view: UpdatesView | null): boolean {
  if (view === null) return false;
  return view.pi.available || view.extensions.length > 0;
}

/**
 * The pi row's status.
 *
 * The order matters: a skipped or failed check must not fall through to "已是最新",
 * because that string is a claim about the world and these states do not know
 * it. `null` means the answer has not arrived yet.
 */
export function piVersionStatus(info: PiVersionInfo | null): string {
  if (info === null) return "正在检查…";
  if (info.skipped) return "已跳过检查";
  if (info.error !== null) return "无法检查更新";
  if (info.available) {
    return info.latest === null ? "有新版本可用" : `有新版本 ${info.latest}`;
  }
  return "已是最新";
}

/** The plugins summary line. Same rule about not overclaiming as above. */
export function extensionUpdateStatus(view: UpdatesView | null): string {
  if (view === null) return "正在检查…";
  if (view.extensionsError !== null) return "无法检查更新";
  const count = extensionUpdateCount(view);
  if (count === 0) return "已是最新";
  return `${count} 个插件可更新`;
}

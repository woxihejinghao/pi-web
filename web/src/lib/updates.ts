import type { ExtensionUpdate, PiVersionInfo, UpdatesView } from "./types.ts";
import type { Translate } from "./i18n/index.ts";

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
export function piVersionStatus(info: PiVersionInfo | null, t: Translate): string {
  if (info === null) return t("updates.checking");
  if (info.skipped) return t("updates.skipped");
  if (info.error !== null) return t("updates.failed");
  if (info.available) {
    return info.latest === null
      ? t("updates.available")
      : t("updates.availableVersion", { version: info.latest });
  }
  return t("updates.upToDate");
}

/** The plugins summary line. Same rule about not overclaiming as above. */
export function extensionUpdateStatus(view: UpdatesView | null, t: Translate): string {
  if (view === null) return t("updates.checking");
  if (view.extensionsError !== null) return t("updates.failed");
  const count = extensionUpdateCount(view);
  if (count === 0) return t("updates.upToDate");
  return t("updates.pluginsAvailable", { count });
}

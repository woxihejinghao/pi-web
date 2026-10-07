/**
 * Which device and which shell this page is running in.
 *
 * Both answers are needed before a default binding can be chosen: the device
 * decides what `primary` means and how a keycap is drawn, and the shell decides
 * which column of defaults applies at all.
 */
import { desktopBridge } from "../desktop.ts";
import type { ShortcutPlatform, ShortcutRuntime } from "./binding.ts";

export interface ShortcutEnvironment {
  readonly runtime: ShortcutRuntime;
  readonly platform: ShortcutPlatform;
}

/** What detecting the environment is allowed to look at. */
export interface EnvironmentSignals {
  /** `window.piWebDesktop.platform`, or null in a browser. */
  readonly desktopPlatform: string | null;
  /**
   * `navigator.userAgent`.
   *
   * The UA alone is enough to name the OS — it says "Mac OS X", "Windows NT" or
   * "X11; Linux" on every engine — and it is read instead of the deprecated
   * `navigator.platform` for that reason, the same reason dsh prefers a value
   * its own shell injects over either.
   */
  readonly userAgent: string;
}

/**
 * Detect the visiting device — never the server's operating system.
 *
 * dsh's Electron preload stamps `data-platform` on the document element and its
 * detector reads that attribute. This app's preload already exposes the same
 * fact as `window.piWebDesktop.platform`, so that is read instead of adding a
 * second mechanism for one bit.
 */
export function detectEnvironment(signals: EnvironmentSignals): ShortcutEnvironment {
  const desktop = signals.desktopPlatform;
  // macOS is tested first because "Darwin" contains "win".
  const device = desktop ?? signals.userAgent;
  return {
    runtime: desktop === null ? "web" : "desktop",
    platform: /darwin|mac|iphone|ipad/iu.test(device)
      ? "macos"
      : /win/iu.test(device)
        ? "windows"
        : "linux",
  };
}

let cached: ShortcutEnvironment | null = null;

/**
 * The environment, detected once.
 *
 * Cached for the life of the page because neither answer can change while it
 * lives: the device is the device, and a bundle is either wrapped by the shell
 * or it is not. Keycap hints are read during render, so this runs often enough
 * to be worth not repeating.
 */
export function environment(): ShortcutEnvironment {
  if (cached !== null) return cached;
  cached = detectEnvironment({
    desktopPlatform: desktopBridge()?.platform ?? null,
    // Tolerant of a missing navigator for the node test environment's sake. A
    // browser always has one; an unrecognizable device lands on the plainest
    // defaults either way, so there is nothing here to tell apart.
    userAgent: typeof navigator === "undefined" ? "" : (navigator.userAgent ?? ""),
  });
  return cached;
}

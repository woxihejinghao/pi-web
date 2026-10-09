/**
 * The desktop shell's preload bridge, as the web bundle sees it.
 *
 * `desktop/src/preload.cts` freezes this object onto the window; a browser page
 * never has it. That file keeps the shape deliberately data-only — no Node — so
 * a feature can branch on being wrapped without the shell becoming a dependency
 * of the UI. The one function (`getPathForFile`) is a string lookup, not a
 * channel: a browser cannot name the folder a user dragged in, and a shell can.
 *
 * The interface is restated here rather than imported: the desktop package is a
 * separate build with its own tsconfig and no exported types entry, and two
 * fields are cheaper to keep in step than a build ordering to maintain.
 */
export interface PiWebDesktopBridge {
  readonly isDesktop: true;
  /** `process.platform` of the machine running the shell: `darwin`, `win32`… */
  readonly platform: string;
  readonly electronVersion: string;
  /**
   * Absolute path of a dropped `File`. Optional because a shell older than the
   * feature ships the same bridge without it; see `pathForFile`.
   */
  readonly getPathForFile?: (file: File) => string;
}

declare global {
  interface Window {
    /** Absent in a browser, and absent for a page that is not the shell's. */
    readonly piWebDesktop?: PiWebDesktopBridge;
  }
}

/** The bridge, or null when this page is not running inside the desktop window. */
export function desktopBridge(): PiWebDesktopBridge | null {
  if (typeof window === "undefined") return null;
  return window.piWebDesktop ?? null;
}

/**
 * Mirror the shell's platform onto `<html data-platform>` so stylesheets can
 * scope desktop-only presentation.
 *
 * CSS selectors cannot read `window.piWebDesktop`, so the one fact shortcut
 * detection takes from the bridge has to be republished as an attribute for
 * the one consumer that has no other way to see it: the macOS sidebar tint,
 * which is translucent so the window's vibrancy material shows through (see
 * `theme/index.css` and `layout/AppLayout.module.css`).
 *
 * A browser leaves the attribute off, which is exactly the condition those
 * rules test — the plain web bundle therefore keeps the opaque sidebar and
 * never grows a desktop-only branch. dsh's own preload stamps the same
 * attribute for the same reason; this one only sets it from the page because
 * the shell's preload is deliberately DOM-free (see `desktop/src/preload.cts`).
 */
export function markDocumentPlatform(): void {
  const bridge = desktopBridge();
  if (bridge === null || typeof document === "undefined") return;
  document.documentElement.dataset.platform = bridge.platform;
}

/**
 * The absolute path behind a dropped file, or null.
 *
 * Only the shell can answer this. A browser deliberately hides where a dragged
 * file or folder lives — `DataTransfer` carries bytes and a name, never a
 * location — which is the same wall the picker's server-side listing exists to
 * go around. Callers that get null fall back to whatever else the drop offers.
 */
export function pathForFile(file: File): string | null {
  const read = desktopBridge()?.getPathForFile;
  if (!read) return null;
  try {
    return read(file) || null;
  } catch {
    // The bridge call crosses an isolated world; a rejected argument is a miss,
    // not an error the drop handler should surface.
    return null;
  }
}

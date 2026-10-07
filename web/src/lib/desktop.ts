/**
 * The desktop shell's preload bridge, as the web bundle sees it.
 *
 * `desktop/src/preload.cts` freezes this object onto the window; a browser page
 * never has it. That file keeps the shape deliberately data-only — no
 * `ipcRenderer`, no Node — so a feature can branch on being wrapped without
 * the shell becoming a dependency of the UI.
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

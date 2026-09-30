/**
 * Preload for the desktop window.
 *
 * The web UI is the same bundle the browser gets, so nothing here may be
 * required for it to work — the bridge only *adds* a flag the UI can read
 * (`window.piWebDesktop`) if it ever wants to branch on being wrapped. Keeping
 * it to a frozen, data-only object is the point: no `ipcRenderer`, no Node.
 */
import { contextBridge } from "electron";

export interface PiWebDesktopBridge {
  readonly isDesktop: true;
  readonly platform: NodeJS.Platform;
  readonly electronVersion: string;
}

const bridge: PiWebDesktopBridge = Object.freeze({
  isDesktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron ?? "unknown",
});

contextBridge.exposeInMainWorld("piWebDesktop", bridge);

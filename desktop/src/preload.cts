/**
 * Preload for the desktop window.
 *
 * The web UI is the same bundle the browser gets, so nothing here may be
 * required for it to work — the bridge only *adds* what the UI can read
 * (`window.piWebDesktop`) if it ever wants to branch on being wrapped: a couple
 * of flags, plus the one thing a browser is not allowed to answer at all, the
 * absolute path behind a dropped file. Even that is a function, not a channel:
 * `webUtils` reads the path inside this process and hands back a string, so the
 * page never gets `ipcRenderer` or Node.
 */
import { contextBridge, webUtils } from "electron";

/**
 * The renderer's `File`, spelled through `webUtils` rather than the DOM type:
 * this package compiles without the DOM lib, so `File` is not a name here.
 */
type DroppedFile = Parameters<typeof webUtils.getPathForFile>[0];

export interface PiWebDesktopBridge {
  readonly isDesktop: true;
  readonly platform: NodeJS.Platform;
  readonly electronVersion: string;
  /**
   * The absolute path of a `File` the user dropped on the page — something a
   * plain browser cannot report for a dragged folder (and never reports for a
   * dragged file either). Empty when Electron has no path to give.
   *
   * The parameter type is spelled through `webUtils` rather than as `File`
   * because this package compiles without the DOM lib; the shape the renderer
   * passes is the same `File` from its `DataTransfer`.
   */
  getPathForFile(file: DroppedFile): string;
}

const bridge: PiWebDesktopBridge = Object.freeze({
  isDesktop: true,
  platform: process.platform,
  electronVersion: process.versions.electron ?? "unknown",
  getPathForFile: (file: DroppedFile): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      // A transparently-crossed argument (or a platform without the API) is not
      // worth failing a drop over; the caller falls back to the folder's name.
      return "";
    }
  },
});

contextBridge.exposeInMainWorld("piWebDesktop", bridge);

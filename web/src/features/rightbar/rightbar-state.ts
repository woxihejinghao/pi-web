import { createStore, type Store } from "../../lib/store.ts";

/**
 * The right sidebar's state, mirroring dsh's per-session surface.
 *
 * One surface (tabs, presentation, width, open/closed) belongs to each session
 * path, so switching sessions shows that session's own panel instead of
 * carrying one session's file tree into another's. The store is React-free like
 * `app-state`, and the panel component is the only thing that reads it.
 */

export type RightbarTabKind = "files" | "preview" | "changes" | "browser";

export interface RightbarTab {
  id: string;
  kind: RightbarTabKind;
  title: string;
  /**
   * What the tab is about: a project-relative path for `preview`, an HTTP(S)
   * URL for `browser`, and nothing for `files` (which needs no address).
   */
  target: string;
  /** `browser` only: the tab's history, newest last. */
  history?: string[];
  /** `browser` only: the position inside that history. */
  historyIndex?: number;
}

export interface RightbarSurface {
  open: boolean;
  mode: "push" | "fullscreen";
  width: number;
  tabs: RightbarTab[];
  activeTabId: string | null;
}

/** Width bounds mirror the range a conversation can spare on a laptop screen. */
export const WIDTH_MIN = 300;
export const WIDTH_MAX = 900;
export const WIDTH_DEFAULT = 420;

const STORAGE_PREFIX = "pi-web-simple.rightbar.v1.";

const EMPTY_SURFACE: RightbarSurface = {
  open: false,
  mode: "push",
  width: WIDTH_DEFAULT,
  tabs: [],
  activeTabId: null,
};

/**
 * Draft sessions (`draft:…`) exist only in the browser until their pi process
 * answers with a real path, so nothing is persisted for them — the layout would
 * be restored under a path that never appears again. The panel itself still
 * works while the draft is on screen; it just starts fresh next time.
 */
function isPersistable(key: string): boolean {
  return key.length > 0 && !key.startsWith("draft:");
}

function storage(): Storage | null {
  // Absent in the node test environment, and unavailable under a browser's
  // "block third-party storage" setting — both are "no persistence", not an
  // error the panel should surface.
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Narrow stored JSON back into a surface, dropping anything unrecognizable. */
function parseSurface(raw: string): RightbarSurface | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const tabs: RightbarTab[] = [];
  if (Array.isArray(record.tabs)) {
    for (const entry of record.tabs) {
      if (typeof entry !== "object" || entry === null) continue;
      const tab = entry as Record<string, unknown>;
      // "diff" was this tab's kind before it grew staging, committing and
      // history; a layout saved under the old name is adopted rather than
      // dropped, and re-titled for free.
      const kind = tab.kind === "diff" ? "changes" : tab.kind;
      if (kind !== "files" && kind !== "preview" && kind !== "changes" && kind !== "browser") {
        continue;
      }
      if (typeof tab.id !== "string" || typeof tab.title !== "string") continue;
      tabs.push({
        id: tab.id,
        kind,
        title: tab.title,
        target: typeof tab.target === "string" ? tab.target : "",
        ...(kind === "browser" && Array.isArray(tab.history)
          ? { history: tab.history.filter((item): item is string => typeof item === "string") }
          : {}),
        ...(kind === "browser" && typeof tab.historyIndex === "number"
          ? { historyIndex: tab.historyIndex }
          : {}),
      });
    }
  }
  const width = typeof record.width === "number" ? clampWidth(record.width) : WIDTH_DEFAULT;
  // A restored surface never reopens the panel: the panel is opened by a click
  // in the conversation header, and a page load that popped a panel open would
  // be reopening something the user did not ask for.
  const active =
    typeof record.activeTabId === "string" &&
    tabs.some((tab) => tab.id === record.activeTabId)
      ? record.activeTabId
      : (tabs[0]?.id ?? null);
  return {
    open: false,
    mode: record.mode === "fullscreen" ? "fullscreen" : "push",
    width,
    tabs,
    activeTabId: active,
  };
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return WIDTH_DEFAULT;
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(width)));
}

function loadSurface(key: string): RightbarSurface {
  if (!isPersistable(key)) return EMPTY_SURFACE;
  const store = storage();
  if (store === null) return EMPTY_SURFACE;
  const raw = store.getItem(STORAGE_PREFIX + key);
  if (raw === null) return EMPTY_SURFACE;
  return parseSurface(raw) ?? EMPTY_SURFACE;
}

export interface RightbarState {
  /** One surface per session path; a missing key means "not loaded yet". */
  surfaces: Record<string, RightbarSurface>;
}

export const rightbarStore: Store<RightbarState> = createStore({ surfaces: {} });

/** Test seam: drop every surface and the storage behind it. */
export function resetRightbarState(): void {
  rightbarStore.set({ surfaces: {} });
}

function surfaceOf(state: RightbarState, key: string): RightbarSurface {
  return state.surfaces[key] ?? loadSurface(key);
}

/**
 * Write one surface back.
 *
 * `persist: false` is for the pointer-move frames of a width drag: the layout
 * follows the pointer live, and only the release is worth a localStorage write.
 */
function commit(key: string, surface: RightbarSurface, persist = true): void {
  rightbarStore.update((state) => ({
    surfaces: { ...state.surfaces, [key]: surface },
  }));
  if (!persist || !isPersistable(key)) return;
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_PREFIX + key, JSON.stringify(surface));
  } catch {
    // A full or disabled storage must not break the panel; the surface stays
    // correct in memory for as long as the page lives.
  }
}

let tabCounter = 0;

function nextTabId(kind: RightbarTabKind): string {
  tabCounter += 1;
  return `${kind}-${String(tabCounter)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function makeFilesTab(): RightbarTab {
  return { id: nextTabId("files"), kind: "files", title: "文件", target: "" };
}

export function makePreviewTab(path: string): RightbarTab {
  const title = path.split("/").pop() ?? path;
  return { id: nextTabId("preview"), kind: "preview", title, target: path };
}

export function makeChangesTab(): RightbarTab {
  return { id: nextTabId("changes"), kind: "changes", title: "文件变更", target: "" };
}

export function makeBrowserTab(url: string): RightbarTab {
  const title = url.length > 0 ? hostOf(url) : "浏览器";
  return {
    id: nextTabId("browser"),
    kind: "browser",
    title,
    target: url,
    history: url.length > 0 ? [url] : [],
    historyIndex: url.length > 0 ? 0 : -1,
  };
}

/** The host a browser tab is titled after; falls back to the raw input. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The scheme a bare host is given.
 *
 * dsh assumes HTTPS for every scheme-less address. This app parts company for
 * loopback: the page this tab exists for is a local dev server, an HTTPS URL to
 * one can never work, and "type the scheme yourself" is a poor answer to the
 * most common input the field receives. Everything else still assumes HTTPS.
 */
function schemeFor(hostAndPort: string): "http" | "https" {
  const name = hostnameOf(hostAndPort).toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return "http";
  if (name === "::1" || name.startsWith("127.")) return "http";
  return "https";
}

/** The host part of `host[:port]`, with an IPv6 literal unwrapped. */
function hostnameOf(hostAndPort: string): string {
  if (hostAndPort.startsWith("[")) {
    const end = hostAndPort.indexOf("]");
    return end === -1 ? hostAndPort.slice(1) : hostAndPort.slice(1, end);
  }
  return hostAndPort.split(":")[0] ?? "";
}

/**
 * The address bar's input to an absolute URL, or null when it cannot be one.
 *
 * A bare host is completed with a scheme (see `schemeFor`), which is what makes
 * `localhost:5173` — the case this tab exists for — work without typing one.
 * Anything that carries some other scheme is refused rather than handed to an
 * iframe or to `window.open`: `file:`, `data:` and `javascript:` are the reason
 * an address bar needs a rule at all, and "no answer" is the right answer for
 * them.
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return parseHttpUrl(trimmed);
  }

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(trimmed);
  if (scheme !== null && !/^\d+([/?#].*)?$/.test(scheme[2]!)) {
    // Anything that names a scheme and is not http(s): `file:`, `data:`,
    // `javascript:`, `mailto:`. A purely numeric remainder (`localhost:5173`)
    // is a port, not a payload, so it skips this.
    return null;
  }

  const host = trimmed.split(/[/?#]/)[0] ?? trimmed;
  return parseHttpUrl(`${schemeFor(host)}://${trimmed}`);
}

/** The last gate every candidate URL has to pass. */
function parseHttpUrl(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname.length === 0) return null;
  // Embedded credentials in an address the user typed are a phishing shape, and
  // nothing in this panel needs them.
  if (url.username.length > 0 || url.password.length > 0) return null;
  return url.toString();
}

export const rightbarActions = {
  /** Load one session's surface from storage on first sight. */
  ensureSurface(key: string): void {
    if (key.length === 0) return;
    if (rightbarStore.get().surfaces[key] !== undefined) return;
    commit(key, loadSurface(key), false);
  },

  /**
   * Open the panel. An empty surface is seeded with the Files tab, which is
   * dsh's "the expansion that first shows an empty layout seeds the default
   * page" — so the panel never opens onto nothing.
   */
  open(key: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const tabs = surface.tabs.length > 0 ? surface.tabs : [makeFilesTab()];
    commit(key, {
      ...surface,
      open: true,
      tabs,
      activeTabId: surface.activeTabId ?? tabs[0]?.id ?? null,
    });
  },

  close(key: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    // Closing keeps the tabs: reopening the panel restores the file the user
    // was reading instead of resetting to the default page.
    commit(key, { ...surface, open: false });
  },

  toggle(key: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    if (surface.open) rightbarActions.close(key);
    else rightbarActions.open(key);
  },

  setMode(key: string, mode: RightbarSurface["mode"]): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    commit(key, { ...surface, mode });
  },

  setWidth(key: string, width: number, persist = true): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    commit(key, { ...surface, width: clampWidth(width) }, persist);
  },

  selectTab(key: string, id: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    if (!surface.tabs.some((tab) => tab.id === id)) return;
    commit(key, { ...surface, activeTabId: id });
  },

  /** Add a tab and focus it. The panel opens if it was closed. */
  openTab(key: string, tab: RightbarTab): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    commit(key, {
      ...surface,
      open: true,
      tabs: [...surface.tabs, tab],
      activeTabId: tab.id,
    });
  },

  /** Focus the Files tab, creating it when this surface has none. */
  openFilesTab(key: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const existing = surface.tabs.find((tab) => tab.kind === "files");
    if (existing !== undefined) {
      commit(key, { ...surface, open: true, activeTabId: existing.id });
      return;
    }
    rightbarActions.openTab(key, makeFilesTab());
  },

  /**
   * Focus the changes tab, creating it when this surface has none.
   *
   * There is one change set per project working tree, so like Files this tab is
   * a single instance: a second one would show the same branch. The body itself
   * re-reads on demand (and after every write).
   */
  openChangesTab(key: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const existing = surface.tabs.find((tab) => tab.kind === "changes");
    if (existing !== undefined) {
      commit(key, { ...surface, open: true, activeTabId: existing.id });
      return;
    }
    rightbarActions.openTab(key, makeChangesTab());
  },

  /**
   * Focus the Preview tab for one file, creating it when this surface has none.
   *
   * Two files are two tabs, and asking for one that is already open focuses it
   * rather than opening a second copy — the address is the tab's identity, the
   * same rule dsh's document preview uses.
   */
  openPreviewTab(key: string, path: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const existing = surface.tabs.find(
      (tab) => tab.kind === "preview" && tab.target === path,
    );
    if (existing !== undefined) {
      commit(key, { ...surface, open: true, activeTabId: existing.id });
      return;
    }
    rightbarActions.openTab(key, makePreviewTab(path));
  },

  openBrowserTab(key: string, url: string): void {
    rightbarActions.openTab(key, makeBrowserTab(url));
  },

  /**
   * Close one tab. Closing the last tab closes the panel with it, so a docked
   * surface is never left empty — dsh's rule, and the reason there is no
   * separate "close pane" gesture.
   */
  closeTab(key: string, id: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const index = surface.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const tabs = surface.tabs.filter((tab) => tab.id !== id);
    if (tabs.length === 0) {
      commit(key, { ...surface, tabs, activeTabId: null, open: false });
      return;
    }
    const activeTabId =
      surface.activeTabId === id
        ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
        : surface.activeTabId;
    commit(key, { ...surface, tabs, activeTabId });
  },

  /** Rename a tab — a browser tab takes the title of the page it landed on. */
  setTabTitle(key: string, id: string, title: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const tabs = surface.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab));
    commit(key, { ...surface, tabs });
  },

  /**
   * Navigate a browser tab to a new address.
   *
   * This is the address bar's behavior, not a link click's: everything after
   * the current position is dropped, exactly as a browser truncates its forward
   * entries. Entries are capped so a long session cannot grow the saved layout
   * without bound.
   */
  navigateBrowser(key: string, id: string, url: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const tabs = surface.tabs.map((tab) => {
      if (tab.id !== id) return tab;
      const history = tab.history ?? [];
      const index = tab.historyIndex ?? -1;
      const kept = index >= 0 ? history.slice(0, index + 1) : history;
      const next = [...kept, url];
      const capped = next.length > 50 ? next.slice(next.length - 50) : next;
      return {
        ...tab,
        target: url,
        title: hostOf(url),
        history: capped,
        historyIndex: capped.length - 1,
      };
    });
    commit(key, { ...surface, tabs });
  },

  /** Move inside a browser tab's own history (the toolbar's back/forward). */
  stepBrowserHistory(key: string, id: string, delta: number): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const tabs = surface.tabs.map((tab) => {
      if (tab.id !== id) return tab;
      const history = tab.history ?? [];
      const index = tab.historyIndex ?? -1;
      const next = index + delta;
      if (next < 0 || next >= history.length) return tab;
      return { ...tab, historyIndex: next, target: history[next] ?? tab.target };
    });
    commit(key, { ...surface, tabs });
  },
};

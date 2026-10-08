import { createStore, type Store } from "../../lib/store.ts";
import type { Translate } from "../../lib/i18n/index.ts";
import {
  MIN_PANE_FRACTION,
  cascadedRect,
  clampSizes,
  type DropZone,
  type FloatRect,
} from "./dock-geometry.ts";

/**
 * The right sidebar's state, mirroring dsh's per-session surface.
 *
 * One surface (panes, presentation, width, open/closed) belongs to each session
 * path, so switching sessions shows that session's own panel instead of
 * carrying one session's file tree into another's. The store is React-free like
 * `app-state`, and the panel component is the only thing that reads it.
 *
 * ## The shape, and the one place it parts from dsh
 *
 * dsh's dockkit keeps a *normalised recursive split tree*: split and pane nodes
 * keyed by id, a `rootId`, and `floats` listing panes drawn as viewport
 * overlays. Everything here is that model except the recursion. The right
 * sidebar caps itself at **two** docked panes, side by side and never stacked
 * (`SidebarRight.tsx` passes `canSplit={canSplit(layout) && dockPaneIds(layout)
 * .length < 2}` and `dropZones="horizontal"`), so the tree can never be deeper
 * than one row with two children — dsh's own `TabLayout` throws on any other
 * shape, and its README says so. A recursive model that can only ever be one
 * level deep is a generalisation no user can reach and no test can exercise, so
 * `panes` here is a flat ordered pair at most and `sizes` belongs to the
 * surface rather than to a split node.
 *
 * Everything else is copied, because everything else is reachable:
 *
 *  * a tab is a *record* in `tabs` and a pane holds its **ids**, so moving one
 *    between panes is a splice rather than a copy, and three actions that
 *    rewrite a tab (`setTabTitle`, `setTabTarget`, the browser's history) do
 *    not have to know which pane it is in;
 *  * a floating panel is **not a second concept**: it is a pane whose `host` is
 *    `"float"`, holding exactly one tab, drawn without a tab strip;
 *  * `activePaneId` names the focused pane, docked or floating, and it is what
 *    the split and fullscreen commands act on.
 *
 * The behaviours that a user can see are dsh's, with the deviations listed in
 * `docs/design-notes.md` — chiefly that an emptied docked pane is always merged
 * away rather than only when it is not the tree's root.
 */

export type RightbarTabKind = "files" | "preview" | "changes" | "browser" | "terminal";

export interface RightbarTab {
  id: string;
  kind: RightbarTabKind;
  title: string;
  /**
   * What the tab is about: a project-relative path for `preview`, an HTTP(S)
   * URL for `browser`, the host's own id for `terminal`, and nothing for
   * `files` or `changes` (neither needs an address).
   */
  target: string;
  /** `browser` only: the tab's history, newest last. */
  history?: string[];
  /** `browser` only: the position inside that history. */
  historyIndex?: number;
}

/** Where a pane is drawn: inside the docked row, or as a viewport overlay. */
export type PaneHost = "dock" | "float";

/**
 * One pane: an ordered tab list with at most one tab showing.
 *
 * A floating pane holds exactly one tab and carries a `rect`; a docked pane has
 * neither restriction and always fills its column.
 */
export interface RightbarPane {
  id: string;
  host: PaneHost;
  /** Tab ids in strip order; ids into the surface's `tabs`. */
  tabs: string[];
  /** The showing tab; `null` exactly when `tabs` is empty. */
  activeTabId: string | null;
  /** Set exactly when `host` is `"float"`. */
  rect?: FloatRect;
}

export interface RightbarSurface {
  open: boolean;
  mode: "push" | "fullscreen";
  width: number;
  /** Docked panes, left to right: one or two, never empty. */
  panes: RightbarPane[];
  /**
   * Divider fractions, present exactly when there are two docked panes. Each is
   * above `MIN_PANE_FRACTION` and they sum to 1.
   */
  sizes?: number[];
  /** Floating panes, bottom to top; the last entry is on top. */
  floats: RightbarPane[];
  /** Every open tab, keyed by id — shared by every pane, docked or floating. */
  tabs: Record<string, RightbarTab>;
  /** The focused pane, docked or floating. */
  activePaneId: string;
}

/** Width bounds mirror the range a conversation can spare on a laptop screen. */
export const WIDTH_MIN = 300;
export const WIDTH_MAX = 900;
export const WIDTH_DEFAULT = 420;

/**
 * The docked pane budget.
 *
 * The right sidebar's own number, not the kit's four: two panes are the most a
 * column beside a conversation can hold before each one is a gutter. It is the
 * cap the split control, the split shortcut and a dragged tab's left/right
 * release all consult, so they cannot disagree.
 */
export const MAX_DOCK_PANES = 2;

const STORAGE_PREFIX = "pi-web-simple.rightbar.v2.";
/** The flat layout this one replaced; read once, then never written again. */
const LEGACY_PREFIX = "pi-web-simple.rightbar.v1.";

/** The fractions two panes start at: an even split, which is dsh's. */
const EVEN_SIZES = [0.5, 0.5];

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

let idCounter = 0;

/**
 * A fresh pane id.
 *
 * The counter alone would be enough within one page, but a restored layout
 * already holds ids minted by an earlier load — and its counter started at zero
 * too. The random suffix is what keeps a newly minted id from naming a pane
 * that is already on screen, which is the one way two panes could end up
 * sharing an identity.
 */
function nextPaneId(): string {
  idCounter += 1;
  return `pane-${String(idCounter)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A pane with room to hold tabs and nothing showing yet. */
function emptyPane(host: PaneHost, rect?: FloatRect): RightbarPane {
  return {
    id: nextPaneId(),
    host,
    tabs: [],
    activeTabId: null,
    ...(rect === undefined ? {} : { rect }),
  };
}

/**
 * The surface a session with nothing saved starts from.
 *
 * A factory rather than a shared constant: a surface owns pane ids, and one
 * object handed to two sessions would give them both the same pane.
 */
function emptySurface(): RightbarSurface {
  const pane = emptyPane("dock");
  return {
    open: false,
    mode: "push",
    width: WIDTH_DEFAULT,
    panes: [pane],
    floats: [],
    tabs: {},
    activePaneId: pane.id,
  };
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return WIDTH_DEFAULT;
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(width)));
}

/**
 * A tab record read back from storage, or null when it is not one.
 *
 * "diff" was this tab's kind before it grew staging, committing and history; a
 * layout saved under the old name is adopted rather than dropped, and re-titled
 * for free.
 */
function readTab(entry: unknown): RightbarTab | null {
  if (typeof entry !== "object" || entry === null) return null;
  const tab = entry as Record<string, unknown>;
  const kind = tab.kind === "diff" ? "changes" : tab.kind;
  if (
    kind !== "files" &&
    kind !== "preview" &&
    kind !== "changes" &&
    kind !== "browser" &&
    kind !== "terminal"
  ) {
    return null;
  }
  if (typeof tab.id !== "string" || typeof tab.title !== "string") return null;
  return {
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
  };
}

/**
 * Read one pane back, keeping only tabs that were read successfully.
 *
 * The pane keeps its own id only if storage supplied a string: a pane that
 * cannot be named cannot be focused or moved into, so it is not worth adopting
 * under a made-up name. `floating` decides which of the two shapes is legal —
 * a floating pane holds exactly one tab.
 */
function readPane(entry: unknown, tabs: Record<string, RightbarTab>, floating: boolean): RightbarPane | null {
  if (typeof entry !== "object" || entry === null) return null;
  const pane = entry as Record<string, unknown>;
  if (typeof pane.id !== "string") return null;
  const ids = Array.isArray(pane.tabs)
    ? pane.tabs.filter((id): id is string => typeof id === "string" && tabs[id] !== undefined)
    : [];
  if (floating) {
    const only = ids[0];
    if (only === undefined) return null;
    const rect = readRect(pane.rect);
    // A floating pane with no rectangle has nowhere to be drawn, and inventing
    // one would put a panel the user never placed on top of their conversation.
    if (rect === null) return null;
    return { id: pane.id, host: "float", tabs: [only], activeTabId: only, rect };
  }
  const active =
    typeof pane.activeTabId === "string" && ids.includes(pane.activeTabId)
      ? pane.activeTabId
      : (ids[0] ?? null);
  return { id: pane.id, host: "dock", tabs: ids, activeTabId: active };
}

function readRect(entry: unknown): FloatRect | null {
  if (typeof entry !== "object" || entry === null) return null;
  const rect = entry as Record<string, unknown>;
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return {
    x: rect.x as number,
    y: rect.y as number,
    width: rect.width as number,
    height: rect.height as number,
  };
}

/** Read one surface's stored JSON, or null when it is not one. */
function parseSurface(raw: string): RightbarSurface | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const tabs: Record<string, RightbarTab> = {};
  if (typeof record.tabs === "object" && record.tabs !== null && !Array.isArray(record.tabs)) {
    for (const entry of Object.values(record.tabs)) {
      const tab = readTab(entry);
      if (tab !== null) tabs[tab.id] = tab;
    }
  }

  const docked = (
    Array.isArray(record.panes) ? record.panes.map((pane) => readPane(pane, tabs, false)) : []
  )
    .filter((pane): pane is RightbarPane => pane !== null)
    .slice(0, MAX_DOCK_PANES);
  const floats = (Array.isArray(record.floats) ? record.floats : [])
    .map((pane) => readPane(pane, tabs, true))
    .filter((pane): pane is RightbarPane => pane !== null);

  // A record no pane lists is unreachable: dropping it here is what keeps the
  // stored layout from growing a tail of tabs nobody can open, and it is also
  // what makes every reader below able to assume a pane's ids all resolve.
  const reachable: Record<string, RightbarTab> = {};
  for (const pane of [...docked, ...floats]) {
    for (const id of pane.tabs) {
      const tab = tabs[id];
      if (tab !== undefined) reachable[id] = tab;
    }
  }

  const panes = docked.length > 0 ? docked : [emptyPane("dock")];
  // A restored surface never reopens the panel: the panel is opened by a click
  // in the conversation header, and a page load that popped a panel open would
  // be reopening something the user did not ask for.
  const activePaneId =
    [...panes, ...floats].find((pane) => pane.id === record.activePaneId)?.id ?? panes[0]!.id;

  return {
    open: false,
    mode: record.mode === "fullscreen" ? "fullscreen" : "push",
    width: typeof record.width === "number" ? clampWidth(record.width) : WIDTH_DEFAULT,
    panes,
    ...(panes.length === 2
      ? { sizes: clampSizes(Array.isArray(record.sizes) ? record.sizes : EVEN_SIZES) }
      : {}),
    floats,
    tabs: reachable,
    activePaneId,
  };
}

/**
 * Read the flat layout this shape replaced.
 *
 * One pane held every tab, so adopting it is exactly that: one docked pane with
 * the same tabs, the same showing tab, and an even divider the user has never
 * seen because there is nothing to divide yet. The old key is never deleted —
 * it costs a few hundred bytes and it is the only copy of a layout for anyone
 * who goes back to an older build.
 */
function adoptLegacy(raw: string): RightbarSurface | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const ids: string[] = [];
  const tabs: Record<string, RightbarTab> = {};
  if (Array.isArray(record.tabs)) {
    for (const entry of record.tabs) {
      const tab = readTab(entry);
      if (tab === null) continue;
      ids.push(tab.id);
      tabs[tab.id] = tab;
    }
  }
  const pane: RightbarPane = {
    id: nextPaneId(),
    host: "dock",
    tabs: ids,
    activeTabId:
      typeof record.activeTabId === "string" && ids.includes(record.activeTabId)
        ? record.activeTabId
        : (ids[0] ?? null),
  };
  return {
    open: false,
    mode: record.mode === "fullscreen" ? "fullscreen" : "push",
    width: typeof record.width === "number" ? clampWidth(record.width) : WIDTH_DEFAULT,
    panes: [pane],
    floats: [],
    tabs,
    activePaneId: pane.id,
  };
}

function loadSurface(key: string): RightbarSurface {
  if (!isPersistable(key)) return emptySurface();
  const store = storage();
  if (store === null) return emptySurface();
  const raw = store.getItem(STORAGE_PREFIX + key);
  if (raw !== null) return parseSurface(raw) ?? emptySurface();
  const legacy = store.getItem(LEGACY_PREFIX + key);
  return legacy === null ? emptySurface() : (adoptLegacy(legacy) ?? emptySurface());
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
 * `persist: false` is for the pointer-move frames of a drag: the layout follows
 * the pointer live, and only the release is worth a localStorage write.
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

/* -------------------------------------------------------------------------- */
/* Selectors                                                                   */
/* -------------------------------------------------------------------------- */

/** One pane by id, docked or floating. */
export function paneById(surface: RightbarSurface, paneId: string): RightbarPane | undefined {
  return [...surface.panes, ...surface.floats].find((pane) => pane.id === paneId);
}

/** The pane showing a tab, docked or floating. */
export function findTabPane(surface: RightbarSurface, tabId: string): RightbarPane | undefined {
  return [...surface.panes, ...surface.floats].find((pane) => pane.tabs.includes(tabId));
}

export function findTab(surface: RightbarSurface, tabId: string): RightbarTab | undefined {
  return surface.tabs[tabId];
}

/** A pane's tabs, in strip order. */
export function paneTabs(surface: RightbarSurface, pane: RightbarPane): RightbarTab[] {
  const out: RightbarTab[] = [];
  for (const id of pane.tabs) {
    const tab = surface.tabs[id];
    if (tab !== undefined) out.push(tab);
  }
  return out;
}

/** The showing tab of a pane, or undefined while it is empty. */
export function paneActiveTab(surface: RightbarSurface, pane: RightbarPane): RightbarTab | undefined {
  return pane.activeTabId === null ? undefined : surface.tabs[pane.activeTabId];
}

/**
 * The pane a new tab lands in: the focused one when it is docked, else the
 * first docked pane — dsh's `activeDockPaneId`.
 */
export function activeDockPaneId(surface: RightbarSurface): string {
  const active = paneById(surface, surface.activePaneId);
  return active !== undefined && active.host === "dock" ? active.id : (surface.panes[0]?.id ?? "");
}

/**
 * The docked pane whose strip carries the panel's own controls: the rightmost
 * one, which is dsh's `topRightPaneId` with one row and no columns to descend.
 */
export function topRightPane(surface: RightbarSurface): RightbarPane | undefined {
  return surface.panes.at(-1);
}

/** Whether another docked pane is allowed. The one place the budget is read. */
export function canSplitDock(surface: RightbarSurface): boolean {
  return surface.panes.length < MAX_DOCK_PANES;
}

/** How many tabs the surface holds anywhere, docked or floating. */
export function tabCount(surface: RightbarSurface): number {
  return Object.keys(surface.tabs).length;
}

/* -------------------------------------------------------------------------- */
/* Tab factories                                                               */
/* -------------------------------------------------------------------------- */

let tabCounter = 0;

function nextTabId(kind: RightbarTabKind): string {
  tabCounter += 1;
  return `${kind}-${String(tabCounter)}-${Math.random().toString(36).slice(2, 7)}`;
}

const TAB_TITLE_KEYS = {
  files: "tab.files",
  changes: "tab.changes",
  browser: "tab.browser",
  terminal: "tab.terminal",
} as const;

/**
 * A tab's display name.
 *
 * The fixed kinds are named by the message table instead of by a title stored
 * on the tab: the strip outlives a language switch, and a title captured when
 * the tab was created would come back in the old language. Two kinds carry a
 * name of their own — a preview its file, a terminal whatever the user renamed
 * it to — and both read the same in either language, so they keep it.
 */
export function tabTitle(tab: RightbarTab, t: Translate): string {
  if (tab.kind === "preview") return tab.title;
  if (tab.kind === "terminal" && tab.title.length > 0) return tab.title;
  return t(TAB_TITLE_KEYS[tab.kind]);
}

/**
 * Whether a tab's name belongs to the tab rather than to the message table.
 *
 * Exactly the two kinds `tabTitle` reads a title from: a preview names itself
 * after its file, a terminal after its shell — or after whatever the user last
 * called it. The other three are named by the UI's own wording, so a rename
 * offered on them would be stored and never seen. Kept next to `tabTitle`
 * because the two have to agree: widening one without the other is how a menu
 * item ends up doing nothing.
 */
export function canRenameTab(kind: RightbarTabKind): boolean {
  return kind === "preview" || kind === "terminal";
}

export function makeFilesTab(): RightbarTab {
  return { id: nextTabId("files"), kind: "files", title: "", target: "" };
}

export function makePreviewTab(path: string): RightbarTab {
  const title = path.split("/").pop() ?? path;
  return { id: nextTabId("preview"), kind: "preview", title, target: path };
}

export function makeChangesTab(): RightbarTab {
  return { id: nextTabId("changes"), kind: "changes", title: "", target: "" };
}

export function makeBrowserTab(url: string): RightbarTab {
  const title = url.length > 0 ? hostOf(url) : "";
  return {
    id: nextTabId("browser"),
    kind: "browser",
    title,
    target: url,
    history: url.length > 0 ? [url] : [],
    historyIndex: url.length > 0 ? 0 : -1,
  };
}

/**
 * A terminal tab, before it has a shell.
 *
 * `target` is empty on purpose: the host id arrives when the body mounts and
 * asks for one, and this layer never calls the API. The id is written back by
 * `setTabTarget` so a reload reattaches to the same shell instead of opening a
 * second one beside it.
 *
 * There is no shell to remember: every terminal opens bash (the server's
 * `pickShell` decides), so a tab carries nothing about which program it wants.
 */
export function makeTerminalTab(): RightbarTab {
  return { id: nextTabId("terminal"), kind: "terminal", title: "", target: "" };
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

/* -------------------------------------------------------------------------- */
/* Pane surgery                                                                */
/* -------------------------------------------------------------------------- */

/** One pane replaced by id, leaving the array's identity for everything else. */
function replacePane(panes: RightbarPane[], next: RightbarPane): RightbarPane[] {
  return panes.map((pane) => (pane.id === next.id ? next : pane));
}

/**
 * The tab a pane shows once `going` are removed.
 *
 * The showing tab stays unless it is one of the ones going away. When it does
 * go, focus lands on whatever slid into its place — the neighbour on its right,
 * or the one on its left when it was last. That is the neighbour rule a single
 * close has always used, and it is why the count below is "survivors to the
 * left of the first removed tab": for one id that is exactly the removed tab's
 * own index.
 */
function activeAfterClose(
  pane: RightbarPane,
  going: ReadonlySet<string>,
  kept: readonly string[],
): string | null {
  if (pane.activeTabId === null || !going.has(pane.activeTabId)) return pane.activeTabId;
  const first = pane.tabs.findIndex((id) => going.has(id));
  const survivorsBefore = pane.tabs.slice(0, first).filter((id) => !going.has(id)).length;
  return kept[Math.min(survivorsBefore, kept.length - 1)] ?? null;
}

/**
 * A pane with `going` taken out of its strip.
 *
 * Removing nothing returns the pane itself, so a caller can map this over every
 * pane and only the ones that changed get a new object — the store's identity
 * comparison and the persisted JSON both stay honest.
 */
function paneWithout(pane: RightbarPane, going: ReadonlySet<string>): RightbarPane {
  const kept = pane.tabs.filter((id) => !going.has(id));
  if (kept.length === pane.tabs.length) return pane;
  return { ...pane, tabs: kept, activeTabId: activeAfterClose(pane, going, kept) };
}

/** A pane with `tabId` inserted at `index` (clamped) and showing. */
function paneWithTab(pane: RightbarPane, tabId: string, index: number): RightbarPane {
  const tabs = [...pane.tabs];
  tabs.splice(Math.min(Math.max(index, 0), tabs.length), 0, tabId);
  return { ...pane, tabs, activeTabId: tabId };
}

/**
 * The docked panes after an intent, with every pane the intent emptied merged
 * away.
 *
 * dsh merges only panes that are not its tree's root, because a tree needs a
 * node there: a surface whose *first* pane emptied keeps a blank half until
 * something lands in it. `panes` here is an array, so there is no such node to
 * preserve and every empty pane goes — the survivor takes the whole column and
 * the divider with it, which is also what makes `sizes` disappear at the same
 * moment. The last pane is never dropped: the panel is a column of the page,
 * and a surface with no panes at all has nothing to address.
 */
function settleDock(
  panes: RightbarPane[],
  sizes: number[] | undefined,
): { panes: RightbarPane[]; sizes: number[] | undefined } {
  if (panes.length <= 1) return { panes, sizes };
  const kept = panes.filter((pane) => pane.tabs.length > 0);
  if (kept.length === panes.length) return { panes, sizes };
  if (kept.length === 0) return { panes: panes.slice(0, 1), sizes: undefined };
  return { panes: kept, sizes: undefined };
}

/**
 * The pane to focus once an intent has moved panes around.
 *
 * A pane that survived keeps the focus wherever it was. When it did not — a
 * floating panel closed, a docked pane merged away with its last tab — focus
 * falls to the first docked pane that still shows something, then to the top
 * floating panel, then to whatever pane is left.
 */
function reconcileFocus(
  active: string,
  panes: readonly RightbarPane[],
  floats: readonly RightbarPane[],
): string {
  if ([...panes, ...floats].some((pane) => pane.id === active)) return active;
  const fallback = panes.find((pane) => pane.tabs.length > 0) ?? floats.at(-1) ?? panes[0];
  return fallback?.id ?? "";
}

/** What an intent changed about the pane layout. */
interface LayoutChange {
  readonly panes: RightbarPane[];
  /** Absent when there is no divider: one pane fills the column. */
  readonly sizes: number[] | undefined;
  readonly floats: RightbarPane[];
  readonly activePaneId: string;
  readonly open?: boolean;
  readonly tabs?: Record<string, RightbarTab>;
}

/**
 * A surface with its pane layout replaced.
 *
 * Written out field by field rather than spread, because `sizes` has to be able
 * to *disappear*: a spread would carry the old divider across a merge, and an
 * explicit `sizes: undefined` would leave the key present in memory while
 * `JSON.stringify` drops it in storage — two shapes for one fact. This is the
 * only place `sizes` is written.
 */
function withLayout(surface: RightbarSurface, next: LayoutChange): RightbarSurface {
  return {
    open: next.open ?? surface.open,
    mode: surface.mode,
    width: surface.width,
    tabs: next.tabs ?? surface.tabs,
    panes: next.panes,
    floats: next.floats,
    activePaneId: next.activePaneId,
    ...(next.sizes === undefined ? {} : { sizes: next.sizes }),
  };
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `surface` with a new empty pane to the right of `paneId`, or null when the
 * split is not allowed.
 *
 * Pure and separate from the action so a *gesture* that both splits and moves a
 * tab (a chip released on a pane's edge) composes it with `moveIntoSplit` and
 * writes once. dsh gets the same property from composing operations before
 * applying them; there is no op log here, so the composition is a function
 * returning the next surface.
 *
 * The pane budget is the only refusal here. Whether the *reference* pane is
 * worth splitting — an empty one is not — belongs to the split control's own
 * action, exactly as dsh puts it in `splitPane` rather than in the planner.
 */
function splitDock(
  surface: RightbarSurface,
  paneId: string,
  direction: "before" | "after" = "after",
): RightbarSurface | null {
  const pane = surface.panes.find((entry) => entry.id === paneId);
  if (pane === undefined || !canSplitDock(surface)) return null;
  const fresh = emptyPane("dock");
  const panes = [...surface.panes];
  // The cap above is what makes this the end of the array: there is no way to
  // reach here with two panes already docked.
  panes.splice(surface.panes.indexOf(pane) + (direction === "after" ? 1 : 0), 0, fresh);
  return withLayout(surface, {
    panes,
    sizes: [...EVEN_SIZES],
    floats: surface.floats,
    activePaneId: fresh.id,
  });
}

/**
 * `surface` with `tabId` moved into the docked pane `toPaneId`, or null when
 * there is nothing to do.
 *
 * A floating panel holds exactly one tab, so moving its tab out destroys the
 * panel rather than leaving it empty — dsh's `tabInto`, which picks `unfloat`
 * for exactly this case. The pane the tab left is settled, so a pane emptied by
 * the move is merged away, and the tab ends focused.
 */
function moveIntoSplit(
  surface: RightbarSurface,
  tabId: string,
  toPaneId: string,
  index: number,
): RightbarSurface | null {
  const source = findTabPane(surface, tabId);
  const target = surface.panes.find((pane) => pane.id === toPaneId);
  if (source === undefined || target === undefined || source.id === target.id) return null;
  const going = new Set([tabId]);
  const settled = settleDock(
    surface.panes.map((pane) =>
      pane.id === target.id ? paneWithTab(pane, tabId, index) : paneWithout(pane, going),
    ),
    surface.sizes,
  );
  const floats =
    source.host === "float" ? surface.floats.filter((pane) => pane.id !== source.id) : surface.floats;
  const landed = settled.panes.find((pane) => pane.id === target.id);
  return withLayout(surface, {
    panes: settled.panes,
    sizes: settled.sizes,
    floats,
    activePaneId: landed?.id ?? reconcileFocus(surface.activePaneId, settled.panes, floats),
  });
}

/** A surface showing `tabId`, with the pane holding it focused and raised.
 *
 * Selecting a tab in a floating panel does both jobs the intent has — it shows
 * that tab and raises the panel holding it — which is why this is one helper
 * rather than a focus here and a raise there. Null when no pane holds the tab.
 */
function surfaceShowing(surface: RightbarSurface, tabId: string): RightbarSurface | null {
  const pane = findTabPane(surface, tabId);
  if (pane === undefined) return null;
  return withLayout(surface, {
    panes:
      pane.host === "dock"
        ? replacePane(surface.panes, { ...pane, activeTabId: tabId })
        : surface.panes,
    sizes: surface.sizes,
    floats:
      pane.host === "float"
        ? [...surface.floats.filter((entry) => entry.id !== pane.id), { ...pane, activeTabId: tabId }]
        : surface.floats,
    activePaneId: pane.id,
  });
}

/**
 * A singleton-kind open: focus the tab already showing this, else make one.
 *
 * The search is over the **whole surface**, not the focused pane, which is
 * dsh's rule for content (`findContentTab`) as opposed to its rule for the
 * guide page ("a page is unique per pane"). A second file tree in the other
 * pane would read the same directory twice, so the panel keeps one and the
 * click brings it — and the pane it lives in — forward.
 */
function revealOrOpen(
  key: string,
  match: (tab: RightbarTab) => boolean,
  make: () => RightbarTab,
  paneId?: string,
): void {
  const surface = surfaceOf(rightbarStore.get(), key);
  const existing = Object.values(surface.tabs).find(match);
  if (existing === undefined) {
    rightbarActions.openTab(key, make(), paneId);
    return;
  }
  const next = surfaceShowing(surface, existing.id);
  if (next === null) return;
  // One commit, not two: asking for a file both shows its tab and opens the
  // panel, and a gesture writes the layout once.
  commit(key, { ...next, open: true });
}

export const rightbarActions = {
  /** Load one session's surface from storage on first sight. */
  ensureSurface(key: string): void {
    if (key.length === 0) return;
    if (rightbarStore.get().surfaces[key] !== undefined) return;
    commit(key, loadSurface(key), false);
  },

  /**
   * Open the panel. A surface with nothing in it is seeded with the Files tab,
   * which is dsh's "the expansion that first shows an empty layout seeds the
   * default page" — so the panel never opens onto nothing.
   */
  open(key: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    if (tabCount(surface) > 0) {
      commit(key, { ...surface, open: true });
      return;
    }
    rightbarActions.openTab(key, makeFilesTab());
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

  /* ---- panes ------------------------------------------------------------ */

  /**
   * Focus a pane, and raise it when it floats.
   *
   * A click anywhere in a pane is this intent and nothing more: dsh draws the
   * focused pane with a brighter strip, and it is what the split and fullscreen
   * commands act on. When several panes are docked the click is the only way to
   * say which one, which is why it is recorded rather than derived.
   */
  focusPane(key: string, paneId: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const pane = paneById(surface, paneId);
    if (pane === undefined) return;
    // Already focused *and* already on top is the one case that changes
    // nothing; focus alone is not enough, because a panel can be focused while
    // another floats over it — dsh's `raised`, which asks the same two
    // questions.
    const raised = pane.host === "dock" || surface.floats.at(-1)?.id === pane.id;
    if (surface.activePaneId === paneId && raised) return;
    commit(key, {
      ...surface,
      activePaneId: paneId,
      // Raising is part of focusing, not a second intent: the panel the user
      // just touched is the one they expect to be on top.
      floats: pane.host === "float" ? [...surface.floats.filter((f) => f.id !== paneId), pane] : surface.floats,
    });
  },

  /**
   * Split a pane and give the new one room to the right of it.
   *
   * The new pane is **empty**, drawn as 「空面板」 until its own `+` puts
   * something in it. dsh seats its embedder's *guide* page there — a page that
   * exists once per surface and is always available to seed with. pi-web has no
   * such page: its two singleton kinds (Files, Changes) are one-per-project, so
   * seeding one would either duplicate a project-wide view or silently focus
   * the tab in the pane the user just left. Saying nothing is there is the
   * honest answer, and it is a state dsh names too (`dock.emptyPane`).
   *
   * Refused when the budget is spent, and when the pane is already empty: two
   * blank halves are not a layout anybody asked for, which is also dsh's rule
   * (`getPane(...).tabs.length === 0 ? [] : planSplitPane(...)`).
   */
  splitPane(key: string, paneId?: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const target = paneId ?? activeDockPaneId(surface);
    // Splitting an empty pane would leave two blank halves, which is dsh's
    // `getPane(...).tabs.length === 0 ? [] : planSplitPane(...)`.
    const pane = surface.panes.find((entry) => entry.id === target);
    if (pane === undefined || pane.tabs.length === 0) return;
    const next = splitDock(surface, target);
    if (next !== null) commit(key, next);
  },

  /**
   * Record the net fractions of a divider drag.
   *
   * A no-op unless two panes are docked, so a stale drag cannot invent a
   * divider for a single-pane surface. The drag itself previews its own
   * fractions; this is the one write it leaves behind.
   */
  resizePanes(key: string, sizes: readonly number[]): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    if (surface.panes.length !== 2) return;
    commit(key, { ...surface, sizes: clampSizes(sizes, MIN_PANE_FRACTION) });
  },

  /* ---- tabs ------------------------------------------------------------- */

  /**
   * Focus a tab, its pane, and raise that pane when it floats — dsh's
   * `focusTab`, which is one intent for the same reason: a chip's click says
   * which pane you are in as well as which tab you want.
   */
  selectTab(key: string, tabId: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const next = surfaceShowing(surface, tabId);
    if (next !== null) commit(key, next);
  },

  /**
   * Add a tab and focus it. The panel opens if it was closed.
   *
   * `paneId` is the pane the request came from — a pane's own `+` means "here",
   * not "wherever the focus happens to be". A floating pane's id falls through
   * to the focused docked pane rather than being refused: a float holds one tab
   * by definition, so there is nowhere to put another one.
   */
  openTab(key: string, tab: RightbarTab, paneId?: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const asked = paneId === undefined ? undefined : surface.panes.find((pane) => pane.id === paneId);
    const pane = asked ?? surface.panes.find((entry) => entry.id === activeDockPaneId(surface));
    if (pane === undefined) return;
    commit(key, {
      ...surface,
      open: true,
      tabs: { ...surface.tabs, [tab.id]: tab },
      panes: replacePane(surface.panes, paneWithTab(pane, tab.id, pane.tabs.length)),
      activePaneId: pane.id,
    });
  },

  /** Focus the Files tab, creating it when this surface has none. */
  openFilesTab(key: string, paneId?: string): void {
    revealOrOpen(key, (tab) => tab.kind === "files", makeFilesTab, paneId);
  },

  /**
   * Focus the changes tab, creating it when this surface has none.
   *
   * There is one change set per project working tree, so like Files this tab is
   * a single instance: a second one would show the same branch. The body itself
   * re-reads on demand (and after every write).
   */
  openChangesTab(key: string, paneId?: string): void {
    revealOrOpen(key, (tab) => tab.kind === "changes", makeChangesTab, paneId);
  },

  /**
   * Focus the Preview tab for one file, creating it when this surface has none.
   *
   * Two files are two tabs, and asking for one that is already open focuses it
   * rather than opening a second copy — the address is the tab's identity, the
   * same rule dsh's document preview uses.
   */
  openPreviewTab(key: string, path: string, paneId?: string): void {
    revealOrOpen(
      key,
      (tab) => tab.kind === "preview" && tab.target === path,
      () => makePreviewTab(path),
      paneId,
    );
  },

  openBrowserTab(key: string, url: string, paneId?: string): void {
    rightbarActions.openTab(key, makeBrowserTab(url), paneId);
  },

  /**
   * Open a new terminal tab.
   *
   * Always a new one: two shells are two independent processes, so a tab is
   * never reused the way a preview of the same file is. The host id is filled
   * in by the body once it has one.
   */
  openTerminalTab(key: string, paneId?: string): void {
    rightbarActions.openTab(key, makeTerminalTab(), paneId);
  },

  /** Close one tab. */
  closeTab(key: string, id: string): void {
    rightbarActions.closeTabs(key, [id]);
  },

  /**
   * Close several tabs in one write.
   *
   * One commit rather than one per tab because the strip's menu closes whole
   * groups: a surface written once per closed tab would render the strip N times
   * for a single gesture, and a page that went away mid-loop would leave a
   * half-closed layout in storage.
   *
   * A tab's *pane* is decided by closing it: a floating panel holds one tab and
   * goes with it, and a docked pane the close empties is merged away (see
   * `settleDock`). Closing everything closes the panel with it, so a docked
   * surface is never left empty — dsh's rule, and the reason there is no
   * separate "close pane" gesture.
   */
  closeTabs(key: string, ids: readonly string[]): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const going = new Set(ids.filter((id) => surface.tabs[id] !== undefined));
    if (going.size === 0) return;
    // A floating pane goes with its only tab; a docked one loses it and may be
    // merged below.
    const floats = surface.floats.filter((pane) => !pane.tabs.some((id) => going.has(id)));
    const settled = settleDock(
      surface.panes.map((pane) => paneWithout(pane, going)),
      surface.sizes,
    );
    const tabs: Record<string, RightbarTab> = {};
    for (const [id, tab] of Object.entries(surface.tabs)) if (!going.has(id)) tabs[id] = tab;
    commit(
      key,
      withLayout(surface, {
        panes: settled.panes,
        sizes: settled.sizes,
        floats,
        activePaneId: reconcileFocus(surface.activePaneId, settled.panes, floats),
        // Drafts aside, the panel is closed by its last tab going away rather
        // than by the close itself: a surface holding only floats keeps its
        // column, because the floats are drawn over the conversation.
        ...(Object.keys(tabs).length === 0 ? { open: false } : {}),
        tabs,
      }),
    );
  },

  /* ---- moving tabs between panes ---------------------------------------- */

  /**
   * Put a tab at an explicit strip slot: a reorder inside its own pane, a move
   * to another one, or a return from a floating panel.
   *
   * `index` is the caret slot counted over the destination strip's chips as
   * drawn — the dragged chip included when the destination is its own pane, so
   * the slot just before or just after it is where it already sits. That is why
   * `reorderTab`'s index, which counts the strip without the tab, is nudged
   * down whenever the caret was past the chip.
   */
  placeTab(key: string, tabId: string, toPaneId: string, index: number): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const source = findTabPane(surface, tabId);
    const target = surface.panes.find((pane) => pane.id === toPaneId);
    if (source === undefined || target === undefined) return;
    if (source.id === target.id) {
      const from = source.tabs.indexOf(tabId);
      const to = index > from ? index - 1 : index;
      if (to === from) return;
      const tabs = [...source.tabs];
      tabs.splice(from, 1);
      tabs.splice(Math.min(Math.max(to, 0), tabs.length), 0, tabId);
      commit(key, { ...surface, panes: replacePane(surface.panes, { ...source, tabs }) });
      return;
    }
    rightbarActions.moveTab(key, tabId, toPaneId, index);
  },

  /**
   * Move a tab into another docked pane.
   *
   * A tab is a record in `tabs` and a pane holds ids, so this is a splice: a
   * terminal keeps its host id and reattaches to the same shell wherever it
   * lands, which is what makes moving one safe at all.
   */
  moveTab(key: string, tabId: string, toPaneId: string, index: number): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const next = moveIntoSplit(surface, tabId, toPaneId, index);
    if (next !== null) commit(key, next);
  },

  /**
   * Resolve a chip released on a pane's body: the centre moves the tab in, an
   * edge splits the pane and seats the tab in the new half.
   *
   * Two refusals, both dsh's. The split is refused when the pane budget is
   * spent — the release then does nothing rather than falling back to a move,
   * because the pointer is over an edge and a move is not what it asked for.
   * And a pane's **only** tab released on that same pane's edge is refused too:
   * the split would empty the pane the tab came from and seat it beside where
   * it already was, which is indistinguishable from doing nothing but costs a
   * layout change. dsh treats the second case as a chance to backfill the
   * emptied pane with a tab of its own; this surface has no such tab to seat,
   * so it declines.
   *
   * Both operations go into **one** write: a gesture that split and then moved
   * would otherwise render the strip twice and could persist a half-finished
   * layout if the page went away between them.
   */
  dropTab(key: string, tabId: string, paneId: string, zone: DropZone): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const source = findTabPane(surface, tabId);
    const target = surface.panes.find((pane) => pane.id === paneId);
    if (source === undefined || target === undefined) return;
    if (zone === "center") {
      rightbarActions.moveTab(key, tabId, paneId, target.tabs.length);
      return;
    }
    if (source.id === target.id && source.tabs.length === 1) return;
    const split = splitDock(surface, paneId, zone === "left" ? "before" : "after");
    if (split === null) return;
    const fresh = split.panes.find((pane) => !surface.panes.some((old) => old.id === pane.id));
    if (fresh === undefined) return;
    const next = moveIntoSplit(split, tabId, fresh.id, 0);
    if (next !== null) commit(key, next);
  },

  /* ---- floating panels -------------------------------------------------- */

  /**
   * Take a tab out into a floating panel.
   *
   * Not a second concept: the panel is a pane whose `host` is `"float"`, so
   * everything that already works on a pane — focus, close, move its tab back —
   * works on it unchanged. It holds exactly one tab, which is why floating is a
   * per-*tab* gesture and there is no way to float a pane.
   *
   * `rect` is the release point's rectangle when a drag decided one; without it
   * the panel cascades from the ones already floating, so the second panel does
   * not land exactly on the first.
   */
  floatTab(key: string, tabId: string, rect?: FloatRect): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const source = findTabPane(surface, tabId);
    if (source === undefined || source.host === "float") return;
    const going = new Set([tabId]);
    const settled = settleDock(surface.panes.map((pane) => paneWithout(pane, going)), surface.sizes);
    const placed = emptyPane("float", rect ?? cascadedRect(surface.floats.length));
    const panel: RightbarPane = { ...placed, tabs: [tabId], activeTabId: tabId };
    commit(
      key,
      withLayout(surface, {
        panes: settled.panes,
        sizes: settled.sizes,
        floats: [...surface.floats, panel],
        activePaneId: panel.id,
      }),
    );
  },

  /**
   * Send a floating panel's tab back into the docked tree, and destroy the
   * panel.
   *
   * The destination is the focused docked pane by default, which is dsh's
   * `planUnfloatPane`. The tab lands at the end of that pane's strip and
   * focused, like every other tab that arrives from somewhere else.
   */
  unfloatPane(key: string, paneId: string, toPaneId?: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const panel = surface.floats.find((pane) => pane.id === paneId);
    if (panel === undefined) return;
    const tabId = panel.tabs[0];
    const target = surface.panes.find((pane) => pane.id === (toPaneId ?? activeDockPaneId(surface)));
    if (tabId === undefined || target === undefined) return;
    commit(key, {
      ...surface,
      panes: replacePane(surface.panes, paneWithTab(target, tabId, target.tabs.length)),
      floats: surface.floats.filter((pane) => pane.id !== paneId),
      activePaneId: target.id,
    });
  },

  /**
   * The net position of a floating panel drag.
   *
   * Moving a panel focuses and raises it — one gesture, one intent — which is
   * why there is no separate raise call on this path.
   */
  moveFloat(key: string, paneId: string, x: number, y: number, persist = true): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const panel = surface.floats.find((pane) => pane.id === paneId);
    if (panel === undefined || panel.rect === undefined) return;
    const next = { ...panel, rect: { ...panel.rect, x: Math.max(0, x), y: Math.max(0, y) } };
    commit(
      key,
      {
        ...surface,
        floats: [...surface.floats.filter((pane) => pane.id !== paneId), next],
        activePaneId: paneId,
      },
      persist,
    );
  },

  /** The net rectangle of a floating panel resize. Focused and raised with it. */
  resizeFloat(key: string, paneId: string, rect: FloatRect): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const panel = surface.floats.find((pane) => pane.id === paneId);
    if (panel === undefined) return;
    const next = { ...panel, rect };
    commit(key, {
      ...surface,
      floats: [...surface.floats.filter((pane) => pane.id !== paneId), next],
      activePaneId: paneId,
    });
  },

  /* ---- tab records ------------------------------------------------------ */

  /** Rename a tab — a browser tab takes the title of the page it landed on. */
  setTabTitle(key: string, id: string, title: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const tab = surface.tabs[id];
    if (tab === undefined) return;
    commit(key, { ...surface, tabs: { ...surface.tabs, [id]: { ...tab, title } } });
  },

  /**
   * Point a tab at the resource it turned out to be about.
   *
   * A terminal is why this exists. Its tab is created before its shell is — the
   * shell is the body's business, and this layer does not call the API — so the
   * id the host hands back has to be remembered somewhere, or the next mount
   * would open a second shell beside the one already running.
   */
  setTabTarget(key: string, id: string, target: string): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const tab = surface.tabs[id];
    if (tab === undefined) return;
    commit(key, { ...surface, tabs: { ...surface.tabs, [id]: { ...tab, target } } });
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
    const tab = surface.tabs[id];
    if (tab === undefined || tab.kind !== "browser") return;
    const history = tab.history ?? [];
    const index = tab.historyIndex ?? -1;
    const kept = index >= 0 ? history.slice(0, index + 1) : history;
    const next = [...kept, url];
    const capped = next.length > 50 ? next.slice(next.length - 50) : next;
    commit(key, {
      ...surface,
      tabs: {
        ...surface.tabs,
        [id]: {
          ...tab,
          target: url,
          title: hostOf(url),
          history: capped,
          historyIndex: capped.length - 1,
        },
      },
    });
  },

  /** Move inside a browser tab's own history (the toolbar's back/forward). */
  stepBrowserHistory(key: string, id: string, delta: number): void {
    const surface = surfaceOf(rightbarStore.get(), key);
    const tab = surface.tabs[id];
    if (tab === undefined || tab.kind !== "browser") return;
    const history = tab.history ?? [];
    const index = tab.historyIndex ?? -1;
    const next = index + delta;
    if (next < 0 || next >= history.length) return;
    commit(key, {
      ...surface,
      tabs: {
        ...surface.tabs,
        [id]: { ...tab, historyIndex: next, target: history[next] ?? tab.target },
      },
    });
  },
};

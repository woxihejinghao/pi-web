import { useMemo } from "react";
import { api, ApiError } from "./api.ts";
import { APP_NAME } from "./brand.ts";
import { resolveLanguage, translator, type Translate, type UiLanguage } from "./i18n/index.ts";
import {
  pageIsAttended,
  setNotificationBadge,
  showNotification,
  subscribeNotificationClicks,
} from "./notifications.ts";
import { buildProjectTree, flattenProjectTree } from "./project-tree.ts";
import {
  loadSidebarView,
  moveInOrder,
  moveWorkspace,
  saveSidebarView,
  type SessionGroupBy,
  type SessionOrderBy,
  type SidebarView,
} from "./sidebar-view.ts";
import { createEmitter, createStore, useStoreSelector, type Emitter, type Store } from "./store.ts";
import { applyAppearance, applyContentFontSize, watchSystemAppearance } from "./theme.ts";
import type {
  AgentMessage,
  AgentPresetRow,
  AgentSettings,
  ComposerModel,
  ExtensionsView,
  ImageBlock,
  McpProbeResult,
  McpServerDraft,
  McpView,
  ModelsView,
  PendingUiDialog,
  ProviderInput,
  SessionEvent,
  ProjectView,
  SessionView,
  SlashCommand,
  UpdatesView,
  WebSettings,
} from "./types.ts";
import { DEFAULT_PRESET_ID } from "./types.ts";

/**
 * Mirrors the server's defaults so a slow `/api/settings` is invisible: the
 * first paint already uses these, and the fetch only ever confirms them.
 * Keep in step with `server/src/store.ts`.
 */
const DEFAULT_SETTINGS: WebSettings = {
  appearance: "system",
  language: "system",
  contentFontSize: 14,
  transcriptDisplay: "standard",
  busySendBehavior: "queue",
  browserNotifications: false,
  // Titles stay deterministic until someone opts in and names a model.
  titleModel: null,
};

/** A blocking extension dialog waiting on the user. */
export type PendingUiRequest = PendingUiDialog;

/**
 * Marks a session that only exists in the browser so far.
 *
 * Spawning a pi process takes ~1.6s, so the UI adopts a draft immediately and
 * lets the real session arrive in the background.
 */
export const DRAFT_PREFIX = "draft:";

/**
 * How many sessions a workspace shows before folding the rest behind "show
 * more" — dsh's five. This is the page the sidebar asks the server for, so the
 * two have to agree (see `refreshSessions`).
 */
export const SESSIONS_PAGE_SIZE = 5;

export function isDraftSession(sessionPath: string | null): boolean {
  return typeof sessionPath === "string" && sessionPath.startsWith(DRAFT_PREFIX);
}

/**
 * Whether a frame addressed to `framePath` belongs to the seat `declared`.
 *
 * The server fans session frames out to every tab — dialogs and notices are
 * shared chrome (see `wantsFrame` on the server) — so what arrives is not what
 * is being read, and every consumer of a frame has to ask this first.
 *
 * `declared` is the session this tab is reading: its path, its draft id while
 * the session is still being created, or null when there is no session yet at
 * all (the hero). An unaddressed frame (`""`) belongs to that seat either way,
 * because pi only names a session file on its first `get_state` — a session's
 * first question is always published before the path exists, and it is asked
 * from the seat that is, or is about to become, a session. An addressed frame
 * belongs only to the session it names: a card for another session's question
 * would take the input box of someone answering something else
 * (`pendingUiForSession`), and a notice about another session is an
 * interruption with nothing behind it (`sessionInView`).
 */
export function seatOwns(declared: string | null, framePath: string): boolean {
  if (declared === null || isDraftSession(declared)) return framePath === "";
  return framePath === declared;
}

/**
 * Swap one path for another (or drop it) in one workspace's unsaved list.
 *
 * Returns the same map when nothing matched, so a draft that was already
 * retired does not invalidate every subscriber for no reason.
 */
function replacePath(
  unsaved: Record<string, string[]>,
  projectId: string,
  from: string,
  to: string | null,
): Record<string, string[]> {
  const paths = unsaved[projectId];
  const index = paths?.indexOf(from) ?? -1;
  if (paths === undefined || index < 0) return unsaved;
  const next = [...paths];
  if (to === null) next.splice(index, 1);
  else next[index] = to;
  return { ...unsaved, [projectId]: next };
}

/** A message typed while the session was still being created. */
export interface PendingPrompt {
  sessionPath: string;
  text: string;
  mode: "prompt" | "steer" | "followUp";
  /** Pictures pasted while the draft was open. They are part of the message. */
  images?: ImageBlock[];
  /**
   * Whether pi will consume this as an extension command.
   *
   * It is carried across the queue because it decides whether the transcript
   * gets an optimistic user turn: pi records only the message a command submits
   * itself, so drawing the typed line would leave a row nothing ever wrote.
   */
  command?: boolean;
}

export interface AppState {
  status: "loading" | "ready" | "error";
  error: string | null;
  /** Transient, dismissible message (e.g. a failed action). */
  notice: string | null;
  projects: ProjectView[];
  selectedProjectId: string | null;
  /** Sessions per project id; a missing key means "not loaded yet". */
  sessions: Record<string, SessionView[]>;
  /**
   * How many visible sessions each project has, as the server counts them.
   *
   * `sessions` holds only the page the sidebar has fetched, so the total is
   * what labels "show more" with the number of rows still folded away.
   */
  sessionTotals: Record<string, number>;
  /**
   * Projects whose first page of sessions is being fetched right now.
   *
   * A workspace that has never been listed and one that really holds nothing
   * look the same to the sidebar — `sessions` has no entry for either — so this
   * is what tells the wait apart from the empty state. Without it, expanding a
   * workspace read as "还没有会话。" for as long as the server took to walk its
   * files, which on a workspace with a hundred sessions is most of a second.
   *
   * Only a *first* read sets it (see `refreshSessions`), because that is the
   * only read that leaves the sidebar with nothing to draw: a reload behind
   * rows already on screen keeps those rows rather than a hint.
   */
  sessionsLoading: Record<string, true>;
  selectedSessionPath: string | null;
  /**
   * Session paths this browser created that pi has not written to disk yet,
   * keyed by the workspace that owns them and newest first.
   *
   * pi only creates the JSONL once the first assistant reply lands, so a new
   * session has a real path but no file for as long as its first turn runs.
   * The session list is disk-derived and cannot show it, so without this record
   * a running session would be visible only while it happens to be the open
   * conversation — switching away or starting another one would drop its row
   * out of the sidebar entirely.
   *
   * Which workspace a path belongs to cannot be inferred on the client: pi
   * encodes the cwd into the session directory with a private scheme the server
   * already has to mirror, so ownership is recorded here at creation time.
   */
  unsavedSessions: Record<string, string[]>;
  /** First-message titles while pi has not flushed the new session yet. */
  unsavedSessionTitles: Record<string, string>;
  /** Session files with a live pi process on the server. */
  activeSessions: string[];
  /**
   * Live agent activity per session path, for the sidebar's status mark.
   *
   * `"ongoing"` while a session's agent loop is running; `"done"` once it
   * settles out of view — dsh's "completed" reminder, which opening the
   * session clears. A path with no entry reads as idle. Keyed by the real
   * session path, so a draft's mark moves when its file lands.
   */
  sessionActivity: Record<string, "ongoing" | "done">;
  /** Sessions another process appended to while we held them. */
  externalChanged: Record<string, true>;
  /**
   * Extension dialogs awaiting an answer, oldest first; each blocks its own pi
   * process until answered. A queue rather than a single slot because two open
   * sessions can be blocked at once — a later request must not erase an earlier
   * one the user has not seen yet.
   */
  pendingUiRequests: PendingUiRequest[];
  /** Text submitted before its session finished spawning. */
  pendingPrompt: PendingPrompt | null;
  /**
   * The model the next new session starts on, chosen on the hero before that
   * session exists. Null means "whatever pi starts on", which is also the state
   * a fresh app is in — so this is deliberately not persisted anywhere.
   */
  newSessionModel: ComposerModel | null;
  /**
   * The thinking level the next new session starts on, chosen on the hero
   * before that session exists. Null means "whatever pi starts on"; like
   * `newSessionModel` it is in-memory only and consumed when the session is
   * created. It is a bare level string (not a `ComposerModel`) because a level
   * carries no provider to disambiguate.
   */
  newSessionThinkingLevel: string | null;
  /**
   * The composition the next new session runs, chosen on the hero before that
   * session exists. Null means the default composition.
   *
   * In-memory only, like `newSessionModel`, and for a stronger reason: a preset
   * decides the arguments pi is spawned with, so it can only ever be applied at
   * creation. Unlike the model there is nothing per project about it, which is
   * why switching workspaces keeps it.
   */
  newSessionPresetId: string | null;
  /**
   * The compositions the server offers, or null before the first read lands.
   *
   * Only the identity travels from the server; the label is this client's copy,
   * so nothing here needs a second language to exist server-side.
   */
  agentPresets: AgentPresetRow[] | null;
  /** Projects whose session list is expanded in the sidebar. */
  expandedProjects: Record<string, true>;
  /** Extra session rows revealed per project beyond the default page. */
  revealedSessions: Record<string, number>;
  /** Sidebar filter across project titles and session titles. */
  sessionQuery: string;
  searchOpen: boolean;
  /**
   * How the sidebar groups what it draws, how it orders the rows, and the
   * manual order each account was left in.
   *
   * Cached in `localStorage` rather than on the server: this is a property of
   * one browser's sidebar, not of the workspaces themselves — dsh keeps the
   * same state in its own persisted store, and the shape here is a copy of it
   * (see `sidebar-view.ts`).
   */
  sidebarView: SidebarView;
  /** Slash commands per composition, keyed by `commandsKey(projectId, presetId)`:
   * what a process registers is a property of how it was composed. */
  commands: Record<string, SlashCommand[]>;
  /**
   * Keys of `commands` whose listing came back without the process's own
   * commands — only the built-ins this UI knows.
   *
   * A partial list is kept (the built-ins still complete) but not treated as
   * final: the enumeration failed because no pi process could answer yet, and
   * the next attempt usually can. Leaving it in `commands` unmarked is what
   * used to hide every skill until a page reload.
   */
  commandsPartial: Record<string, boolean>;
  /** Host home directory; empty until known, which just leaves paths absolute. */
  home: string;
  /** UI preferences, owned by this app. */
  settings: WebSettings;
  /** Agent behaviour per project path; a missing key means "not fetched yet". */
  agentSettings: Record<string, AgentSettings>;
  /** True while the settings page replaces the conversation view. */
  settingsOpen: boolean;
  /**
   * Model providers, read from pi's `models.json`/`auth.json` by the server.
   * `null` means not loaded yet — the page shows nothing rather than an empty
   * state that reads as "you have no providers".
   */
  models: ModelsView | null;
  /**
   * Extension inventory for the workspace the page last asked about. `null`
   * means not loaded yet, same reasoning as `models`.
   */
  extensions: ExtensionsView | null;
  /**
   * MCP inventory for the workspace the page last asked about.
   */
  mcp: McpView | null;
  /**
   * Update notices, keyed by workspace path (empty string = user scope).
   *
   * Keyed rather than singular because two different questions are asked at
   * once: the settings and plugins pages resolve the *selected project* (a
   * project-local package can be behind while the global ones are current),
   * while the sidebar badge reads the user-scope answer loaded at bootstrap.
   * A single slot would let one overwrite the other.
   */
  updates: Record<string, UpdatesView>;
}

const initialState: AppState = {
  status: "loading",
  error: null,
  notice: null,
  projects: [],
  selectedProjectId: null,
  sessions: {},
  sessionTotals: {},
  sessionsLoading: {},
  selectedSessionPath: null,
  unsavedSessions: {},
  unsavedSessionTitles: {},
  activeSessions: [],
  sessionActivity: {},
  externalChanged: {},
  pendingUiRequests: [],
  pendingPrompt: null,
  newSessionModel: null,
  newSessionThinkingLevel: null,
  newSessionPresetId: null,
  agentPresets: null,
  expandedProjects: {},
  revealedSessions: {},
  sessionQuery: "",
  searchOpen: false,
  sidebarView: loadSidebarView(),
  commands: {},
  commandsPartial: {},
  home: "",
  settings: DEFAULT_SETTINGS,
  agentSettings: {},
  settingsOpen: false,
  models: null,
  extensions: null,
  mcp: null,
  updates: {},
};

/** In-flight spawn for the draft the user is currently looking at. */
let draftRequest: Promise<string | null> | null = null;

/**
 * The scope a command listing belongs to: one project, composed one way.
 *
 * Commands live inside a pi process, and that process's composition decides
 * which ones exist — a minimal session registers no prompt templates and no
 * skills, only the extensions its own arguments kept. Keying the cache by
 * project alone would let the first session of a workspace answer for every
 * other one, which is the bug this shape exists to prevent.
 */
export function commandsKey(projectId: string, presetId: string): string {
  return `${projectId}\u0000${presetId}`;
}

/** In-flight command listings per composition, so rapid switching asks once. */
const commandsRequests = new Map<string, Promise<void>>();

/**
 * Backoff for a listing that came back partial: the server answered with its
 * built-ins because no pi process could be reached yet, and a cold start takes
 * a moment. Bounded — once the delays run out the built-ins stay usable and a
 * later mount asks again.
 */
const COMMANDS_RETRY_DELAYS_MS = [1_500, 4_000, 10_000];

/** Retries already scheduled per composition, so a slow start is not a storm. */
const commandsRetries = new Map<string, number>();

/**
 * Ask again for a composition whose listing was partial.
 *
 * `loadCommands` is driven by a composer becoming known, not by a clock, so
 * without this a one-off miss while the pi process was still starting would
 * hide every skill in the menu until the page was reloaded.
 */
function scheduleCommandsRetry(projectId: string, presetId: string): void {
  const key = commandsKey(projectId, presetId);
  const attempt = commandsRetries.get(key) ?? 0;
  const delay = COMMANDS_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;
  commandsRetries.set(key, attempt + 1);
  setTimeout(() => void actions.loadCommands(projectId, presetId, true), delay);
}

/**
 * The newest session-list request per project id.
 *
 * The answer that arrives last is not necessarily the newest one — "show more"
 * can be clicked twice before either reply lands — so a late answer for an
 * older page is dropped rather than put back on screen.
 */
const sessionRequests = new Map<string, number>();

export const appStore: Store<AppState> = createStore(initialState);

/**
 * Mark (or unmark) one project's session list as being fetched.
 *
 * Written straight to the store because `refreshSessions` has no state to hand
 * back — but only when the mark really changes: the store skips the notify for
 * an identical object, and every reload of a workspace whose rows are already
 * on screen would otherwise re-render the sidebar twice for a flag nobody
 * draws. `sessionRowsOf` is the only reader.
 */
function markSessionsLoading(projectId: string, loading: boolean): void {
  appStore.update((state) => {
    if ((state.sessionsLoading[projectId] === true) === loading) return state;
    const sessionsLoading = { ...state.sessionsLoading };
    if (loading) sessionsLoading[projectId] = true;
    else delete sessionsLoading[projectId];
    return { ...state, sessionsLoading };
  });
}

/**
 * The `t()` for whichever language the current settings resolve to.
 *
 * Reading through the store instead of caching one translator at module load is
 * what makes a language switch repaint: every component that renders copy
 * subscribes, so it re-renders exactly like it does for an appearance change.
 */
/**
 * The translator for the language in effect right now.
 *
 * Actions compose user-facing notices outside React, so they cannot call a
 * hook; reading the store at call time is what keeps a notice written in the
 * language the user is actually looking at.
 */
function tr(): Translate {
  return translator(resolveLanguage(appStore.get().settings.language));
}

/**
 * The title of a session, wherever its project happens to be listed.
 *
 * Titles live in the per-project session lists while a settle event only names
 * a path, so this is the one lookup a completion notice needs. A missing title
 * is not an error: a session that just settled is by definition in the list, but
 * a not-yet-loaded project would otherwise turn a notice into a crash.
 */
function findSessionTitle(state: AppState, sessionPath: string): string | null {
  for (const sessions of Object.values(state.sessions)) {
    for (const session of sessions) {
      if (session.path === sessionPath) return session.title;
    }
  }
  return null;
}

/**
 * Which workspace owns a session path, as far as this client can tell.
 *
 * The session list is the only place the two are held together: it arrives per
 * project, so a loaded page is the authoritative answer, and `unsavedSessions`
 * names the owner of a row pi has not written to disk yet. A path in neither is
 * a workspace whose page was never loaded, and the caller leaves the selection
 * alone rather than decoding the path — see `unsavedSessions` for why that
 * cannot be done on this side.
 */
function projectIdOfSession(state: AppState, sessionPath: string): string | null {
  for (const [projectId, sessions] of Object.entries(state.sessions)) {
    if (sessions.some((session) => session.path === sessionPath)) return projectId;
  }
  for (const [projectId, paths] of Object.entries(state.unsavedSessions)) {
    if (paths.includes(sessionPath)) return projectId;
  }
  return null;
}

export function useT(): Translate {
  const preference = useStoreSelector(appStore, (state) => state.settings.language);
  return useMemo(() => translator(resolveLanguage(preference)), [preference]);
}

/**
 * The language the settings currently resolve to, for the few labels that need
 * a format rather than a message (a date reading `9月17日` or `Sep 17`).
 */
export function useLanguage(): UiLanguage {
  return resolveLanguage(useStoreSelector(appStore, (state) => state.settings.language));
}

/** High-frequency session events, delivered outside React state. */
export const sessionEvents: Emitter<{ sessionPath: string; event: SessionEvent }> =
  createEmitter();

/**
 * Fires when the event stream reconnects after a drop.
 *
 * A dropped socket means the transcript missed frames while it was away, and
 * stream deltas cannot be recovered from the next one — the frames carry the
 * delta, not a snapshot. Whoever is reading has to re-read the snapshot rather
 * than keep appending to a stream with a hole in it.
 */
export const streamRestored: Emitter<void> = createEmitter();

/**
 * Reports that files under a project's working tree changed outside this app.
 *
 * The changes panel listens so it can follow an editor save, a formatter, or a
 * terminal `git` command without a manual refresh; a Preview tab listens so an
 * open file follows the same edits. `paths` names what moved, workspace-
 * relative, or is `null` when the watcher could not attribute the change.
 */
export const workspaceChanged: Emitter<{
  projectPath: string;
  paths: string[] | null;
}> = createEmitter();

/** Test seam: restore the initial state. */
export function resetAppState(): void {
  appStore.set({ ...initialState });
  draftRequest = null;
  commandsRequests.clear();
  sessionRequests.clear();
}

export const actions = {
  async bootstrap(): Promise<void> {
    appStore.update((state) => ({ ...state, status: "loading", error: null }));
    // Fire-and-forget: this only affects how paths are displayed, so it must
    // never hold up first paint, and a failure just means paths stay absolute.
    void api
      .env()
      .then((env) => appStore.update((state) => ({ ...state, home: env.home })))
      .catch(() => undefined);
    // Same reasoning: the shell already painted with defaults that match the
    // server's, so preferences reconcile in place instead of gating the view.
    void actions.loadSettings();
    // Same reasoning again: the hero can render with the default composition,
    // and learning the rest must not gate first paint.
    void actions.loadPresets();
    // Fire-and-forget too: this only decides whether the settings entry shows
    // an update dot, and nothing on first paint should wait on the network.
    void actions.loadUpdates(null);
    // Dialogs opened before this page loaded are still pending server-side, and
    // the SSE stream carries no history — without this they would never be
    // rendered, and their pi processes would wait on nobody.
    void actions.loadPendingUiRequests();
    try {
      const projects = await api.listProjects();
      appStore.update((state) => ({ ...state, projects, status: "ready" }));
      // The first workspace is selected but deliberately left folded. Selecting
      // it is what gives the empty new-session page a target and warms a pi
      // process; opening its session list is a click the user makes. A launch
      // with several workspaces therefore lands on all of them closed, and none
      // of them is unfolded on the user's behalf.
      const first = projects[0];
      if (first) await actions.selectProject(first.id);
    } catch (err) {
      appStore.update((state) => ({
        ...state,
        status: "error",
        error: (err as Error).message,
      }));
    }
  },

  // --- settings -------------------------------------------------------------

  /** Apply UI preferences once the server confirms them. */
  async loadSettings(): Promise<void> {
    try {
      const settings = await api.getSettings();
      appStore.update((state) => ({ ...state, settings }));
      applyAppearance(settings.appearance);
      applyContentFontSize(settings.contentFontSize);
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * Persist UI preferences. The shell is updated before the request so the
   * control and its effect move together — these rows exist to change how the
   * app looks right now, and a round trip of delay reads as "nothing happened".
   */
  async updateSettings(patch: Partial<WebSettings>): Promise<void> {
    const previous = appStore.get().settings;
    const optimistic = { ...previous, ...patch };
    appStore.update((state) => ({ ...state, settings: optimistic }));
    applyAppearance(optimistic.appearance);
    applyContentFontSize(optimistic.contentFontSize);
    try {
      const settings = await api.updateSettings(patch);
      appStore.update((state) => ({ ...state, settings }));
      applyAppearance(settings.appearance);
      applyContentFontSize(settings.contentFontSize);
    } catch (err) {
      // Roll back: a rejected write must not leave the shell claiming a value
      // the server never stored.
      appStore.update((state) => ({ ...state, settings: previous }));
      applyAppearance(previous.appearance);
      applyContentFontSize(previous.contentFontSize);
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * Read agent behaviour from a live pi process. Resolves to `available: false`
   * rather than failing when no process can be reached.
   */
  async loadAgentSettings(projectPath: string): Promise<void> {
    try {
      const settings = await api.getAgentSettings(projectPath);
      appStore.update((state) => ({
        ...state,
        agentSettings: { ...state.agentSettings, [projectPath]: settings },
      }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  async updateAgentSettings(
    projectPath: string,
    patch: { autoCompaction?: boolean },
  ): Promise<void> {
    try {
      const settings = await api.updateAgentSettings(projectPath, patch);
      appStore.update((state) => ({
        ...state,
        agentSettings: { ...state.agentSettings, [projectPath]: settings },
      }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  openSettings(): void {
    appStore.update((state) => ({ ...state, settingsOpen: true }));
  },

  closeSettings(): void {
    appStore.update((state) => ({ ...state, settingsOpen: false }));
  },

  /**
   * Load provider config. Every write below answers with the same payload, so
   * this page never holds a partially-updated list.
   */
  async loadModels(): Promise<void> {
    try {
      const models = await api.getModels();
      appStore.update((state) => ({ ...state, models }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * The three writes below rethrow instead of routing through `setNotice`:
   * they run from a dialog that must stay open and show the reason inline when
   * a save is rejected, and a banner behind the dialog would be missed.
   */
  async createProvider(input: ProviderInput): Promise<void> {
    const models = await api.createProvider(input);
    appStore.update((state) => ({ ...state, models }));
    actions.setNotice(tr()("notice.saved", { id: input.id }));
  },

  async updateProvider(id: string, input: Omit<ProviderInput, "id">): Promise<void> {
    const models = await api.updateProvider(id, input);
    appStore.update((state) => ({ ...state, models }));
    actions.setNotice(tr()("notice.saved", { id }));
  },

  async deleteProvider(id: string): Promise<void> {
    const models = await api.deleteProvider(id);
    appStore.update((state) => ({ ...state, models }));
  },

  // --- extensions -----------------------------------------------------------

  /**
   * Load the extension inventory for a workspace (null = user scope only).
   *
   * A resolution failure still resolves — the server reports it in `error` — so
   * the page can render its own failure state instead of an empty list that
   * would read as "nothing installed".
   */
  async loadExtensions(projectPath: string | null): Promise<void> {
    try {
      const extensions = await api.getExtensions(projectPath);
      appStore.update((state) => ({ ...state, extensions }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * Toggle one extension. The server answers with the re-resolved list, which
   * is the only honest source here: the pattern it wrote is what pi will read,
   * and guessing the new state client-side could disagree with it.
   */
  async setExtensionEnabled(
    projectPath: string | null,
    item: { path: string; name: string },
    enabled: boolean,
  ): Promise<void> {
    try {
      const extensions = await api.setExtensionEnabled({
        projectPath,
        path: item.path,
        enabled,
      });
      appStore.update((state) => ({ ...state, extensions }));
      // Extensions are loaded when a pi process starts, and the server retires
      // every resident one after this write — so the change lands on the next
      // message, not on the next app launch.
      actions.setNotice(tr()(enabled ? "notice.enabled" : "notice.disabled", { name: item.name }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  // --- update notices ---------------------------------------------------------

  /**
   * Read both update notices for a workspace (null = user scope only).
   *
   * A failed check still resolves — the server reports it inside the payload —
   * so the page can say "could not check" instead of looking up to date. The
   * answer is stored per workspace so the sidebar badge (user scope) and the
   * settings page (selected project) do not overwrite each other.
   */
  async loadUpdates(
    projectPath: string | null,
    options: { force?: boolean } = {},
  ): Promise<void> {
    try {
      const updates = await api.getUpdates(projectPath, { refresh: options.force });
      appStore.update((state) => ({
        ...state,
        updates: { ...state.updates, [projectPath ?? ""]: updates },
      }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * Update one installed package through pi's own package manager.
   *
   * Rethrows instead of routing through `setNotice`: this runs from the row
   * that started it, which has to stay put and show progress and the reason for
   * a failure — and npm can take long enough that a banner would be missed.
   */
  async updateExtension(projectPath: string | null, source: string): Promise<void> {
    const updates = await api.updateExtension({ projectPath, source });
    appStore.update((state) => ({
      ...state,
      updates: { ...state.updates, [projectPath ?? ""]: updates },
    }));
  },

  /**
   * Update this deployment itself.
   *
   * Rethrows like `updateExtension`, and for the same reason: the row that
   * started it has to stay put and show progress, the reason for a failure, and
   * the restart the new files need before they are what is running.
   */
  async updateApp(projectPath: string | null): Promise<void> {
    const updates = await api.updateApp({ projectPath });
    appStore.update((state) => ({
      ...state,
      updates: { ...state.updates, [projectPath ?? ""]: updates },
    }));
  },

  // --- MCP -------------------------------------------------------------

  /** Load the MCP inventory for a workspace (null = user scope only). */
  async loadMcp(projectPath: string | null): Promise<void> {
    try {
      const mcp = await api.getMcp(projectPath);
      appStore.update((state) => ({ ...state, mcp }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * The three writes below rethrow instead of routing through `setNotice`: they
   * run from dialogs that must stay open and show the reason inline when the
   * server rejects them.
   */
  async saveMcpServer(input: {
    projectPath: string | null;
    scope: "global" | "project";
    originalName: string | null;
    draft: McpServerDraft;
  }): Promise<void> {
    const mcp = await api.saveMcpServer(input);
    appStore.update((state) => ({ ...state, mcp }));
    actions.setNotice(tr()("notice.savedDraft", { name: input.draft.name }));
  },

  async deleteMcpServer(projectPath: string | null, name: string): Promise<void> {
    const mcp = await api.deleteMcpServer({ projectPath, name });
    appStore.update((state) => ({ ...state, mcp }));
    actions.setNotice(tr()("notice.deleted", { name }));
  },

  /**
   * Enable or disable one server. This writes a project entry, so it reports
   * the same thing pi's own `/mcp` does for that workspace.
   */
  async setMcpServerEnabled(
    projectPath: string | null,
    name: string,
    enabled: boolean,
  ): Promise<void> {
    try {
      const mcp = await api.setMcpServerEnabled({ projectPath, name, enabled });
      appStore.update((state) => ({ ...state, mcp }));
      actions.setNotice(tr()(enabled ? "notice.enabled" : "notice.disabled", { name }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * Connect to one server. The result is returned rather than stored: it
   * belongs to the card that asked for it, and it goes stale the moment the
   * definition is edited.
   */
  async checkMcpServer(projectPath: string | null, name: string): Promise<McpProbeResult> {
    return await api.checkMcpServer({ projectPath, name });
  },

  async restartMcp(): Promise<void> {
    try {
      const result = await api.restartMcp();
      actions.setNotice(
        result.closed === 0
          ? tr()("notice.noSessions")
          : tr()("notice.restarted", { count: result.closed }),
      );
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  async refreshProjects(): Promise<void> {
    try {
      const projects = await api.listProjects();
      appStore.update((state) => {
        const stillExists = projects.some((project) => project.id === state.selectedProjectId);
        const selectedProjectId = stillExists
          ? state.selectedProjectId
          : (projects[0]?.id ?? null);
        return { ...state, projects, selectedProjectId };
      });
      const selected = appStore.get().selectedProjectId;
      if (selected) await actions.refreshSessions(selected, { force: true });
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  async selectProject(projectId: string): Promise<void> {
    appStore.update((state) => ({
      ...state,
      selectedProjectId: projectId,
      // A prompt waiting on a draft of another project must not follow us here.
      // The open conversation is deliberately left alone: expanding a
      // workspace in the sidebar should not close what you are reading.
      pendingPrompt: null,
      // Same reasoning for the model: the available list is per project, so a
      // choice made in one could name a model the next one cannot reach.
      newSessionModel: null,
      newSessionThinkingLevel: null,
    }));
    await actions.refreshSessions(projectId);
    // Warm a session while the user is deciding what to do, so the next "+"
    // resolves without paying pi's ~1.6s cold start. Failures are ignored:
    // the on-demand path in startDraftSession still works.
    void api.prewarmSession(projectId).catch(() => undefined);
    // Commands live inside the pi process, so ask for them while the user is
    // still deciding. The request joins the prewarm above on the server. The
    // default composition is what a new session gets unless the user picks
    // another one on the hero, which asks again for that composition.
    void actions.loadCommands(projectId, DEFAULT_PRESET_ID);
  },

  /** Idempotent: reveal a project's sessions without toggling them shut. */
  expandProject(projectId: string): void {
    appStore.update((state) =>
      state.expandedProjects[projectId]
        ? state
        : { ...state, expandedProjects: { ...state.expandedProjects, [projectId]: true } },
    );
  },

  /**
   * Fetch the slash commands one composition registers — extension commands,
   * prompt templates, and skill commands such as `/skill:pdf-tools`.
   *
   * Only a running process knows them, so the first call may wait on a prewarm
   * for that composition. The result is cached in state under
   * `commandsKey(projectId, presetId)`, and an empty list still counts as loaded
   * so a composition without extra commands stops re-asking.
   *
   * A listing that came back with the server's `error` is only the built-ins:
   * the process could not be reached, so the skills and templates are missing
   * rather than absent. It is stored for the completion it still offers but
   * marked partial (see `commandsPartial`) and retried, because treating it as
   * final is what made an unlucky first ask hide every skill until a reload.
   * Transport failures are swallowed: completion is an affordance, not a
   * requirement.
   */
  async loadCommands(
    projectId: string,
    presetId: string = DEFAULT_PRESET_ID,
    force = false,
  ): Promise<void> {
    const key = commandsKey(projectId, presetId);
    const cached = appStore.get().commands[key];
    const partial = appStore.get().commandsPartial[key] === true;
    if (!force && cached && !partial) return;

    const inflight = commandsRequests.get(key);
    if (inflight) return inflight;

    const request = (async (): Promise<void> => {
      try {
        const result = await api.listCommands(projectId, presetId);
        // The server echoes the composition it answered for. Trusting that over
        // the request keeps a reply that raced a preset change from landing
        // under the key that was asked for.
        const landed = commandsKey(projectId, result.presetId ?? presetId);
        const partial = result.error !== undefined;
        appStore.update((state) => {
          const commandsPartial = { ...state.commandsPartial };
          if (partial) commandsPartial[landed] = true;
          else delete commandsPartial[landed];
          return {
            ...state,
            commands: { ...state.commands, [landed]: result.commands },
            commandsPartial,
          };
        });
        if (partial) {
          console.warn(`[commands] ${projectId} ${presetId}: ${result.error}`);
          scheduleCommandsRetry(projectId, presetId);
        } else {
          commandsRetries.delete(key);
        }
      } catch (err) {
        console.warn(`[commands] ${projectId} ${presetId}: ${(err as Error).message}`);
      } finally {
        commandsRequests.delete(key);
      }
    })();

    commandsRequests.set(key, request);
    return request;
  },

  /**
   * Load (or reload) one project's page of sessions.
   *
   * Without `force` this is a no-op once the sidebar already holds everything
   * the current view would ask for: expanding a workspace that was expanded
   * before must not cost another round trip, and the server pushes
   * `sessions_changed` whenever a session file moves, so a held page cannot go
   * stale behind the user's back.
   *
   * The page size is whatever the sidebar is showing, and a search asks for the
   * whole list because it filters titles on the client rather than asking the
   * server. `focus` keeps the open conversation in the answer even when it
   * sorts below the cut.
   */
  async refreshSessions(projectId: string, options: { force?: boolean } = {}): Promise<void> {
    const before = appStore.get();
    const loaded = before.sessions[projectId];
    const total = before.sessionTotals[projectId];
    const searching = before.sessionQuery.trim().length > 0;
    // The flat list has no workspace rows, so it has no "show more" either: the
    // whole history is what it draws, and the whole history is what it asks for.
    const wholeList = searching || before.sidebarView.groupBy === "flat";
    const limit = wholeList
      ? undefined
      : (before.revealedSessions[projectId] ?? SESSIONS_PAGE_SIZE);

    if (options.force !== true && loaded !== undefined) {
      // Everything this view would draw: the page it asked for, capped by how
      // many sessions the workspace actually has.
      const wanted = limit ?? total ?? 0;
      if (loaded.length >= Math.min(wanted, total ?? wanted)) return;
    }

    const sequence = (sessionRequests.get(projectId) ?? 0) + 1;
    sessionRequests.set(projectId, sequence);
    // A workspace already holding a page has rows to draw, so its reload stays
    // invisible; only the first read has to explain itself. The mark is cleared
    // in the `finally` below — on the answer, on a dropped answer, and on a
    // failure alike.
    if (before.sessions[projectId] === undefined) markSessionsLoading(projectId, true);

    try {
      const page = await api.listSessions(projectId, {
        limit,
        focus: before.selectedSessionPath,
      });
      if (sessionRequests.get(projectId) !== sequence) return;
      appStore.update((state) => {
        const next = {
          ...state,
          sessions: { ...state.sessions, [projectId]: page.sessions },
          sessionTotals: { ...state.sessionTotals, [projectId]: page.total },
        };
        // A locally-created session whose file has landed is now a real row, so
        // its provisional entry is retired here rather than rendered twice.
        const unsaved = state.unsavedSessions[projectId];
        if (unsaved === undefined) return next;
        const onDisk = new Set(page.sessions.map((session) => session.path));
        const remaining = unsaved.filter((path) => !onDisk.has(path));
        if (remaining.length === unsaved.length) return next;
        const unsavedSessionTitles = { ...state.unsavedSessionTitles };
        for (const path of unsaved) {
          if (onDisk.has(path)) delete unsavedSessionTitles[path];
        }
        return {
          ...next,
          unsavedSessions: { ...state.unsavedSessions, [projectId]: remaining },
          unsavedSessionTitles,
        };
      });
    } catch (err) {
      actions.setNotice((err as Error).message);
    } finally {
      // Only the newest request may clear the mark: an answer superseded in
      // flight must not take down the hint its successor is still showing.
      if (sessionRequests.get(projectId) === sequence) markSessionsLoading(projectId, false);
    }
  },

  async addProject(path: string): Promise<ProjectView | null> {
    try {
      const project = await api.addProject(path);
      await actions.refreshProjects();
      await actions.selectProject(project.id);
      actions.expandProject(project.id);
      // Land on the hero so the new workspace is immediately usable.
      actions.enterNewSession();
      return project;
    } catch (err) {
      actions.setNotice((err as Error).message);
      return null;
    }
  },

  async renameProject(projectId: string, title: string): Promise<void> {
    try {
      await api.renameProject(projectId, title);
      await actions.refreshProjects();
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  async removeProject(projectId: string): Promise<void> {
    try {
      await api.removeProject(projectId);
      await actions.refreshProjects();
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * Open a session, moving the selected workspace with it.
   *
   * The header names the selected project, and every per-project surface — the
   * commands, the file paths a message is resolved against, the composer's
   * defaults — is keyed on it. Opening a session that lives in another
   * workspace therefore has to switch the workspace too; without that the
   * transcript changes while the header keeps naming the last one.
   *
   * `projectId` is the caller's own knowledge of the owner (a sidebar row knows
   * the workspace it was drawn under); left out, it is looked up from the
   * sidebar's records. Either way the open session is the authority, so the
   * workspace follows it rather than the other way around.
   */
  selectSession(sessionPath: string | null, projectId?: string): void {
    const before = appStore.get();
    const owner =
      sessionPath === null ? null : (projectId ?? projectIdOfSession(before, sessionPath));
    const changedWorkspace = owner !== null && owner !== before.selectedProjectId;
    appStore.update((state) => {
      // Opening a session is reading its result, so its completion reminder has
      // done its job. A running session keeps its mark.
      const sessionActivity = { ...state.sessionActivity };
      if (sessionPath !== null && sessionActivity[sessionPath] === "done") {
        delete sessionActivity[sessionPath];
      }
      return {
        ...state,
        selectedSessionPath: sessionPath,
        // Same workspace when the owner is unknown: a session we cannot place is
        // not a reason to move the selection somewhere arbitrary.
        ...(owner === null ? {} : { selectedProjectId: owner }),
        // A row in the sidebar sits under an expanded workspace, but a jump from
        // a notification does not — revealing the owner keeps the now-open row
        // visible rather than hidden behind a folded workspace.
        ...(owner === null
          ? {}
          : { expandedProjects: { ...state.expandedProjects, [owner]: true } }),
        // Dropping the queued prompt here is what stops it from being delivered
        // to whatever session the user opens next.
        pendingPrompt: null,
        // Leaving the new-session flow also drops the model chosen for it: the
        // session it was meant for is not the one being opened.
        newSessionModel: null,
        newSessionThinkingLevel: null,
        newSessionPresetId: null,
        sessionActivity,
      };
    });
    // A workspace whose page was never loaded has no commands and no session
    // label to name it in the header; asking for the page is the work expanding
    // its row would have done, and `refreshSessions` skips it when the page is
    // already held. Deliberately no prewarm: opening a session must not spawn a
    // pi process for a workspace the user has only glanced at.
    if (owner !== null && changedWorkspace && before.sessions[owner] === undefined) {
      void actions.refreshSessions(owner);
    }
  },

  /** Renames by writing pi's own `session_info` entry, so the CLI agrees. */
  async renameSession(sessionPath: string, name: string): Promise<void> {
    try {
      await api.renameSession(sessionPath, name);
      await actions.refreshProjects();
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /** Hides a session from the list without deleting its file. */
  async setSessionHidden(sessionPath: string, hidden: boolean): Promise<void> {
    try {
      await api.setSessionHidden(sessionPath, hidden);
      await actions.refreshProjects();
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * Delete a session file. pi's storage is the only copy, so this is the one
   * session action that can lose work — the caller confirms first.
   *
   * The notice names which happened: `trash` means it is still recoverable
   * from the system trash, `unlink` means it is gone for good.
   */
  async deleteSession(sessionPath: string): Promise<void> {
    try {
      const result = await api.deleteSession(sessionPath);
      if (appStore.get().selectedSessionPath === sessionPath) actions.selectSession(null);
      // The "changed by another process" dot and the run-state mark are keyed
      // by path too; a deleted session must not leave either behind for a
      // future session at that path.
      actions.clearExternalChanged(sessionPath);
      actions.clearSessionActivity(sessionPath);
      await actions.refreshProjects();
      actions.setNotice(
        result.method === "trash" ? tr()("notice.trashed") : tr()("notice.deletedForever"),
      );
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * Adopt a fresh session locally, then spawn its pi process in the background.
   * Returns as soon as the UI has something to render.
   */
  startDraftSession(
    projectId: string,
    initialPrompt?: string,
    images: ImageBlock[] = [],
    model: { provider: string; id: string } | null = null,
    thinkingLevel: string | null = null,
    presetId: string | null = null,
    command = false,
  ): void {
    const localId = `${DRAFT_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
    appStore.update((state) => ({
      ...state,
      selectedProjectId: projectId,
      selectedSessionPath: localId,
      // Recorded under the workspace that started it: this is what keeps the row
      // (and its still-running pi process) in the sidebar once the user looks
      // somewhere else.
      unsavedSessions: {
        ...state.unsavedSessions,
        [projectId]: [localId, ...(state.unsavedSessions[projectId] ?? [])],
      },
      pendingPrompt: null,
      // Consumed here: the choice belongs to the session being created, not to
      // whatever the user does after it exists.
      newSessionModel: null,
      newSessionThinkingLevel: null,
      newSessionPresetId: null,
      expandedProjects: { ...state.expandedProjects, [projectId]: true },
    }));

    draftRequest = api
      .createSession(projectId, model, thinkingLevel, presetId)
      .then((created) => {
        // The session exists either way; a stale model id only costs the
        // choice, so it is reported without abandoning the draft.
        if (created.modelError !== undefined) actions.setNotice(created.modelError);
        if (created.thinkingError !== undefined) actions.setNotice(created.thinkingError);
        // Queue before swapping the path in: the conversation instance that
        // mounts for the real session consumes it after its history load.
        // A first message can be a screenshot with nothing typed under it, so
        // the condition is "anything to send" rather than "text" — the same
        // rule the composer's own submit uses.
        const prompt = initialPrompt?.trim() ?? "";
        if (prompt.length > 0 || images.length > 0) {
          actions.queuePendingPrompt(created.sessionPath, prompt, "prompt", images, command);
        }
        // The draft id is replaced by the real path in place, wherever the user
        // has navigated to by now — the row follows the session, not the view.
        appStore.update((state) => ({
          ...state,
          selectedSessionPath:
            state.selectedSessionPath === localId ? created.sessionPath : state.selectedSessionPath,
          unsavedSessions: replacePath(state.unsavedSessions, projectId, localId, created.sessionPath),
          // A dialog this session asked while it was still being created arrived
          // addressed to nobody: pi reveals its session file only on the first
          // `get_state`, so the request was published before the path existed.
          // The path is written onto it with the swap below, which is what keeps
          // its card in the composer seat — the rule that seats a card reads an
          // empty address as "the session being created", and this one has just
          // stopped being that.
          pendingUiRequests: state.pendingUiRequests.map((item) =>
            item.sessionPath === "" ? { ...item, sessionPath: created.sessionPath } : item,
          ),
        }));
        return created.sessionPath;
      })
      .catch((err: unknown) => {
        actions.setNotice((err as Error).message);
        appStore.update((state) => ({
          ...state,
          selectedSessionPath: state.selectedSessionPath === localId ? null : state.selectedSessionPath,
          unsavedSessions: replacePath(state.unsavedSessions, projectId, localId, null),
        }));
        return null;
      });
  },

  /** Resolves once the draft's pi process is ready. */
  async resolveDraftSession(): Promise<string | null> {
    return draftRequest ?? null;
  },

  /**
   * Hand a message to the session that a draft is becoming. The new
   * conversation instance picks it up after its history load completes.
   */
  queuePendingPrompt(
    sessionPath: string,
    text: string,
    mode: PendingPrompt["mode"],
    images: ImageBlock[] = [],
    command = false,
  ): void {
    appStore.update((state) => ({
      ...state,
      // `images` and `command` are present only when they mean something: a
      // text-only handoff stays the same three-field object it has always been.
      pendingPrompt: {
        sessionPath,
        text,
        mode,
        ...(images.length > 0 ? { images } : {}),
        ...(command ? { command: true } : {}),
      },
    }));
  },

  /** Consume the queued message if it belongs to this session. */
  takePendingPrompt(sessionPath: string): PendingPrompt | null {
    const pending = appStore.get().pendingPrompt;
    if (!pending || pending.sessionPath !== sessionPath) return null;
    appStore.update((state) => ({ ...state, pendingPrompt: null }));
    return pending;
  },

  /** Refresh the sidebar for the project the user is currently in. */
  refreshSelectedProjectSessions(): void {
    const projectId = appStore.get().selectedProjectId;
    if (projectId) void actions.refreshSessions(projectId, { force: true });
  },

  markExternalChanged(sessionPath: string): void {    appStore.update((state) => ({
      ...state,
      externalChanged: { ...state.externalChanged, [sessionPath]: true },
    }));
  },

  clearExternalChanged(sessionPath: string): void {
    appStore.update((state) => {
      const next = { ...state.externalChanged };
      delete next[sessionPath];
      return { ...state, externalChanged: next };
    });
  },

  /** Name only a pending row, once; persisted and manually named rows win. */
  noteUnsavedSessionTitle(sessionPath: string, text: string): void {
    const state = appStore.get();
    if (state.unsavedSessionTitles[sessionPath] !== undefined
      || !Object.values(state.unsavedSessions).some((paths) => paths.includes(sessionPath))
      || Object.values(state.sessions).some((rows) => rows.some((row) => row.path === sessionPath))) return;
    // Match the default first-message title budgets; the disk-derived title
    // remains authoritative, including custom server budgets and model titles.
    const folded = text.replace(/^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>(?:\s*([\s\S]*))?$/, (_, name: string, args: string | undefined) =>
      `/skill:${name}${args?.trim() ? ` ${args.trim()}` : ""}`);
    const words = folded.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim().split(" ").filter(Boolean);
    const kept = words.slice(0, 8).join(" ");
    if (!kept) return;
    const encoder = new TextEncoder();
    let title = kept;
    if (encoder.encode(title).length > 120) {
      title = "";
      for (const char of kept) {
        if (encoder.encode(title + char).length > 117) break;
        title += char;
      }
      title = `${title.trimEnd()}…`;
    } else if (words.length > 8) title += "…";
    appStore.update((current) => ({
      ...current,
      unsavedSessionTitles: { ...current.unsavedSessionTitles, [sessionPath]: title },
    }));
  },

  /** Track run boundaries and persistence even when the session is not open. */
  noteSessionActivity(sessionPath: string, event: SessionEvent): void {
    if (event.type === "agent_start") actions.markSessionOngoing(sessionPath);
    else if (event.type === "agent_settled") actions.markSessionSettled(sessionPath);

    // User frames arrive before the first assistant reply (and before the file
    // exists). Keep this separate from disk rows: refetching must not erase the
    // title or incorrectly mark an unsaved session as persisted.
    if (event.type === "message_start" || event.type === "message_end") {
      const user = event.message as AgentMessage | undefined;
      if (user?.role === "user") {
        const text = typeof user.content === "string"
          ? user.content
          : Array.isArray(user.content)
            ? user.content.flatMap((block: unknown) => {
              if (block === null || typeof block !== "object" || !("type" in block)
                || block.type !== "text" || !("text" in block) || typeof block.text !== "string") return [];
              return [block.text];
            }).join(" ")
            : "";
        actions.noteUnsavedSessionTitle(sessionPath, text);
      }
    }

    // pi first flushes a new session when its assistant message lands. This
    // belongs to the global stream, not the conversation hook: switching away
    // must not strand the row as "Unsaved" or refresh the wrong workspace.
    const message = event.message as AgentMessage | undefined;
    if ((event.type === "message_end" && message?.role === "assistant")
      || event.type === "agent_settled") {
      const state = appStore.get();
      const owner = Object.keys(state.unsavedSessions).find((projectId) =>
        state.unsavedSessions[projectId]?.includes(sessionPath),
      );
      if (owner !== undefined) void actions.refreshSessions(owner, { force: true });
    }
  },

  markSessionOngoing(sessionPath: string): void {
    appStore.update((state) =>
      state.sessionActivity[sessionPath] === "ongoing"
        ? state
        : {
            ...state,
            sessionActivity: { ...state.sessionActivity, [sessionPath]: "ongoing" },
          },
    );
  },

  /**
   * A run finished. If the user is watching that session there is nothing to
   * remind them about, so the mark is dropped rather than turned into a
   * "completed" dot they would clear with their next click.
   */
  markSessionSettled(sessionPath: string): void {
    const before = appStore.get();
    // The dot is keyed to selection alone, because opening a session is what
    // clears it: it answers "is this the session on screen", not "is the user
    // at the screen".
    const selected = before.selectedSessionPath === sessionPath;
    appStore.update((state) => {
      const sessionActivity = { ...state.sessionActivity };
      if (selected) delete sessionActivity[sessionPath];
      else sessionActivity[sessionPath] = "done";
      return { ...state, sessionActivity };
    });

    // The completion *notice* asks the stricter question — is the user at that
    // screen at all — so a selected session in a hidden tab, or in a window the
    // user has left for another app, is exactly the case it exists for. Reading
    // selection as "watching" silenced precisely those finishes.
    //
    // Nothing else is asked of this frame. `agent_settled` is live news (the
    // stream replays no history), so a finish that arrives is one that just
    // happened, whether or not this tab saw it start: requiring the start only
    // silenced the reload-mid-run case instead of reporting it.
    if (!selected || !pageIsAttended()) actions.notifyTaskFinished(sessionPath);
  },

  /**
   * Raise a browser notification for a finished task, when the user asked for
   * one. The permission itself is left to `showNotification`'s guard instead of
   * being re-read here: a preference the browser has since revoked should not
   * silently flip itself off in the settings page.
   */
  notifyTaskFinished(sessionPath: string): void {
    if (!appStore.get().settings.browserNotifications) return;
    const state = appStore.get();
    // Resolved now rather than on click: the notice outlives this call (the page
    // may even have reloaded), and a click that lands later still has to know
    // which workspace to switch to along with the conversation.
    const owner = projectIdOfSession(state, sessionPath);
    // The app names itself in the title, because on the web that is the only
    // line of the notice it owns: the platform draws the origin above it from
    // the address, and that would otherwise be the only name the banner carries.
    // The session moves to the body, which is where the reader asking "which
    // one finished?" looks anyway.
    const sessionTitle = findSessionTitle(state, sessionPath);
    showNotification(
      APP_NAME,
      sessionTitle === null
        ? tr()("notification.taskFinished")
        : tr()("notification.taskFinishedIn", { title: sessionTitle }),
      sessionPath,
      () => {
        // Opening the session is the useful answer to "which one finished?".
        actions.selectSession(sessionPath, owner ?? undefined);
      },
    );
  },

  clearSessionActivity(sessionPath: string): void {
    appStore.update((state) => {
      if (state.sessionActivity[sessionPath] === undefined) return state;
      const sessionActivity = { ...state.sessionActivity };
      delete sessionActivity[sessionPath];
      return { ...state, sessionActivity };
    });
  },

  /**
   * Drop a locally-created session that will never reach disk.
   *
   * Its pi process being closed (idle sweep, capacity eviction, server
   * shutdown) means the first assistant reply never arrived, so nothing will
   * ever appear in the session list — leaving the row would point at a session
   * that cannot be opened.
   */
  forgetUnsavedSession(sessionPath: string): void {
    appStore.update((state) => {
      const unsaved = { ...state.unsavedSessions };
      let changed = false;
      for (const [projectId, paths] of Object.entries(unsaved)) {
        if (!paths.includes(sessionPath)) continue;
        changed = true;
        unsaved[projectId] = paths.filter((path) => path !== sessionPath);
      }
      if (!changed) return state;
      const unsavedSessionTitles = { ...state.unsavedSessionTitles };
      delete unsavedSessionTitles[sessionPath];
      return { ...state, unsavedSessions: unsaved, unsavedSessionTitles };
    });
  },

  /** Show the new-session hero: no conversation is selected. */
  enterNewSession(): void {
    appStore.update((state) => ({
      ...state,
      selectedSessionPath: null,
      pendingPrompt: null,
      // Back to pi's own default: the hero is the place the choice is made, so
      // opening it shows what pi would pick rather than the last pick.
      newSessionModel: null,
      newSessionThinkingLevel: null,
      newSessionPresetId: null,
    }));
  },

  /**
   * Remember the hero's thinking-level choice. Held in memory only, and consumed
   * by the next `startDraftSession` — see `newSessionModel` for why it is not
   * saved.
   */
  setNewSessionThinkingLevel(level: string | null): void {
    appStore.update((state) => ({ ...state, newSessionThinkingLevel: level }));
  },

  /**
   * Remember the hero's composition choice. Same lifetime as the thinking level,
   * and a stronger reason for it: a preset is the spawn arguments, so it cannot
   * be applied to a session that already exists — there is nothing to persist it
   * for, only the next creation to consume it.
   */
  setNewSessionPresetId(presetId: string | null): void {
    appStore.update((state) => ({ ...state, newSessionPresetId: presetId }));
  },

  /**
   * The compositions the server offers.
   *
   * Fire-and-forget on first paint: the hero renders with the default until this
   * lands, and a failure leaves it offering only that default rather than
   * putting an error over the composer.
   */
  async loadPresets(): Promise<void> {
    try {
      const presets = await api.listPresets();
      appStore.update((state) => ({ ...state, agentPresets: presets }));
    } catch {
      // The default composition is always offered; nothing to report.
    }
  },

  /**
   * Remember the hero's model choice. Held in memory only, and consumed by the
   * next `startDraftSession` — see `newSessionModel` for why it is not saved.
   */
  setNewSessionModel(model: ComposerModel | null): void {
    appStore.update((state) => ({ ...state, newSessionModel: model }));
  },

  toggleProjectExpanded(projectId: string): void {
    appStore.update((state) => {
      const expanded = { ...state.expandedProjects };
      if (expanded[projectId]) delete expanded[projectId];
      else expanded[projectId] = true;
      return { ...state, expandedProjects: expanded };
    });
  },

  /**
   * Reveal another page of sessions for one project.
   *
   * The rows have to be fetched: the sidebar only ever held the page it was
   * showing, so the next one is a request rather than a re-slice.
   */
  revealMoreSessions(projectId: string, nextCount: number): void {
    appStore.update((state) => ({
      ...state,
      revealedSessions: { ...state.revealedSessions, [projectId]: nextCount },
    }));
    void actions.refreshSessions(projectId, { force: true });
  },

  /**
   * Switch how the sidebar groups what it draws.
   *
   * Turning on the one-list view widens every workspace to its whole session
   * history: that view has no workspace rows — and so no "show more" — to
   * reveal the rest from, so the rest has to be here already.
   */
  setGroupBy(groupBy: SessionGroupBy): void {
    if (appStore.get().sidebarView.groupBy === groupBy) return;
    appStore.update((state) => {
      const sidebarView = { ...state.sidebarView, groupBy };
      saveSidebarView(sidebarView);
      return { ...state, sidebarView };
    });
    if (groupBy === "flat") {
      for (const project of appStore.get().projects) {
        void actions.refreshSessions(project.id);
      }
    }
  },

  /**
   * Switch the session order.
   *
   * Manual keeps an account's saved arrangement if it has one — that order is
   * the user's own work, and re-seeding it from the current recency every time
   * they glanced at `updated` for a moment would throw it away. An account with
   * nothing saved falls back to the recency order it is already showing (see
   * `reconcileManualOrder`), so the switch itself never moves a row.
   */
  setOrderBy(orderBy: SessionOrderBy): void {
    if (appStore.get().sidebarView.orderBy === orderBy) return;
    appStore.update((state) => {
      const sidebarView = { ...state.sidebarView, orderBy };
      saveSidebarView(sidebarView);
      return { ...state, sidebarView };
    });
  },

  /**
   * Save one account's manual order.
   *
   * `accountKey` is a workspace id, or `FLAT_ORDER_KEY` for the one list — dsh
   * writes both into the same map, and so does this.
   */
  setSessionOrder(accountKey: string, order: readonly string[]): void {
    appStore.update((state) => {
      const sidebarView = {
        ...state.sidebarView,
        sessionOrder: { ...state.sidebarView.sessionOrder, [accountKey]: [...order] },
      };
      saveSidebarView(sidebarView);
      return { ...state, sidebarView };
    });
  },

  /**
   * Drop one session onto another's edge.
   *
   * `order` is what the list is showing right now, and it is the caller's
   * because only the renderer knows which rows survive the current filter and
   * the revealed-page limit. A drop that changes nothing writes nothing.
   */
  moveSession(
    accountKey: string,
    order: readonly string[],
    sourceId: string,
    targetId: string,
    half: "before" | "after",
  ): void {
    const next = moveInOrder(order, sourceId, targetId, half);
    if (next === undefined) return;
    actions.setSessionOrder(accountKey, next);
  },

  /**
   * Drop one workspace onto another's edge.
   *
   * The positions go to the server rather than to a browser-local order: a
   * workspace is a real entity here and already has `PUT /api/projects/order`,
   * which dsh's Host does for its own Workspaces. `anchorId` is the workspace
   * the dragged row lands before, or undefined to land last; the caller gates
   * the drop to siblings, so an id from another subtree never arrives.
   */
  async moveProject(sourceId: string, anchorId: string | undefined): Promise<void> {
    const state = appStore.get();
    // The order the tree currently draws, which is what the ids have to be
    // listed in: the endpoint rejects a list that is not every project once.
    const ids = flattenProjectTree(
      buildProjectTree(state.projects, {
        nest: state.sidebarView.groupBy === "workspace-tree",
      }),
    ).map((node) => node.project.id);
    const next = moveWorkspace(ids, sourceId, anchorId);
    if (next === undefined) return;
    try {
      const projects = await api.reorderProjects(next);
      appStore.update((current) => ({ ...current, projects }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  setSessionQuery(sessionQuery: string): void {
    const wasSearching = appStore.get().sessionQuery.trim().length > 0;
    appStore.update((state) => ({ ...state, sessionQuery }));
    // A search screens titles on the client, so it needs the rows the paginated
    // sidebar never fetched: widen every workspace it covers to the whole list.
    // Once per search, not once per keystroke, and `refreshSessions` still
    // skips a workspace whose list is already complete.
    if (sessionQuery.trim().length > 0 && !wasSearching) {
      for (const projectId of Object.keys(appStore.get().sessions)) {
        void actions.refreshSessions(projectId);
      }
    }
  },

  openSearch(): void {
    appStore.update((state) => ({ ...state, searchOpen: true }));
  },

  /**
   * Close the search and clear it in one step.
   *
   * A collapsed field holding a filter the list is still wearing would be a
   * filter the user can neither see nor clear, so every way out — Escape, the
   * field's own clear control, a click outside an empty field — lands here.
   * dsh folds the same two writes into its `setSearchExpanded(false)` and
   * clear paths.
   */
  closeSearch(): void {
    appStore.update((state) => ({ ...state, searchOpen: false, sessionQuery: "" }));
  },

  setNotice(notice: string | null): void {
    appStore.update((state) => ({ ...state, notice }));
  },

  setActiveSessions(activeSessions: string[]): void {
    appStore.update((state) => ({ ...state, activeSessions }));
  },

  /**
   * Adopt the server's live-process list from a fresh `hello`.
   *
   * `hello` is the only frame that carries the whole handle list, and it
   * arrives on every (re)connect. A session that is running necessarily holds a
   * handle, so an "ongoing" mark with no handle lost its process while the
   * stream was down — a server restart, most likely. Retired here, because
   * otherwise the mark would keep the "Working..." label and the composer's
   * Stop button up for a run that no longer exists, and no `session_closed` is
   * coming to clear it. Distinct from `setActiveSessions`, which the
   * `session_closed` handler calls with a list it has only *removed* from and
   * which therefore cannot be treated as complete.
   */
  reconcileActiveSessions(activeSessions: string[]): void {
    appStore.update((state) => {
      const live = new Set(activeSessions);
      const stale = Object.entries(state.sessionActivity).filter(
        ([path, mark]) => mark === "ongoing" && !live.has(path),
      );
      if (stale.length === 0) return { ...state, activeSessions };
      const sessionActivity = { ...state.sessionActivity };
      for (const [path] of stale) delete sessionActivity[path];
      return { ...state, activeSessions, sessionActivity };
    });
  },

  enqueueUiRequest(pending: PendingUiRequest): void {
    appStore.update((state) => {
      // The id is pi's own uuid, so it identifies the dialog by itself. The
      // session path is metadata that moves underneath it: a fresh session has
      // no path when its extension asks, and the real one arrives a moment
      // later — matching on the pair would queue the same question twice and
      // leave the card up after it was answered.
      const index = state.pendingUiRequests.findIndex(
        (item) => item.request.id === pending.request.id,
      );
      if (index < 0) {
        return { ...state, pendingUiRequests: [...state.pendingUiRequests, pending] };
      }
      // Same dialog, now with an address: the address is what seats its card
      // (`pendingUiForSession` never guesses one), so the real path is taken as
      // soon as it arrives and never given back.
      const existing = state.pendingUiRequests[index];
      if (existing === undefined || existing.sessionPath !== "" || pending.sessionPath === "") {
        return state;
      }
      const next = [...state.pendingUiRequests];
      next[index] = pending;
      return { ...state, pendingUiRequests: next };
    });
  },

  /**
   * Reconcile against the server's live dialogs, retaining requests that arrived
   * over SSE during the fetch and never restoring a locally dismissed card.
   */
  async loadPendingUiRequests(): Promise<void> {
    const before = new Map(appStore.get().pendingUiRequests.map((item) => [item.request.id, item]));
    try {
      const { requests } = await api.listUiRequests();
      const live = new Set(requests.map((item) => item.request.id));
      appStore.update((state) => ({
        ...state,
        pendingUiRequests: state.pendingUiRequests.filter(
          (item) => before.get(item.request.id) !== item || live.has(item.request.id),
        ),
      }));
      for (const pending of requests) {
        if (before.has(pending.request.id)
          && !appStore.get().pendingUiRequests.some((item) => item.request.id === pending.request.id)) continue;
        actions.enqueueUiRequest(pending);
      }
    } catch {
      // Keep the current queue on network failure; a later sync can retry.
    }
  },

  /** A stale dialog is already closed, including when another tab answered it. */
  async respondToUiRequest(id: string, payload: Record<string, unknown>): Promise<boolean> {
    try {
      await api.respondToUiRequest(id, payload);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      actions.dismissUiRequest(id);
      await actions.loadPendingUiRequests();
      return false;
    }
    actions.dismissUiRequest(id);
    return true;
  },

  /**
   * Drop a request without answering it. Only for requests pi settled on its
   * own — a timeout resolves them agent-side, and this Web client never learns
   * about it through an event, so the card would otherwise hang around forever.
   */
  dismissUiRequest(id: string): void {
    appStore.update((state) => ({
      ...state,
      pendingUiRequests: state.pendingUiRequests.filter((item) => item.request.id !== id),
    }));
  },

  emitSessionEvent(sessionPath: string, event: SessionEvent): void {
    actions.noteSessionActivity(sessionPath, event);
    sessionEvents.emit({ sessionPath, event });
  },
};

/**
 * The desktop shell's icon badge counts the sessions that finished while the
 * user was looking elsewhere — the same marks the sidebar shows as "done".
 *
 * A store subscription rather than a component effect, because the badge
 * follows the whole app: opening a session, deleting it, or its process exiting
 * all clear a mark, and every one of those paths has to move the number. The
 * activity map is compared by reference so an unrelated state write does not
 * recount it, and `setNotificationBadge` drops a count that has not moved.
 */
let lastActivity: AppState["sessionActivity"] | null = null;
appStore.subscribe(() => {
  const activity = appStore.get().sessionActivity;
  if (activity === lastActivity) return;
  lastActivity = activity;
  setNotificationBadge(Object.values(activity).filter((mark) => mark === "done").length);
});

/**
 * A click on a shell notification opens the session it announced. The notice is
 * raised by the main process, so its click arrives here rather than at the call
 * site — this is the shell's half of what `notifyTaskFinished`'s `onClick` does
 * in a browser.
 */
subscribeNotificationClicks((sessionPath) => actions.selectSession(sessionPath));

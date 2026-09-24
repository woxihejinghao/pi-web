import { useMemo } from "react";
import { api } from "./api.ts";
import { resolveLanguage, translator, type Translate, type UiLanguage } from "./i18n/index.ts";
import { showNotification } from "./notifications.ts";
import { createEmitter, createStore, useStore, type Emitter, type Store } from "./store.ts";
import { applyAppearance, applyContentFontSize, watchSystemAppearance } from "./theme.ts";
import type {
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
  TodoView,
  UpdatesView,
  WebSettings,
} from "./types.ts";

/**
 * Mirrors the server's defaults so a slow `/api/settings` is invisible: the
 * first paint already uses these, and the fetch only ever confirms them.
 * Keep in step with `server/src/store.ts`.
 */
const DEFAULT_SETTINGS: WebSettings = {
  appearance: "system",
  language: "system",
  contentFontSize: 15,
  transcriptDisplay: "normal",
  busySendBehavior: "queue",
  todoNoticeDismissed: false,
  browserNotifications: false,
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

export function isDraftSession(sessionPath: string | null): boolean {
  return typeof sessionPath === "string" && sessionPath.startsWith(DRAFT_PREFIX);
}

/** A message typed while the session was still being created. */
export interface PendingPrompt {
  sessionPath: string;
  text: string;
  mode: "prompt" | "steer" | "followUp";
  /** Pictures pasted while the draft was open. They are part of the message. */
  images?: ImageBlock[];
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
  selectedSessionPath: string | null;
  /**
   * The workspace whose new session `selectedSessionPath` may still be
   * standing in for — a draft, or a real path the session list has not caught
   * up with yet.
   *
   * Which workspace a session path belongs to cannot be inferred on the
   * client: pi encodes the cwd into the session directory with a private
   * scheme the server already has to mirror. Naming the workspace here is what
   * lets a row render "新会话" for its own draft without claiming a session
   * opened in some other workspace.
   */
  draftProjectId: string | null;
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
  /** Projects whose session list is expanded in the sidebar. */
  expandedProjects: Record<string, true>;
  /** Extra session rows revealed per project beyond the default page. */
  revealedSessions: Record<string, number>;
  /** Sidebar filter across project titles and session titles. */
  sessionQuery: string;
  searchOpen: boolean;
  /** Slash commands per project id, as reported by a running pi process. */
  commands: Record<string, SlashCommand[]>;
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
   * Whether the task-list extension is in place, for the workspace last asked
   * about. `null` means not loaded yet — the panel shows neither tasks nor a
   * notice until the answer arrives.
   */
  todo: TodoView | null;
  /** MCP inventory for the workspace the page last asked about. */
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
  selectedSessionPath: null,
  draftProjectId: null,
  activeSessions: [],
  sessionActivity: {},
  externalChanged: {},
  pendingUiRequests: [],
  pendingPrompt: null,
  newSessionModel: null,
  expandedProjects: {},
  revealedSessions: {},
  sessionQuery: "",
  searchOpen: false,
  commands: {},
  home: "",
  settings: DEFAULT_SETTINGS,
  agentSettings: {},
  settingsOpen: false,
  models: null,
  extensions: null,
  todo: null,
  mcp: null,
  updates: {},
};

/** In-flight spawn for the draft the user is currently looking at. */
let draftRequest: Promise<string | null> | null = null;

/** In-flight command listings per project id, so rapid switching asks once. */
const commandsRequests = new Map<string, Promise<void>>();

export const appStore: Store<AppState> = createStore(initialState);

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

export function useT(): Translate {
  const preference = useStore(appStore).settings.language;
  return useMemo(() => translator(resolveLanguage(preference)), [preference]);
}

/**
 * The language the settings currently resolve to, for the few labels that need
 * a format rather than a message (a date reading `9月17日` or `Sep 17`).
 */
export function useLanguage(): UiLanguage {
  return resolveLanguage(useStore(appStore).settings.language);
}

/** High-frequency session events, delivered outside React state. */
export const sessionEvents: Emitter<{ sessionPath: string; event: SessionEvent }> =
  createEmitter();

/** Test seam: restore the initial state. */
export function resetAppState(): void {
  appStore.set({ ...initialState });
  draftRequest = null;
  commandsRequests.clear();
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
      const first = projects[0];
      if (first) {
        await actions.selectProject(first.id);
        actions.expandProject(first.id);
      }
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

  // --- the task-list extension ----------------------------------------------

  /**
   * Ask whether the extension behind pi's `todo` tool would load for this
   * workspace. A failure still resolves (the server reports broken reads as
   * `error`), so the panel can stay silent instead of offering an install for
   * something that may already be installed.
   */
  async loadTodo(projectPath: string | null): Promise<void> {
    try {
      const todo = await api.getTodo(projectPath);
      appStore.update((state) => ({ ...state, todo }));
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  },

  /**
   * Install that extension through pi's own package manager.
   *
   * Rethrows instead of routing through `setNotice`: this runs from the notice
   * itself, which has to stay put and show the reason inline when npm fails —
   * and it takes long enough that a banner behind it would be missed.
   */
  async installTodoExtension(projectPath: string | null): Promise<void> {
    const todo = await api.installTodo(projectPath);
    appStore.update((state) => ({ ...state, todo }));
    actions.setNotice(tr()("notice.todoInstalled"));
  },

  /**
   * Close the panel's install notice. Persisted because it is a preference
   * this UI owns; the same install is always available in the plugins section.
   */
  async dismissTodoNotice(): Promise<void> {
    await actions.updateSettings({ todoNoticeDismissed: true });
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

  async importMcpConfigs(projectPath: string | null, kinds: string[]): Promise<void> {
    const mcp = await api.importMcpConfigs({ projectPath, kinds });
    appStore.update((state) => ({ ...state, mcp }));
    actions.setNotice(
        tr()("notice.mcpImported", { kinds: kinds.join(tr()("notice.kindsSeparator")) }),
      );
  },

  /**
   * Enable or disable one server. This writes the workspace override, so it
   * reports the same thing the adapter's `/mcp disable` does.
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

  /**
   * Install `pi-mcp-adapter`.
   *
   * Rethrows instead of routing through `setNotice`: this is a long request
   * with a real chance of failing, and the message belongs next to the button
   * that started it rather than in a banner the user may have scrolled past.
   */
  async installMcpAdapter(projectPath: string | null): Promise<void> {
    const mcp = await api.installMcpAdapter(projectPath);
    appStore.update((state) => ({ ...state, mcp }));
    actions.setNotice(tr()("notice.mcpAdapterInstalled"));
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
      if (selected) await actions.refreshSessions(selected);
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
    }));
    await actions.refreshSessions(projectId);
    // Warm a session while the user is deciding what to do, so the next "+"
    // resolves without paying pi's ~1.6s cold start. Failures are ignored:
    // the on-demand path in startDraftSession still works.
    void api.prewarmSession(projectId).catch(() => undefined);
    // Commands live inside the pi process, so ask for them while the user is
    // still deciding. The request joins the prewarm above on the server.
    void actions.loadCommands(projectId);
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
   * Fetch the slash commands a project's pi process has registered — extension
   * commands, prompt templates, and skill commands such as `/skill:pdf-tools`.
   *
   * Only a running process knows them, so the first call may wait on the
   * project's prewarm. The result is cached in state, and an empty list still
   * counts as loaded so a project without commands stops re-asking. Failures
   * are swallowed: completion is an affordance, not a requirement.
   */
  async loadCommands(projectId: string, force = false): Promise<void> {
    if (!force && appStore.get().commands[projectId]) return;

    const inflight = commandsRequests.get(projectId);
    if (inflight) return inflight;

    const request = (async (): Promise<void> => {
      try {
        const result = await api.listCommands(projectId);
        appStore.update((state) => ({
          ...state,
          commands: { ...state.commands, [projectId]: result.commands },
        }));
        if (result.error) console.warn(`[commands] ${projectId}: ${result.error}`);
      } catch (err) {
        console.warn(`[commands] ${projectId}: ${(err as Error).message}`);
      } finally {
        commandsRequests.delete(projectId);
      }
    })();

    commandsRequests.set(projectId, request);
    return request;
  },

  async refreshSessions(projectId: string): Promise<void> {
    try {
      const sessions = await api.listSessions(projectId, true);
      appStore.update((state) => ({
        ...state,
        sessions: { ...state.sessions, [projectId]: sessions },
      }));
    } catch (err) {
      actions.setNotice((err as Error).message);
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

  selectSession(sessionPath: string | null): void {
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
        // Dropping the queued prompt here is what stops it from being delivered
        // to whatever session the user opens next.
        pendingPrompt: null,
        // Leaving the new-session flow also drops the model chosen for it: the
        // session it was meant for is not the one being opened.
        newSessionModel: null,
        sessionActivity,
      };
    });
  },

  /** Renames via a UI override; pi's own JSONL is never rewritten. */
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
  ): void {
    const localId = `${DRAFT_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
    appStore.update((state) => ({
      ...state,
      selectedProjectId: projectId,
      selectedSessionPath: localId,
      draftProjectId: projectId,
      pendingPrompt: null,
      // Consumed here: the choice belongs to the session being created, not to
      // whatever the user does after it exists.
      newSessionModel: null,
      expandedProjects: { ...state.expandedProjects, [projectId]: true },
    }));

    draftRequest = api
      .createSession(projectId, model)
      .then((created) => {
        // The session exists either way; a stale model id only costs the
        // choice, so it is reported without abandoning the draft.
        if (created.modelError !== undefined) actions.setNotice(created.modelError);
        // Queue before swapping the path in: the conversation instance that
        // mounts for the real session consumes it after its history load.
        // A first message can be a screenshot with nothing typed under it, so
        // the condition is "anything to send" rather than "text" — the same
        // rule the composer's own submit uses.
        const prompt = initialPrompt?.trim() ?? "";
        if (prompt.length > 0 || images.length > 0) {
          actions.queuePendingPrompt(created.sessionPath, prompt, "prompt", images);
        }
        // Swap in the real path only if the user is still on this draft.
        if (appStore.get().selectedSessionPath === localId) {
          appStore.update((state) => ({ ...state, selectedSessionPath: created.sessionPath }));
        }
        return created.sessionPath;
      })
      .catch((err: unknown) => {
        actions.setNotice((err as Error).message);
        if (appStore.get().selectedSessionPath === localId) {
          appStore.update((state) => ({ ...state, selectedSessionPath: null }));
        }
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
  ): void {
    appStore.update((state) => ({
      ...state,
      // `images` is present only when there are any: a text-only handoff stays
      // the same three-field object it has always been.
      pendingPrompt: {
        sessionPath,
        text,
        mode,
        ...(images.length > 0 ? { images } : {}),
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
    if (projectId) void actions.refreshSessions(projectId);
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

  /**
   * Fold an agent boundary into the sidebar's status mark.
   *
   * Called for every `session_event`, so it filters to the two boundaries that
   * matter and leaves token deltas alone.
   */
  noteSessionActivity(sessionPath: string, event: SessionEvent): void {
    if (event.type === "agent_start") actions.markSessionOngoing(sessionPath);
    else if (event.type === "agent_settled") actions.markSessionSettled(sessionPath);
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
    const watching = before.selectedSessionPath === sessionPath;
    // Only a task that was actually running can finish. Adopting a session that
    // settles without this tab having seen it start (a reload mid-run, a
    // session running elsewhere) is not a state change, and announcing it would
    // be inventing one.
    const wasRunning = before.sessionActivity[sessionPath] === "ongoing";
    appStore.update((state) => {
      const sessionActivity = { ...state.sessionActivity };
      if (watching) delete sessionActivity[sessionPath];
      else sessionActivity[sessionPath] = "done";
      return { ...state, sessionActivity };
    });

    // The completion *notice* asks whether the user can see the session; the
    // sidebar's "done" dot asks whether they might look at it next. They
    // coincide here: nothing to announce about a result already on screen.
    if (!watching && wasRunning) actions.notifyTaskFinished(sessionPath);
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
    showNotification(
      findSessionTitle(state, sessionPath) ?? "pi-web-simple",
      tr()("notification.taskFinished"),
      sessionPath,
      () => {
        // Opening the session is the useful answer to "which one finished?".
        actions.selectSession(sessionPath);
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

  /** Show the new-session hero: no conversation is selected. */
  enterNewSession(): void {
    appStore.update((state) => ({
      ...state,
      selectedSessionPath: null,
      pendingPrompt: null,
      // Back to pi's own default: the hero is the place the choice is made, so
      // opening it shows what pi would pick rather than the last pick.
      newSessionModel: null,
    }));
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

  /** Reveal another page of sessions for one project. */
  revealMoreSessions(projectId: string, nextCount: number): void {
    appStore.update((state) => ({
      ...state,
      revealedSessions: { ...state.revealedSessions, [projectId]: nextCount },
    }));
  },

  setSessionQuery(sessionQuery: string): void {
    appStore.update((state) => ({ ...state, sessionQuery }));
  },

  toggleSearch(): void {
    appStore.update((state) => ({
      ...state,
      searchOpen: !state.searchOpen,
      sessionQuery: state.searchOpen ? "" : state.sessionQuery,
    }));
  },

  setNotice(notice: string | null): void {
    appStore.update((state) => ({ ...state, notice }));
  },

  setActiveSessions(activeSessions: string[]): void {
    appStore.update((state) => ({ ...state, activeSessions }));
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
      // Same dialog, now with an address: keep the path for the jump line.
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
   * Adopt the dialogs the server is still holding. Runs once at bootstrap, so
   * it merges rather than replaces: a request pushed over SSE while this fetch
   * was in flight must not be dropped by the reply to an older question.
   */
  async loadPendingUiRequests(): Promise<void> {
    try {
      const { requests } = await api.listUiRequests();
      for (const pending of requests) actions.enqueueUiRequest(pending);
    } catch {
      // The stream is still the primary path; a failure here just means a
      // dialog that predates this page stays hidden until it is answered.
    }
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

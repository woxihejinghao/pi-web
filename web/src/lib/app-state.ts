import { api } from "./api.ts";
import { createEmitter, createStore, type Emitter, type Store } from "./store.ts";
import { applyAppearance, applyContentFontSize, watchSystemAppearance } from "./theme.ts";
import type {
  AgentSettings,
  ExtensionUiRequest,
  ModelsView,
  ProviderInput,
  SessionEvent,
  ProjectView,
  SessionView,
  SlashCommand,
  WebSettings,
} from "./types.ts";

/**
 * Mirrors the server's defaults so a slow `/api/settings` is invisible: the
 * first paint already uses these, and the fetch only ever confirms them.
 * Keep in step with `server/src/store.ts`.
 */
const DEFAULT_SETTINGS: WebSettings = {
  appearance: "system",
  contentFontSize: 14,
  transcriptDisplay: "normal",
  busySendBehavior: "queue",
};

/** A blocking extension dialog waiting on the user. */
export interface PendingUiRequest {
  sessionPath: string;
  request: ExtensionUiRequest;
}

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
  /** Session files with a live pi process on the server. */
  activeSessions: string[];
  /** Sessions another process appended to while we held them. */
  externalChanged: Record<string, true>;
  /** Extension dialog awaiting an answer; blocks that pi process until sent. */
  pendingUiRequest: PendingUiRequest | null;
  /** Text submitted before its session finished spawning. */
  pendingPrompt: PendingPrompt | null;
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
}

const initialState: AppState = {
  status: "loading",
  error: null,
  notice: null,
  projects: [],
  selectedProjectId: null,
  sessions: {},
  selectedSessionPath: null,
  activeSessions: [],
  externalChanged: {},
  pendingUiRequest: null,
  pendingPrompt: null,
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
};

/** In-flight spawn for the draft the user is currently looking at. */
let draftRequest: Promise<string | null> | null = null;

/** In-flight command listings per project id, so rapid switching asks once. */
const commandsRequests = new Map<string, Promise<void>>();

export const appStore: Store<AppState> = createStore(initialState);

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
    actions.setNotice(`已保存 ${input.id}。`);
  },

  async updateProvider(id: string, input: Omit<ProviderInput, "id">): Promise<void> {
    const models = await api.updateProvider(id, input);
    appStore.update((state) => ({ ...state, models }));
    actions.setNotice(`已保存 ${id}。`);
  },

  async deleteProvider(id: string): Promise<void> {
    const models = await api.deleteProvider(id);
    appStore.update((state) => ({ ...state, models }));
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
    appStore.update((state) => ({
      ...state,
      selectedSessionPath: sessionPath,
      // Dropping the queued prompt here is what stops it from being delivered
      // to whatever session the user opens next.
      pendingPrompt: null,
    }));
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
   * Adopt a fresh session locally, then spawn its pi process in the background.
   * Returns as soon as the UI has something to render.
   */
  startDraftSession(projectId: string, initialPrompt?: string): void {
    const localId = `${DRAFT_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
    appStore.update((state) => ({
      ...state,
      selectedProjectId: projectId,
      selectedSessionPath: localId,
      pendingPrompt: null,
      expandedProjects: { ...state.expandedProjects, [projectId]: true },
    }));

    draftRequest = api
      .createSession(projectId)
      .then((created) => {
        // Queue before swapping the path in: the conversation instance that
        // mounts for the real session consumes it after its history load.
        if (initialPrompt && initialPrompt.trim().length > 0) {
          actions.queuePendingPrompt(created.sessionPath, initialPrompt, "prompt");
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
  queuePendingPrompt(sessionPath: string, text: string, mode: PendingPrompt["mode"]): void {
    appStore.update((state) => ({ ...state, pendingPrompt: { sessionPath, text, mode } }));
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

  /** Show the new-session hero: no conversation is selected. */
  enterNewSession(): void {
    appStore.update((state) => ({
      ...state,
      selectedSessionPath: null,
      pendingPrompt: null,
    }));
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

  setPendingUiRequest(pendingUiRequest: PendingUiRequest | null): void {
    appStore.update((state) => ({ ...state, pendingUiRequest }));
  },

  emitSessionEvent(sessionPath: string, event: SessionEvent): void {
    sessionEvents.emit({ sessionPath, event });
  },
};

import type {
  AgentMessage,
  AgentSettings,
  ComposerState,
  DirListing,
  ExtensionsView,
  ForkPoint,
  ForkResult,
  ImageBlock,
  McpProbeResult,
  McpServerDraft,
  McpView,
  ModelsView,
  PendingUiDialog,
  ProjectView,
  ProviderInput,
  ProviderModelEntry,
  RpcSessionState,
  SessionTreeView,
  SessionView,
  SlashCommandList,
  StartLocation,
  TodoView,
  UpdatesView,
  WebSettings,
} from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init.body ? { "content-type": "application/json" } : undefined,
  });
  const text = await res.text();
  let payload: unknown;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }
  return payload as T;
}

const sessionId = (sessionPath: string) => encodeURIComponent(sessionPath);

/**
 * The image half of a prompt body, or nothing at all.
 *
 * Absent rather than empty on purpose: the server treats a missing `images` as
 * "this turn has no attachments", and sending `[]` on every text-only message
 * would make the two indistinguishable on the wire (and in the request log)
 * for no gain.
 */
function imageField(images: ImageBlock[]): { images: ImageBlock[] } | Record<string, never> {
  return images.length > 0 ? { images } : {};
}

export const api = {
  /** Convenience roots for the directory picker. */
  startLocations: () => request<StartLocation[]>("/api/fs/locations"),

  /** Lists sub-directories so the picker can return a real absolute path. */
  listDirectories: (path?: string) =>
    request<DirListing>(
      `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

  listProjects: () => request<ProjectView[]>("/api/projects"),

  /** Slash commands registered in a project's pi process. May have to wait for
   * the prewarm, and reports failure inline rather than as an HTTP error. */
  listCommands: (projectId: string) =>
    request<SlashCommandList>(`/api/projects/${encodeURIComponent(projectId)}/commands`),

  /** Run a built-in command (`/compact`, …). These map to their own RPC method
   * and never reach the model, so the text is not sent as a prompt. */
  runBuiltinCommand: (sessionPath: string, name: string, args: string) =>
    request<{ ok: boolean; message: string }>(
      `/api/sessions/${sessionId(sessionPath)}/command`,
      { method: "POST", body: JSON.stringify({ name, args }) },
    ),

  addProject: (path: string, title?: string) =>
    request<ProjectView>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path, title }),
    }),

  renameProject: (id: string, title: string) =>
    request<ProjectView>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  removeProject: (id: string) =>
    request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),

  reorderProjects: (ids: string[]) =>
    request<ProjectView[]>("/api/projects/order", {
      method: "PUT",
      body: JSON.stringify({ ids }),
    }),

  listSessions: (projectId: string, includeHidden = false) =>
    request<SessionView[]>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions${includeHidden ? "?includeHidden=true" : ""}`,
    ),

  createSession: (projectId: string, model?: { provider: string; id: string } | null) =>
    request<{
      sessionPath: string;
      sessionId: string;
      projectPath: string;
      prewarmed: boolean;
      /** Set when the hero's model choice could not be applied; the session
       * itself was created either way. */
      modelError?: string;
    }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId, ...(model ? { model } : {}) }),
    }),

  /** Best-effort: starts a pi process ahead of the next "new session". */
  prewarmSession: (projectId: string) =>
    request<{ ok: true; projectPath: string }>("/api/sessions/prewarm", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }),

  /** Preferences this UI owns. Cheap: read from the server's store, no pi process. */
  getSettings: () => request<WebSettings>("/api/settings"),

  updateSettings: (patch: Partial<WebSettings>) =>
    request<WebSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  /**
   * Agent behaviour that belongs to pi. May have to start a process, so this
   * resolves `available: false` rather than failing when none can be reached.
   */
  getAgentSettings: (projectPath: string) =>
    request<AgentSettings>(
      `/api/settings/agent?projectPath=${encodeURIComponent(projectPath)}`,
    ),

  updateAgentSettings: (projectPath: string, patch: { autoCompaction?: boolean }) =>
    request<AgentSettings>("/api/settings/agent", {
      method: "PUT",
      body: JSON.stringify({ projectPath, ...patch }),
    }),

  /**
   * Model providers. pi reads `models.json` and `auth.json` at startup and has
   * no RPC for them, so these edit the files directly. Every write retires the
   * resident pi processes server-side and answers with the full new state, so
   * the caller never has to reconcile a partial patch.
   */
  getModels: () => request<ModelsView>("/api/models/providers"),

  createProvider: (input: ProviderInput) =>
    request<ModelsView>("/api/models/providers", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateProvider: (id: string, input: Omit<ProviderInput, "id">) =>
    request<ModelsView>(`/api/models/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  deleteProvider: (id: string) =>
    request<ModelsView>(`/api/models/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /**
   * Ask a provider which models it serves.
   *
   * Takes the editor's *current* values rather than a saved provider, because
   * the moment this is most useful is while creating one. Nothing is written,
   * so the server does not have to retire any resident pi process.
   */
  fetchProviderModels: (input: {
    id?: string;
    baseUrl: string;
    api?: string;
    apiKey?: string;
  }) =>
    request<{ models: ProviderModelEntry[] }>("/api/models/fetch-models", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * Installed extensions, resolved by pi's own package manager from the
   * settings and package files on disk. There is no RPC for this: a running
   * session only knows what *it* loaded, while the useful question is what the
   * next pi start would load. `projectPath` adds the workspace scope.
   */
  getExtensions: (projectPath: string | null) =>
    request<ExtensionsView>(
      `/api/extensions${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ""}`,
    ),

  /**
   * Toggle one extension. The write lands in pi's settings file, so it is only
   * read back by a freshly started process — the server retires the resident
   * ones and answers with the full re-resolved list.
   */
  setExtensionEnabled: (input: {
    projectPath: string | null;
    path: string;
    enabled: boolean;
  }) =>
    request<ExtensionsView>("/api/extensions", {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  /**
   * Whether the extension pi's `todo` tool ships in is in place. The task
   * panel is a projection of that tool's output, so this is what decides
   * between showing tasks and showing the install notice.
   */
  getTodo: (projectPath: string | null) =>
    request<TodoView>(
      `/api/todo${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ""}`,
    ),

  /**
   * Install the package behind the `todo` tool, through pi's own package
   * manager (the same thing `pi install npm:@juicesharp/rpiv-todo` does). Slow
   * by nature: npm has to resolve and download, so callers keep a progress
   * state.
   */
  installTodo: (projectPath: string | null) =>
    request<TodoView>("/api/todo/install", {
      method: "POST",
      body: JSON.stringify({ projectPath }),
    }),

  /**
   * Update notices: whether a newer pi is published, and which installed pi
   * packages are behind their upstream.
   *
   * `refresh` bypasses the server's short cache — the default read reuses a
   * recent answer, so opening the settings page does not spawn a check per
   * visit. A failed check is reported in the payload rather than as an HTTP
   * error; the page renders "could not check" differently from "up to date".
   */
  getUpdates: (projectPath: string | null, options: { refresh?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (projectPath !== null && projectPath.length > 0) params.set("projectPath", projectPath);
    if (options.refresh === true) params.set("refresh", "true");
    const query = params.toString();
    return request<UpdatesView>(`/api/updates${query.length > 0 ? `?${query}` : ""}`);
  },

  /**
   * Update one installed pi package to its upstream version, through pi's own
   * package manager (the same thing `pi update <source>` does). Slow by nature:
   * npm has to resolve and download, so the caller keeps a progress state.
   */
  updateExtension: (input: { projectPath: string | null; source: string }) =>
    request<UpdatesView>("/api/updates/extensions", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * MCP servers, served through `pi-mcp-adapter`'s own config layer — pi has no
   * MCP support of its own, and a running session only knows what it already
   * connected to. The page asks what the next start would connect to.
   */
  getMcp: (projectPath: string | null) =>
    request<McpView>(
      `/api/mcp${projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : ""}`,
    ),

  /** Create or update one server. Secret values are write-only. */
  saveMcpServer: (input: {
    projectPath: string | null;
    scope: "global" | "project";
    originalName: string | null;
    draft: McpServerDraft;
  }) =>
    request<McpView>("/api/mcp/servers", { method: "PUT", body: JSON.stringify(input) }),

  deleteMcpServer: (input: { projectPath: string | null; name: string }) =>
    request<McpView>("/api/mcp/servers", { method: "DELETE", body: JSON.stringify(input) }),

  setMcpServerEnabled: (input: {
    projectPath: string | null;
    name: string;
    enabled: boolean;
  }) =>
    request<McpView>("/api/mcp/state", { method: "PUT", body: JSON.stringify(input) }),

  importMcpConfigs: (input: { projectPath: string | null; kinds: string[] }) =>
    request<McpView>("/api/mcp/imports", { method: "POST", body: JSON.stringify(input) }),

  /**
   * Connect to one server and report the handshake. Slow by nature: a cold
   * `npx` download inside the command can take a while, so the caller keeps a
   * "checking…" state rather than a spinner over the whole list.
   */
  checkMcpServer: (input: { projectPath: string | null; name: string }) =>
    request<McpProbeResult>("/api/mcp/check", { method: "POST", body: JSON.stringify(input) }),

  /** Retire the resident pi processes so the next message re-reads the config. */
  restartMcp: () =>
    request<{ ok: true; closed: number }>("/api/mcp/restart", { method: "POST" }),

  /**
   * Install the extension this section needs, through pi's own package manager
   * (the same thing `pi install npm:pi-mcp-adapter` does). Slow by nature: npm
   * has to resolve and download, so callers keep a progress state.
   */
  installMcpAdapter: (projectPath: string | null) =>
    request<McpView>("/api/mcp/install", {
      method: "POST",
      body: JSON.stringify({ projectPath }),
    }),

  getMessages: (sessionPath: string) =>
    request<{
      sessionPath: string;
      sessionId: string;
      messages: AgentMessage[];
      forkPoints: ForkPoint[];
    }>(`/api/sessions/${sessionId(sessionPath)}/messages`),

  /**
   * Fork the session at a user message. pi moves the leaf pointer rather than
   * copying, so the transcript changes and has to be reloaded afterwards.
   */
  forkSession: (sessionPath: string, entryId: string) =>
    request<ForkResult>(`/api/sessions/${sessionId(sessionPath)}/fork`, {
      method: "POST",
      body: JSON.stringify({ entryId }),
    }),

  getSessionTree: (sessionPath: string) =>
    request<SessionTreeView>(`/api/sessions/${sessionId(sessionPath)}/tree`),

  getState: (sessionPath: string) =>
    request<{ sessionPath: string; state: RpcSessionState }>(
      `/api/sessions/${sessionId(sessionPath)}/state`,
    ),

  /**
   * The input bar's model and context figures.
   *
   * Served from the session file when no process is resident, so switching to a
   * session never waits on pi. `spawn: true` is the deliberate exception: it is
   * what opening the model menu asks for, because the list of switchable models
   * only exists inside a running process.
   */
  getComposerState: (sessionPath: string, options: { spawn?: boolean } = {}) =>
    request<ComposerState>(
      `/api/sessions/${sessionId(sessionPath)}/composer${options.spawn === true ? "?spawn=true" : ""}`,
    ),

  /**
   * The same figures for a session that does not exist yet: what a new session
   * in this project would start on, and what it could switch to.
   *
   * No `spawn` option on purpose — the answer is resolved from pi's config
   * files server-side, so the new-session page can offer a model picker without
   * paying a cold start.
   */
  getProjectComposer: (projectId: string) =>
    request<ComposerState>(`/api/projects/${encodeURIComponent(projectId)}/composer`),

  /** Switch the model a session talks to; pi records it as a `model_change`. */
  setSessionModel: (sessionPath: string, provider: string, id: string) =>
    request<ComposerState>(`/api/sessions/${sessionId(sessionPath)}/model`, {
      method: "POST",
      body: JSON.stringify({ provider, id }),
    }),

  prompt: (sessionPath: string, message: string, images: ImageBlock[] = []) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message, ...imageField(images) }),
    }),

  steer: (sessionPath: string, message: string, images: ImageBlock[] = []) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/steer`, {
      method: "POST",
      body: JSON.stringify({ message, ...imageField(images) }),
    }),

  followUp: (sessionPath: string, message: string, images: ImageBlock[] = []) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/follow-up`, {
      method: "POST",
      body: JSON.stringify({ message, ...imageField(images) }),
    }),

  abort: (sessionPath: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/abort`, { method: "POST" }),

  reload: (sessionPath: string) =>
    request<{ ok: true; messages: AgentMessage[] }>(
      `/api/sessions/${sessionId(sessionPath)}/reload`,
      { method: "POST" },
    ),

  renameSession: (sessionPath: string, name: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/rename`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  setSessionHidden: (sessionPath: string, hidden: boolean) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/hidden`, {
      method: "POST",
      body: JSON.stringify({ hidden }),
    }),

  /**
   * Delete a session file. The server retires the resident process first, then
   * prefers the system trash over a permanent unlink. This is the one session
   * action that destroys data, so the caller confirms before calling it.
   */
  deleteSession: (sessionPath: string) =>
    request<{ ok: true; method: "trash" | "unlink" }>(
      `/api/sessions/${sessionId(sessionPath)}`,
      { method: "DELETE" },
    ),

  stopSession: (sessionPath: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/stop`, { method: "POST" }),

  /** Dialogs the server is still holding open; the event stream has no history. */
  listUiRequests: () => request<{ requests: PendingUiDialog[] }>("/api/ui-requests"),

  /**
   * Answer a dialog by its own id, not by session path: a session that has not
   * been written to disk yet has no path to address it by.
   */
  respondToUiRequest: (id: string, payload: Record<string, unknown>) =>
    request<{ ok: true }>(`/api/ui-requests/${encodeURIComponent(id)}/response`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  health: () => request<{ ok: boolean; activeSessions: number }>("/api/health"),

  /** Host home directory, used to shorten absolute paths to `~/...`. */
  env: () => request<{ home: string }>("/api/env"),
};

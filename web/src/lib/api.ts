import type {
  AgentMessage,
  AgentSettings,
  DirListing,
  ForkPoint,
  ForkResult,
  ModelsView,
  ProjectView,
  ProviderInput,
  ProviderModelEntry,
  RpcSessionState,
  SessionTreeView,
  SessionView,
  SlashCommandList,
  StartLocation,
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

  createSession: (projectId: string) =>
    request<{
      sessionPath: string;
      sessionId: string;
      projectPath: string;
      prewarmed: boolean;
    }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId }),
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

  prompt: (sessionPath: string, message: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  steer: (sessionPath: string, message: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/steer`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),

  followUp: (sessionPath: string, message: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/follow-up`, {
      method: "POST",
      body: JSON.stringify({ message }),
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

  stopSession: (sessionPath: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/stop`, { method: "POST" }),

  respondToExtensionUi: (sessionPath: string, payload: Record<string, unknown>) =>
    request<{ ok: true }>(`/api/sessions/${sessionId(sessionPath)}/ui-response`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  health: () => request<{ ok: boolean; activeSessions: number }>("/api/health"),

  /** Host home directory, used to shorten absolute paths to `~/...`. */
  env: () => request<{ home: string }>("/api/env"),
};

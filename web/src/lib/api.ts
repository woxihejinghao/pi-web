import type {
  AgentMessage,
  AgentPresetRow,
  AgentSettings,
  ComposerState,
  DirListing,
  ExtensionsView,
  FileApplications,
  FileSearchResult,
  ForkPoint,
  ForkResult,
  GitFileEntry,
  GitLogEntry,
  GitStatusView,
  ImageBlock,
  McpProbeResult,
  McpServerDraft,
  McpView,
  ModelsView,
  OpenFileResult,
  PendingUiDialog,
  ProjectView,
  ProviderInput,
  ProviderModelEntry,
  RpcSessionState,
  SessionListPage,
  SlashCommandList,
  StartLocation,
  TerminalCleanupFailure,
  TerminalEnvironment,
  TerminalInfo,
  TerminalSnapshot,
  TerminalShell,
  TerminalSupport,
  UpdatesView,
  WebSettings,
  WorkspaceFileContent,
  WorkspaceListing,
  WorkspaceTextPage,
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

  /**
   * One directory level of a project, for the right sidebar's file tree.
   *
   * `path` is relative to the project root (`""` lists the root itself); the
   * server rejects anything that resolves outside the project.
   */
  listWorkspaceFiles: (projectId: string, path: string) =>
    request<WorkspaceListing>(
      `/api/projects/${encodeURIComponent(projectId)}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

  /**
   * Paths under a project matching an in-progress `@` query.
   *
   * A flat search over the whole project rather than a level-by-level walk: the
   * user types a name (`@useComposer`), and the menu has to fill from one
   * keystroke. The server indexes with `git ls-files` where it can, so ignored
   * files are not offered — the same set the agent itself would find.
   */
  searchProjectFiles: (projectId: string, query: string) =>
    request<FileSearchResult>(
      `/api/projects/${encodeURIComponent(projectId)}/files/search?q=${encodeURIComponent(query)}`,
    ),

  /** One file's content, for the right sidebar's preview tab. */
  readWorkspaceFile: (projectId: string, path: string, sessionPath?: string) =>
    request<WorkspaceFileContent>(
      `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}` +
        (sessionPath === undefined ? "" : `&session=${encodeURIComponent(sessionPath)}`),
    ),

  /**
   * One page of a text file, from a byte offset the previous page ended at.
   *
   * A page rather than the whole file because the whole-file read has no good
   * answer for a large one: it ends mid-line and says so, leaving the reader at
   * the head of a log they cannot get past.
   *
   * `fromLine` is the way in when the reader wants one specific line instead of
   * the head — a reference in a message. The server scans to it once and answers
   * with the page around it, so a jump into a long file costs one request rather
   * than a walk.
   */
  readWorkspaceTextPage: (projectId: string, path: string, offset: number, fromLine?: number) =>
    request<WorkspaceTextPage>(
      `/api/projects/${encodeURIComponent(projectId)}/text?path=${encodeURIComponent(path)}` +
        `&offset=${String(offset)}` +
        (fromLine === undefined ? "" : `&fromLine=${String(fromLine)}`),
    ),

  /**
   * The URL a browser can fetch one file from directly, for the formats whose
   * only renderer is the browser's own — today, a PDF's viewer.
   *
   * A URL rather than a fetch because that is what an `<iframe>` needs, and
   * because it lets the answer be streamed, type-tagged and cached by the
   * browser instead of being inflated into JSON.
   */
  workspaceRawUrl: (projectId: string, path: string, sessionPath?: string): string =>
    `/api/projects/${encodeURIComponent(projectId)}/raw?path=${encodeURIComponent(path)}` +
    (sessionPath === undefined ? "" : `&session=${encodeURIComponent(sessionPath)}`),

  /**
   * What this machine can open one file with.
   *
   * `desktop: false` means there is no desktop to hand the path to — an ssh
   * session, a container — and the preview draws no open control at all. An
   * empty list is a different answer: the host has a desktop but no association
   * query for it, so opening and revealing still work and the menu is those two
   * actions rather than a list of applications.
   */
  fileApplications: (projectId: string, path: string) =>
    request<FileApplications>(
      `/api/projects/${encodeURIComponent(projectId)}/file/applications?path=${encodeURIComponent(path)}`,
    ),

  /**
   * Open one file in the system's default application (or a named one), or show
   * where it is.
   *
   * A refusal is an answer, not a failure: the desktop is allowed to say no, and
   * the answer says so in words the reader can act on rather than as a broken
   * panel.
   */
  openWorkspaceFile: (
    projectId: string,
    body: { path: string; action: "open" | "reveal"; application?: string },
  ) =>
    request<OpenFileResult>(`/api/projects/${encodeURIComponent(projectId)}/file/open`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /**
   * What the terminal tab can offer, and the shells already open for a session.
   *
   * Both in one call because the panel asks them at the same moment, and the
   * second is meaningless when the answer to the first is "no shells here".
   * An empty `sessionPath` asks only about the host.
   */
  terminalState: (sessionPath: string) =>
    request<{
      support: TerminalSupport;
      environment: TerminalEnvironment;
      terminals: TerminalInfo[];
    }>(`/api/terminal?sessionPath=${encodeURIComponent(sessionPath)}`),

  /** The picker's choices: installed shells, the execution default first. */
  terminalShells: () =>
    request<{ shells: TerminalShell[]; default: TerminalShell | null }>("/api/terminal/shells"),

  /** Closes whose process outlived the request, and can still be retried. */
  terminalCleanup: () =>
    request<{ failures: TerminalCleanupFailure[] }>("/api/terminal/cleanup"),

  retryTerminalCleanup: (id: string) =>
    request<{ retried: boolean }>(`/api/terminal/${encodeURIComponent(id)}/cleanup/retry`, {
      method: "POST",
    }),

  openTerminal: (body: {
    /** Client-minted so a retried create cannot open a second shell. */
    id?: string;
    sessionPath: string;
    /** The workspace to start in; the server checks it is a registered one. */
    cwd?: string;
    cols: number;
    rows: number;
    /** A path from `terminalShells`; omitted means the host's default. */
    shellPath?: string;
  }) => request<TerminalInfo>("/api/terminal", { method: "POST", body: JSON.stringify(body) }),

  /** Take input control and answer with the screen as of `sequence`. */
  attachTerminal: (id: string, attachmentId: string) =>
    request<TerminalSnapshot>(`/api/terminal/${encodeURIComponent(id)}/attach`, {
      method: "POST",
      body: JSON.stringify({ attachmentId }),
    }),

  detachTerminal: (id: string, attachmentId: string) =>
    request<{ ok: true }>(`/api/terminal/${encodeURIComponent(id)}/detach`, {
      method: "POST",
      body: JSON.stringify({ attachmentId }),
    }),

  /** The screen without taking control — used to repair a sequence gap. */
  terminalSnapshot: (id: string) =>
    request<TerminalSnapshot>(`/api/terminal/${encodeURIComponent(id)}/snapshot`),

  writeTerminal: (id: string, attachmentId: string, data: string) =>
    request<{ ok: true }>(`/api/terminal/${encodeURIComponent(id)}/input`, {
      method: "POST",
      body: JSON.stringify({ attachmentId, data }),
    }),

  resizeTerminal: (id: string, attachmentId: string, cols: number, rows: number) =>
    request<{ ok: true }>(`/api/terminal/${encodeURIComponent(id)}/resize`, {
      method: "POST",
      body: JSON.stringify({ attachmentId, cols, rows }),
    }),

  renameTerminal: (id: string, title: string) =>
    request<TerminalInfo>(`/api/terminal/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  heartbeatTerminal: (id: string, attachmentId: string) =>
    request<{ ok: true }>(`/api/terminal/${encodeURIComponent(id)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ attachmentId }),
    }),

  closeTerminal: (id: string) =>
    request<{ closed: boolean }>(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * The changes panel's state: branch, both sides of the diff, upstream drift
   * and recent history.
   *
   * `repository: false` is a 200 answer, not an error: the panel says "not a git
   * repository" rather than showing a failure over a directory that simply is
   * not one.
   */
  getGitStatus: (projectId: string) =>
    request<GitStatusView>(`/api/projects/${encodeURIComponent(projectId)}/git`),

  /**
   * Stage or unstage paths. `all` stages (or unstages) everything git currently
   * reports, which is what the section header's button means — a list of paths
   * assembled in the browser would miss a file that appeared since the last read.
   */
  stagePaths: (projectId: string, input: { paths?: string[]; all?: boolean; staged: boolean }) =>
    request<GitStatusView>(`/api/projects/${encodeURIComponent(projectId)}/git/stage`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** Commit what is staged; the reply carries the refreshed state and the new hash. */
  commitChanges: (projectId: string, message: string) =>
    request<{ view: GitStatusView; hash: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/git/commit`,
      { method: "POST", body: JSON.stringify({ message }) },
    ),

  /** Push the current branch (publishing it with `-u` when it has no upstream). */
  pushBranch: (projectId: string) =>
    request<{ view: GitStatusView; message: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/git/push`,
      { method: "POST" },
    ),

  /** Throw away the work-tree changes of the given paths. */
  discardPaths: (projectId: string, paths: string[]) =>
    request<GitStatusView>(`/api/projects/${encodeURIComponent(projectId)}/git/discard`, {
      method: "POST",
      body: JSON.stringify({ paths }),
    }),

  /** Switch to an existing local branch. */
  checkoutBranch: (projectId: string, branch: string) =>
    request<GitStatusView>(`/api/projects/${encodeURIComponent(projectId)}/git/branch`, {
      method: "POST",
      body: JSON.stringify({ branch }),
    }),

  /** Slash commands one composition registers. May have to wait for that
   * composition's prewarm, and reports failure inline rather than as an HTTP
   * error. */
  listCommands: (projectId: string, presetId?: string | null) => {
    const params = new URLSearchParams();
    if (presetId) params.set("presetId", presetId);
    const query = params.toString();
    return request<SlashCommandList>(
      `/api/projects/${encodeURIComponent(projectId)}/commands${query.length > 0 ? `?${query}` : ""}`,
    );
  },

  /** Run a built-in command (`/compact`, …). These map to their own RPC method
   * and never reach the model, so the text is not sent as a prompt. */
  runBuiltinCommand: (sessionPath: string, name: string, args: string) =>
    request<{ ok: boolean; message: string }>(
      `/api/sessions/${sessionId(sessionPath)}/command`,
      { method: "POST", body: JSON.stringify({ name, args }) },
    ),

  /** Switch plan mode. The reply carries the state the session file now holds,
   * which is the only authoritative answer — the switch itself is an extension
   * command running inside pi. */
  setSessionPlan: (sessionPath: string, active: boolean) =>
    request<{ ok: boolean; planMode: boolean }>(
      `/api/sessions/${sessionId(sessionPath)}/plan`,
      { method: "POST", body: JSON.stringify({ active }) },
    ),

  /** Plan mode as the running session holds it, which is ahead of the file. */
  getSessionPlan: (sessionPath: string) =>
    request<{ planMode: boolean }>(`/api/sessions/${sessionId(sessionPath)}/plan`),

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

  /**
   * One page of a workspace's sessions.
   *
   * `limit` is how many rows the caller can draw; the server answers with those
   * plus the total, so the sidebar can offer the rest behind "show more"
   * without holding the whole list. `focus` keeps the open conversation's
   * metadata in the page even when it sorts below the cut.
   */
  listSessions: (
    projectId: string,
    options: { limit?: number; focus?: string | null } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.focus) params.set("focus", options.focus);
    const query = params.toString();
    return request<SessionListPage>(
      `/api/projects/${encodeURIComponent(projectId)}/sessions${query.length > 0 ? `?${query}` : ""}`,
    );
  },

  createSession: (
    projectId: string,
    model?: { provider: string; id: string } | null,
    thinkingLevel?: string | null,
    presetId?: string | null,
  ) =>
    request<{
      sessionPath: string;
      sessionId: string;
      projectPath: string;
      /** The composition the process was actually started with. */
      presetId: string;
      prewarmed: boolean;
      /** Set when the hero's model choice could not be applied; the session
       * itself was created either way. */
      modelError?: string;
      /** The same, for the hero's thinking-level choice. */
      thinkingError?: string;
    }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(presetId ? { presetId } : {}),
      }),
    }),

  /**
   * The compositions a new session can be created with.
   *
   * Only identity travels; the label and its sentence are this client's copy,
   * so one list renders in either language.
   */
  listPresets: () =>
    request<{ presets: AgentPresetRow[] }>("/api/presets").then((body) => body.presets),

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
   * Move this deployment itself to the version npm calls latest.
   *
   * Slower still than a package update — npm resolves and downloads the whole
   * CLI — and the answer means "new files on disk", not "new program in
   * memory": the caller has to say that a restart is what finishes the job.
   */
  updateApp: (input: { projectPath: string | null }) =>
    request<UpdatesView>("/api/updates/app", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * MCP servers, read from pi's own `mcp.json` files — a running session only
   * knows what it already connected to, so the page asks what the next start
   * would connect to.
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

  /**
   * Switch the session's thinking level. pi records it as a
   * `thinking_level_change` and clamps an unsupported level, so the answer is
   * the level that actually took effect rather than the one that was sent.
   */
  setSessionThinking: (sessionPath: string, level: string) =>
    request<ComposerState>(`/api/sessions/${sessionId(sessionPath)}/thinking`, {
      method: "POST",
      body: JSON.stringify({ level }),
    }),

  /**
   * Recompose a session that has not started talking.
   *
   * A preset is the arguments pi was started with, so this replaces the process
   * rather than a setting — and only while the session has recorded no leading
   * system message. The server answers 409 once a turn exists (dsh's
   * `agent-preset-locked`), because the transcript would be holding tool calls
   * made under a tool set that is no longer there.
   */
  recomposeSession: (sessionPath: string, presetId: string) =>
    request<ComposerState>(`/api/sessions/${sessionId(sessionPath)}/preset`, {
      method: "POST",
      body: JSON.stringify({ presetId }),
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

  /**
   * Edit or remove one queued message.
   *
   * `index` positions the item within its mode lane and `expectedText` proves
   * the caller's view is current; the server restores the queue untouched and
   * answers 409 when the item has moved (usually because pi started sending
   * it). Editing carries text only — pi's queue holds strings, so the server
   * drops the images of a rewritten row the way dsh's editor does.
   */
  queueUpdate: (
    sessionPath: string,
    body: {
      mode: "steer" | "followUp";
      index: number;
      expectedText: string;
      action: { kind: "remove" } | { kind: "edit"; text: string };
    },
  ) =>
    request<{ ok: true; failed: string[] }>(
      `/api/sessions/${sessionId(sessionPath)}/queue/update`,
      { method: "POST", body: JSON.stringify(body) },
    ),

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

/** Shapes mirrored from the server API. Kept hand-written so the web bundle
 * never imports server (Node) code. */

export interface ProjectView {
  id: string;
  path: string;
  title: string;
  order: number;
  createdAt: string;
  updatedAt: string;
  /** Whether the directory still exists; removal never deletes it. */
  exists: boolean;
}

export type TitleSource = "override" | "session" | "firstMessage" | "fallback";

export interface SessionView {
  path: string;
  id: string;
  cwd: string;
  title: string;
  titleSource: TitleSource;
  preview: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  hidden: boolean;
}

/**
 * A command invocable by typing `/name`. pi expands skill commands
 * (`/skill:pdf-tools`) and prompt templates itself before delivering the
 * message, so the client only has to complete the text.
 *
 * `builtin` is different: pi keeps those out of `get_commands` because the TUI
 * implements them, so this server supplies both the list and the behaviour
 * (see `server/src/commands.ts`). They are executed over their own RPC method
 * and never reach the model.
 */
export type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill";

export interface SlashCommand {
  /** Command name without the leading slash, e.g. "skill:pdf-tools". */
  name: string;
  description?: string;
  /** Where the command came from; decides its section in the menu. */
  source: SlashCommandSource;
}

/** Commands live inside a pi process, so the list may come back empty with a
 * reason instead of an error status. */
export interface SlashCommandList {
  commands: SlashCommand[];
  error?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ImageBlock
  | { type: string; [key: string]: unknown };

export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
  timestamp: number;
  attachments?: unknown[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  timestamp: number;
  errorMessage?: string;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  /**
   * Tool-specific payload, opaque here because only the tool's own view reads
   * it. `todo` carries its whole-list snapshot in this field, which is what
   * makes the plan a projection of the transcript rather than UI-owned state.
   */
  details?: unknown;
  usage?: Usage;
  isError?: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number;
  cancelled: boolean;
  truncated: boolean;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | { role: string; [key: string]: unknown };

/** Streaming deltas inside `message_update`. There is no cumulative snapshot:
 * clients assemble content by `contentIndex` and treat `message_end` as final. */
export type AssistantStreamEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallBlock }
  | { type: string; contentIndex?: number; [key: string]: unknown };

export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  text?: string;
  timeout?: number;
  [key: string]: unknown;
}

/**
 * A blocking extension dialog the server is holding open.
 *
 * `sessionPath` is empty while the session has not been written to disk yet —
 * pi reveals the path only after `session_start`, where an extension asks its
 * first question. The dialog's own id is the address for answering it.
 */
export interface PendingUiDialog {
  sessionPath: string;
  request: ExtensionUiRequest;
}

export interface SessionEvent {
  type: string;
  [key: string]: unknown;
}

export interface RpcSessionState {
  model?: { provider: string; id: string; [key: string]: unknown } | null;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
  pendingMessageCount: number;
}

/** One selectable model, as the input bar's model menu renders it. */
export interface ComposerModel {
  provider: string;
  id: string;
  /** Display name from `models.json`; null falls back to the id. */
  name: string | null;
  /** 0 when unknown, matching pi's own `contextWindow ?? 0`. */
  contextWindow: number;
  reasoning: boolean;
}

/** How full the model's context window is, per pi's own estimate. */
export interface ComposerContext {
  /** null when the figure is unknown — right after a compaction, say. */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/**
 * What the composer's right-hand controls render.
 *
 * `live: false` means this was read from the session file because no pi process
 * is resident. That is enough for the model and the context figure — pi records
 * both on disk — but not for `models`, which only exists inside a running
 * process (null means "not known", not "none configured").
 */
export interface ComposerState {
  live: boolean;
  model: ComposerModel | null;
  models: ComposerModel[] | null;
  context: ComposerContext | null;
}

/** One entry in the server-side directory browser. */
export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export interface StartLocation {
  label: string;
  path: string;
}

export interface WorkspaceEntry {
  name: string;
  /** Path relative to the project root, always `/`-separated. */
  path: string;
  type: "directory" | "file" | "other";
}

/** One directory level of a project, as the right sidebar's tree reads it. */
export interface WorkspaceListing {
  /** The listed directory relative to the project root (`""` = the root). */
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

/**
 * One file for the Preview tab. `unsupported` is an answer, not a failure: the
 * server reports it with a reason so the tab can say what it cannot show.
 */
export interface WorkspaceFileContent {
  path: string;
  name: string;
  kind: "text" | "image" | "unsupported";
  size: number;
  truncated: boolean;
  /** UTF-8 text for `text`, base64 for `image`, empty for `unsupported`. */
  content: string;
  mimeType?: string;
  reason?: string;
}

/**
 * One changed file on one side of the change set. `patch` is git's own unified
 * diff for that side, parsed for drawing by `diff-parse.ts`.
 */
export interface GitFileEntry {
  /** Path relative to the project root, as git reports it. */
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  /** True when git produced no text patch because the file is binary. */
  binary: boolean;
  /** `""` for an untracked or binary file. */
  patch: string;
  truncated: boolean;
}

export interface GitLogEntry {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  /** Branch tips, remote tracking refs and tags pointing at this commit. */
  refs: string[];
}

/** The whole changes panel state: branch, both sides of the diff, and history. */
export interface GitStatusView {
  /** False when the directory is not a git work tree — a normal answer. */
  repository: boolean;
  branch: string | null;
  detached: boolean;
  /** Local branch names, most recently committed first. */
  branches: string[];
  /** Push target, e.g. `origin/main`; null when the branch has none. */
  upstream: string | null;
  behind: number;
  ahead: number;
  /** Index against HEAD. */
  staged: GitFileEntry[];
  /** Work tree against index, untracked files included. */
  unstaged: GitFileEntry[];
  omittedFiles: number;
  log: GitLogEntry[];
  /** Set when git itself could not be run (missing binary, timeout, …). */
  error?: string;
}

export type BusEvent =
  | { type: "session_event"; sessionPath: string; event: SessionEvent }
  | { type: "session_closed"; sessionPath: string; reason: string }
  | { type: "session_external_changed"; sessionPath: string; modifiedAt: string }
  | { type: "workspace_changed"; projectPath: string }
  | { type: "projects_changed" }
  | { type: "sessions_changed"; projectPath: string };

/** Appearance preference; `system` follows the host OS colour scheme. */
export type AppearancePreference = "light" | "dark" | "system";

/**
 * UI language. `system` resolves against the host locale — Chinese hosts get
 * Chinese, everything else English — so a fresh install matches the machine it
 * runs on while an explicit choice always wins over it.
 */
export type LanguagePreference = "system" | "zh-CN" | "en";

/**
 * How completed turns present their process content (thinking + tool calls).
 * `normal` keeps every process row in place; `compact` gathers a finished
 * turn's process rows into one collapsible group so the answers stay readable.
 */
export type TranscriptDisplay = "normal" | "compact";

/**
 * What a plain Enter does while the agent is running. `queue` waits for the
 * run to settle (pi's `followUp`); `steer` cuts in after the current tool calls
 * (pi's `steer`). Cmd/Ctrl+Enter always uses the other one.
 */
export type BusySendBehavior = "queue" | "steer";

/**
 * Preferences this UI owns end to end. Persisted in the server's store file,
 * never in pi's own config — none of them has a pi-side counterpart.
 */
export interface WebSettings {
  appearance: AppearancePreference;
  /** English or Chinese for the interface itself; `system` follows the host. */
  language: LanguagePreference;
  /** Conversation content font size in px. */
  contentFontSize: number;
  transcriptDisplay: TranscriptDisplay;
  busySendBehavior: BusySendBehavior;
  /** The user closed the task panel's "install rpiv-todo" notice. */
  todoNoticeDismissed: boolean;
  /**
   * Whether a finished session task raises a browser notification. Off by
   * default; turning it on is what requests the browser permission.
   */
  browserNotifications: boolean;
}

/**
 * Agent behaviour read back from a live pi process rather than mirrored.
 * `available: false` means no process could be reached, and the row must say so
 * instead of inventing a value the user would then "change" to itself.
 */
export type AgentSettings =
  | { available: false }
  | { available: true; autoCompaction: boolean };

/** Bounds for the content font size, mirroring dsh's theme schema (12..17). */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 17;

/** A model entry inside a provider. pi only requires `id`. */
export interface ProviderModelEntry {
  id: string;
  name?: string;
}

/**
 * One configured provider as the settings page renders it. Never carries a
 * secret: `configured` says a credential exists, not what it is.
 */
export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string | null;
  api: string | null;
  configured: boolean;
  /**
   * `auth` is the entry this UI writes; `inline` is a key pasted straight into
   * `models.json`, which we report but do not manage.
   */
  keySource: "auth" | "inline" | null;
  /** The id is not in pi's built-in catalog, i.e. the user invented it. */
  custom: boolean;
  models: ProviderModelEntry[];
}

/**
 * The whole model settings page. `knownProviders` and `apiProtocols` come from
 * pi with the response instead of being duplicated here, so a pi upgrade that
 * adds a provider needs no frontend change.
 */
export interface ModelsView {
  providers: ModelProvider[];
  modelsPath: string;
  authPath: string;
  knownProviders: string[];
  apiProtocols: string[];
}

/**
 * A user message pi will accept as a fork target. `entryId` is what the `fork`
 * command takes. The server sends these in transcript order; `text` rides along
 * so the UI can verify its own ordering instead of trusting position alone.
 */
export interface ForkPoint {
  entryId: string;
  text: string;
}

/**
 * Token accounting pi records on every assistant message. `totalTokens` is the
 * sum of its four parts, including cache reads, which is why a long turn's
 * number is far larger than its visible output.
 */
export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** One node of a session's entry tree, as `/tree` shows it. */
export interface SessionTreeNode {
  entry: {
    id: string;
    parentId?: string | null;
    type: string;
    timestamp?: string;
    message?: { role?: string; content?: unknown };
    [key: string]: unknown;
  };
  children: SessionTreeNode[];
  label?: string;
}

export interface SessionTreeView {
  sessionId: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  /** Whether this came from a live pi process or straight off disk. */
  source: "live" | "disk";
}

/** Result of forking: `cancelled` is true when an extension vetoed it. */
export interface ForkResult {
  ok: true;
  text: string;
  cancelled: boolean;
  sessionPath: string;
  sessionId: string;
  sessionFile: string | null;
}

/**
 * A provider write. Every field but `id` is optional, and absent means "leave
 * the stored value alone" — which is what lets a save that did not retype the
 * API key preserve it. `apiKey: ""` clears it.
 */
export interface ProviderInput {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: ProviderModelEntry[];
}

/**
 * One extension pi would consider loading, resolved by pi's own package
 * manager. `origin` and `scope` decide which settings key a toggle writes, so
 * they travel with the row rather than being re-derived on the client.
 */
export interface ExtensionItem {
  /** The entry file (or directory) pi loads; also the toggle identity. */
  path: string;
  /** Row label: file stem, directory name, or package name. */
  name: string;
  /** What contributed it: `auto`, `local`, or a package source. */
  source: string;
  scope: "user" | "project";
  origin: "top-level" | "package";
  enabled: boolean;
}

export interface ExtensionsView {
  agentDir: string;
  /** pi's global settings file. */
  settingsPath: string;
  projectPath: string | null;
  /** `<project>/.pi/settings.json`, when a workspace was resolved. */
  projectSettingsPath: string | null;
  /** pi gates project-local resources on this. */
  projectTrusted: boolean;
  extensions: ExtensionItem[];
  /**
   * Resolution failure. Present instead of an empty list so the page can tell
   * "you have no extensions" apart from "the read broke".
   */
  error: string | null;
}

/**
 * Whether the extension behind pi's `todo` tool would load on the next start.
 *
 * The task panel is a projection of that tool's transcript output, so with the
 * extension missing there is nothing to project. `installed` and `available`
 * are separate: a package can be in pi's settings but disabled, and only the
 * "not installed at all" case is worth offering an install button for.
 */
export interface TodoView {
  available: boolean;
  installed: boolean;
  packageName: string;
  source: string;
  /** Workspace the check was resolved against; null is the user scope only. */
  projectPath: string | null;
  /** A broken read (not a missing package): the notice stays hidden. */
  error: string | null;
}

/**
 * Whether a newer pi is published. Resolved by the server against pi's own
 * release endpoint — the same one the CLI polls at startup.
 */
export interface PiVersionInfo {
  /** The pi this server runs (the version of the package it imported). */
  current: string;
  /** Newest announced release, or null when it could not be determined. */
  latest: string | null;
  available: boolean;
  note: string | null;
  packageName: string;
  /** The command that moves *this server* to the newer pi. */
  updateCommand: string;
  /**
   * Why the check produced no answer. Kept apart from `available: false` so
   * the page can say "could not check" instead of claiming "up to date".
   */
  error: string | null;
  /** The check was deliberately skipped (`PI_OFFLINE` / `PI_SKIP_VERSION_CHECK`). */
  skipped: boolean;
}

/** One installed pi package pi reports as behind its upstream. */
export interface ExtensionUpdate {
  /** The source string as pi's settings record it; matches `ExtensionItem.source`. */
  source: string;
  displayName: string;
  type: "npm" | "git";
  scope: "user" | "project";
}

/**
 * Both update notices for one workspace: pi itself, and the installed packages
 * pi can compare against upstream.
 */
export interface UpdatesView {
  pi: PiVersionInfo;
  extensions: ExtensionUpdate[];
  /** A package check that broke (not "no updates"); the list stays empty. */
  extensionsError: string | null;
  /** When the server resolved this answer (epoch ms). */
  checkedAt: number;
}

/**
 * One MCP server as `pi-mcp-adapter` would load it for a workspace. Secret
 * *values* never appear here — `envKeys` and `headerKeys` are names only.
 */
export interface McpServerView {
  name: string;
  transport: "stdio" | "http" | "sse" | "socket" | "unknown";
  /** Command line, URL, or socket path — whatever the row should show. */
  detail: string;
  /** Editable fields for the editor; `args` is the joined form. */
  command: string | null;
  args: string;
  cwd: string | null;
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  auth: "oauth" | "bearer" | "none";
  enabled: boolean;
  /** The file pi would write this server's override to. */
  sourcePath: string;
  sourceKind: "user" | "project" | "import";
  importKind: string | null;
  /** True when another agent's config file owns the definition. */
  hostImport: boolean;
}

export interface McpSourceView {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  scope: "global" | "project";
  kind: "shared" | "pi";
  serverCount: number;
}

export interface McpView {
  /** False when `pi-mcp-adapter` is not installed — pi has no MCP of its own. */
  available: boolean;
  unavailableReason: string | null;
  agentDir: string;
  projectPath: string | null;
  servers: McpServerView[];
  sources: McpSourceView[];
  imports: { kind: string; path: string; serverCount: number }[];
  hostConfigs: { kind: string; path: string; serverCount: number; active: boolean }[];
  /** Detected host configs that have not been imported yet. */
  importable: { kind: string; path: string }[];
  hostConfigDiscovery: "off" | "prompt" | "on";
  conflicts: {
    serverName: string;
    sources: { kind: string; path: string }[];
    winner: { kind: string; path: string };
  }[];
  paths: { global: string; project: string; projectPi: string; piGlobal: string };
  error: string | null;
}

/** The result of a one-shot `initialize` (+ `tools/list`) connection check. */
export interface McpProbeResult {
  ok: boolean;
  message: string;
  toolCount?: number;
  serverName?: string;
  serverVersion?: string;
  durationMs: number;
}

/** One environment/header row. An empty value means "keep the stored one". */
export interface McpSecretRow {
  key: string;
  value: string;
}

export interface McpServerDraft {
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string;
  cwd: string;
  url: string;
  env: McpSecretRow[];
  headers: McpSecretRow[];
}

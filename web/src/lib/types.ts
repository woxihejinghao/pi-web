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

export type BusEvent =
  | { type: "session_event"; sessionPath: string; event: SessionEvent }
  | { type: "session_closed"; sessionPath: string; reason: string }
  | { type: "session_external_changed"; sessionPath: string; modifiedAt: string }
  | { type: "projects_changed" }
  | { type: "sessions_changed"; projectPath: string };

/** Appearance preference; `system` follows the host OS colour scheme. */
export type AppearancePreference = "light" | "dark" | "system";

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
  /** Conversation content font size in px. */
  contentFontSize: number;
  transcriptDisplay: TranscriptDisplay;
  busySendBehavior: BusySendBehavior;
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

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

export type TitleSource = "session" | "firstMessage" | "fallback";

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
 * One page of a workspace's session list, plus how many sessions the workspace
 * has in total. The sidebar renders `sessions` and labels its "show more" with
 * the difference, so it never has to hold a whole workspace's history.
 */
export interface SessionListPage {
  sessions: SessionView[];
  total: number;
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
  /** The composition the list answers for, echoed back so a reply that raced a
   * preset change lands under the key it belongs to. */
  presetId?: string;
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
  /**
   * Bare base64, no `data:` prefix — pi's own shape. Absent when the block came
   * back addressed by URL instead (a tool result's picture, see `url`).
   */
  data?: string;
  mimeType: string;
  /**
   * Where a non-inline image is fetched from, or absent for one that carries its
   * bytes. The server hands tool-result pictures out this way so a switch does
   * not ship every screenshot of a session at once; user messages keep `data`,
   * because a retry re-sends them as base64.
   */
  url?: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ImageBlock
  | { type: string; [key: string]: unknown };

/** Runtime guard for content arrays arriving from JSON or streaming events. */
export function isContentBlock(value: unknown): value is ContentBlock {
  return typeof value === "object"
    && value !== null
    && typeof (value as { type?: unknown }).type === "string";
}

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

/**
 * The checkpoint pi puts where a compaction cut the conversation.
 *
 * It is a *message*, not an entry, so it arrives with the transcript on both
 * paths (the RPC session's `messages` and `buildSessionContext()`), and it is
 * the only record of the compaction the client ever sees: everything pi folded
 * away is gone from the context, and this summary is what took its place.
 */
export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  /** pi's estimate of the context size the summary replaced. */
  tokensBefore: number;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CompactionSummaryMessage
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

/** One selectable answer inside a batched question. */
export interface AskUserQuestionOption {
  label: string;
  /** Extra context shown under the label; never part of the answer. */
  description?: string;
}

/**
 * A caller-declared presentation intent.
 *
 * It says the question *is* a known kind of decision, so a client that
 * recognises the tag may present it as such. An intent changes presentation
 * only: the answer is the same option label a generic card would send.
 */
export interface AskUserQuestionIntent {
  kind: "plan-review";
  /** The option label that approves the plan; every other label declines it. */
  approve: string;
  /**
   * The tool invocation that submitted the plan, when the asker named one.
   *
   * dsh carries it so a client can reopen the *logged* plan after the review
   * closes; the review card's "open the plan in the sidebar" is that same move
   * here, and it is also how the tab finds the document again after a reload.
   */
  callId?: string;
}

/**
 * One question of a batched request.
 *
 * The server decodes this out of the `select` an extension sent — see
 * `server/src/ask-user-codec.ts` — so a web client sees the batch itself and
 * never the encoding it travelled in.
 */
export interface AskUserQuestionItem {
  id: string;
  question: string;
  /** Short heading, used as the tab label and the card title. */
  header?: string;
  /** Supporting detail, rendered as markdown under the question. */
  detail?: string;
  /** Choices to render; absent or empty asks for a free-text answer. */
  options?: AskUserQuestionOption[];
  /** Whether more than one label may be selected. */
  multiSelect?: boolean;
  /** Presentation hint a capable client may honour. */
  intent?: AskUserQuestionIntent;
}

/** One answered question, as the extension receives it back. */
export interface AskUserQuestionAnswerItem {
  id: string;
  /** Selected labels; empty for a skipped or free-text-only answer. */
  selected: string[];
  /** Free-text answer, kept alongside `selected` for a multi-select question. */
  custom?: string;
}

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
  /** Present only on a decoded `ask_user` batch. */
  questions?: AskUserQuestionItem[];
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
  /**
   * The thinking levels this model accepts; null is "unknown", `["off"]` is
   * "this model does not reason". It lives on the model rather than the session
   * because the hero chooses the model before the session exists.
   */
  thinkingLevels: string[] | null;
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
 * is resident. That is enough for the model, the context figure and the
 * thinking level — pi records all three on disk — but not for `models`, which
 * only exists inside a running process (null means "not known", not "none
 * configured").
 */
export interface ComposerState {
  live: boolean;
  model: ComposerModel | null;
  models: ComposerModel[] | null;
  context: ComposerContext | null;
  /** The level in effect; null when nothing has recorded one. */
  thinkingLevel: string | null;
  /**
   * The composition this session runs, as its own file records it.
   *
   * Absent on the project read: that one describes a session that does not exist
   * yet, and a preset is only decided when one is created. On a session it rides
   * along with the composer figures because that read is the one request every
   * switch makes, and the conversation header picks its label from it.
   */
  presetId?: string;
  /**
   * Whether that composition is still the caller's to change.
   *
   * A preset decided the spawn arguments, so replacing it means a new process —
   * allowed only while the session has recorded no leading system message, i.e.
   * while nothing has been produced under the old composition. Once a turn
   * exists the transcript holds tool calls made under the old tool set, and the
   * header shows the label as a fact rather than a control. This is dsh's
   * `agent-preset-locked` line, measured in pi's own evidence.
   */
  presetLocked?: boolean;
  /**
   * Whether the session file exists at all.
   *
   * pi writes a session lazily — on the first real message — so before that
   * there is nothing on disk to read a mode from. A client that has just asked
   * for a mode switch holds the value locally until this says `true`, because
   * until then a read of the file cannot deny what the process already recorded.
   */
  sessionOnDisk?: boolean;
  /**
   * Whether plan mode is active on this session.
   *
   * Absent on the project read, like `presetId`: plan mode belongs to a session
   * that exists, and its state is one entry in that session's own log
   * (`server/src/session-plan.ts`). The header shows it next to the composition.
   */
  planMode?: boolean;
}

/** The composition a session runs when the caller named none. */
export const DEFAULT_PRESET_ID = "standard";

/** One selectable composition, as `GET /api/presets` reports it. */
export interface AgentPresetRow {
  id: string;
  /** The fixed system prompt, or null when the preset keeps pi's own. */
  systemPrompt: string | null;
  /** The tools declared to the model, or null for pi's default selection. */
  tools: string[] | null;
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

/** One compleable path, as the composer's `@` menu lists it. */
export interface FileSearchItem {
  /** Path relative to the project root, always `/`-separated. */
  path: string;
  /** The final segment, which is what the menu shows as the name. */
  name: string;
  type: "directory" | "file";
}

/** What one `@` query found in a project. */
export interface FileSearchResult {
  /** The query this answers, so a late response can be matched to its keystroke. */
  query: string;
  items: FileSearchItem[];
  /** True when more entries matched than the limit allowed. */
  truncated: boolean;
  /**
   * Entries the project's index holds, matched or not. `0` means the project
   * has nothing to complete from, which is a different message from "your query
   * matched nothing".
   */
  indexed: number;
}

/**
 * One file for the Preview tab. `unsupported` is an answer, not a failure: the
 * server reports it with a reason so the tab can say what it cannot show.
 */
export interface WorkspaceFileContent {
  path: string;
  name: string;
  /**
   * `pdf` is renderable, just not by anything in this bundle: the tab mounts the
   * browser's own viewer against the raw endpoint. `unsupported` is a refusal
   * with a reason.
   */
  kind: "text" | "image" | "pdf" | "unsupported";
  size: number;
  truncated: boolean;
  /** UTF-8 text for `text`, base64 for `image`, empty for `pdf`/`unsupported`. */
  content: string;
  mimeType?: string;
  reason?: string;
}

/**
 * One application the host's desktop can open a file with.
 *
 * `id` is the host's own identity for it — a macOS bundle path — and is what an
 * "open with this one" request names. It is validated on the host against the
 * current registration list, so an id that has gone stale is refused rather
 * than launched.
 */
export interface NativeApplication {
  id: string;
  name: string;
  /** Whether the operating system would pick this one for this file. */
  default: boolean;
  /** A `data:image/png;base64,…` icon, or null when the host could not read one. */
  icon: string | null;
}

/**
 * What this host can open one file with.
 *
 * `desktop: false` is the headless answer, and the only one that draws no
 * controls: there is nothing on the other end to hand a path to. An empty
 * `applications` list is not that — the desktop still opens and still reveals,
 * it just cannot say what the file is associated with.
 */
export interface FileApplications {
  desktop: boolean;
  applications: NativeApplication[];
}

/**
 * The answer to an open or reveal gesture.
 *
 * `ok: false` carries the host's own sentence about what went wrong — the
 * desktop refused, the application is gone — because that is the one thing the
 * client cannot work out for itself.
 */
export interface OpenFileResult {
  ok: boolean;
  error?: string;
}

/**
 * One page of a text file, for files too large to hand over whole.
 *
 * Addressed by the byte offset the previous page ended at rather than by line
 * number, so walking a large file reads each byte once; `lines` is what the
 * reader numbers them with.
 */
export interface WorkspaceTextPage {
  path: string;
  name: string;
  offset: number;
  nextOffset: number;
  lines: number;
  /** The file line this page starts at, when the read was addressed by line. */
  startLine?: number;
  text: string;
  size: number;
  eof: boolean;
}

/**
 * What this host can offer in a terminal tab.
 *
 * `available: false` is an answer rather than an error. `node-pty` is an
 * optional dependency and a native one, so a machine without a prebuilt binary
 * for its platform — or without a toolchain to build one — still runs
 * everything else, and the terminal entry simply is not offered.
 */
export interface TerminalSupport {
  available: boolean;
  /** One line on why not, shown wherever the terminal entry would have been. */
  reason?: string;
}

/** One shell the host found installed, with the arguments it starts it with. */
export interface TerminalShell {
  path: string;
  /** The program's own name, for menus and tab labels. */
  name: string;
  args: string[];
}

/** The states a shell can be in, as the client draws them. */
export type TerminalLifecycle = "starting" | "running" | "exited" | "failed";

export interface TerminalInfo {
  id: string;
  sessionPath: string;
  /** The user's name for it; empty until renamed. */
  title: string;
  /** The program actually started, after the host resolved the request. */
  shell: TerminalShell;
  cwd: string;
  cols: number;
  rows: number;
  state: TerminalLifecycle;
  /** null while the shell is alive; the code it left with afterwards. */
  exitCode: number | null;
  /** Set when the shell failed to start or died without an exit code. */
  error?: string;
  /**
   * The attachment allowed to type into it. Absent when nobody is attached or
   * when the shell is finished; another window seeing its own id absent knows
   * it is read-only and can ask to take control.
   */
  controllerId?: string;
}

/** The host's limits, as the client needs them for sizing and validation. */
export interface TerminalEnvironment {
  cwd: string;
  maxCols: number;
  maxRows: number;
  maxInputBytes: number;
  /** Rows the client may keep in xterm's own scrollback. */
  scrollback: number;
}

/** The opening screen of a shell, plus the sequence it is current as of. */
export interface TerminalSnapshot {
  info: TerminalInfo;
  screen: string;
  sequence: number;
}

/** A close whose process outlived the tab; the host retries it. */
export interface TerminalCleanupFailure {
  id: string;
  sessionPath: string;
  message: string;
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
  | {
      type: "terminal_output";
      terminalId: string;
      sessionPath: string;
      sequence: number;
      data: string;
    }
  | { type: "terminal_state"; terminalId: string; sessionPath: string; info: TerminalInfo }
  | { type: "terminal_closed"; terminalId: string; sessionPath: string }
  | {
      type: "terminal_cleanup_failed";
      terminalId: string;
      sessionPath: string;
      message: string;
    }
  | {
      type: "workspace_changed";
      projectPath: string;
      paths: string[] | null;
    }
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
 * How turns present their process content (thinking + tool calls). `compact`
 * and `standard` fold a running turn behind a live header and a finished turn
 * behind its completion header (compact also hides a settled reasoning row's
 * summary); `detailed` folds only the finished turn; `verbose` folds nothing.
 */
export type TranscriptDisplay = "compact" | "standard" | "detailed" | "verbose";

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
/** The provider/model pair that writes automatic session titles. */
export interface TitleModelChoice {
  provider: string;
  model: string;
}

export interface WebSettings {
  appearance: AppearancePreference;
  /** English or Chinese for the interface itself; `system` follows the host. */
  language: LanguagePreference;
  /** Conversation content font size in px. */
  contentFontSize: number;
  transcriptDisplay: TranscriptDisplay;
  busySendBehavior: BusySendBehavior;
  /**
   * Whether a finished session task raises a browser notification. Off by
   * default; turning it on is what requests the browser permission.
   */
  browserNotifications: boolean;
  /**
   * Which model writes an automatic title for a session that has none, or
   * `null` for "nobody" — the default. This is the one preference here that
   * spends money, so it is opt-in and carries its own model choice.
   */
  titleModel: TitleModelChoice | null;
}

/**
 * Agent behaviour read back from a live pi process rather than mirrored.
 * `available: false` means no process could be reached, and the row must say so
 * instead of inventing a value the user would then "change" to itself.
 */
export type AgentSettings =
  | { available: false }
  | { available: true; autoCompaction: boolean };

/** Bounds for the content font size, mirroring dsh's theme schema (10..22). */
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 22;

/**
 * A model entry inside a provider. pi only requires `id`.
 *
 * The three optional fields are the ones the model row edits directly, and all
 * of them mean "say nothing about this" when absent: pi then uses the provider's
 * own catalog entry for the model, or its built-in defaults.
 */
export interface ProviderModelEntry {
  id: string;
  name?: string;
  /** Tokens the model can hold in one conversation. */
  contextWindow?: number;
  /** Tokens the model may generate in one reply. */
  maxTokens?: number;
  /** Modalities the model accepts, from pi's `input` union. */
  input?: string[];
  /** Whether the model can be asked to think before answering. */
  reasoning?: boolean;
  /**
   * Which of pi's thinking levels this model maps to; `null` disables one. The
   * editor only ever adds or removes `xhigh` and `max` — the levels below them
   * exist as soon as `reasoning` is true — so the rest of the map may hold
   * hand-written entries that must survive a save.
   */
  thinkingLevelMap?: Record<string, string | null>;
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

export interface PromptDocument {
  scope: "global" | "workspace";
  path: string;
  content: string;
  exists: boolean;
  active: boolean;
}

export interface PromptsView {
  global: PromptDocument;
  workspace: PromptDocument | null;
  workspacePath: string | null;
}


export interface SkillItem {
  name: string;
  description: string;
  path: string;
  scope: "user" | "project";
  enabled: boolean;
  content: string;
  source: string;
}

export interface SkillsView {
  agentDir: string;
  projectPath: string | null;
  projectTrusted: boolean;
  skillsPath: string;
  projectSkillsPath: string | null;
  skills: SkillItem[];
  error: string | null;
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

/**
 * Whether a newer pi-web-simple is published, resolved by the server against
 * the npm registry. Same shape as `PiVersionInfo` so one rule can render both.
 */
export interface AppVersionInfo {
  /** The running copy's version, or null when the server could not read it. */
  current: string | null;
  /** Newest version npm serves under the `latest` tag, or null. */
  latest: string | null;
  available: boolean;
  packageName: string;
  /** The update command, or the release page in the desktop shell. */
  updateCommand: string;
  /** False in the desktop shell, where this service cannot carry the update out. */
  managed: boolean;
  /** Why the check produced no answer — same rule as `PiVersionInfo.error`. */
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
  /** Whether pi-web-simple itself is behind the npm registry. */
  app: AppVersionInfo;
  extensions: ExtensionUpdate[];
  /** A package check that broke (not "no updates"); the list stays empty. */
  extensionsError: string | null;
  /** When the server resolved this answer (epoch ms). */
  checkedAt: number;
}

/**
 * One MCP server as pi's own loader would resolve it for a workspace. Secret
 * *values* never appear here — `envKeys` and `headerKeys` are names only.
 */
export interface McpServerView {
  name: string;
  transport: "stdio" | "http" | "unknown";
  /** Command line or URL — whatever the row should show. */
  detail: string;
  /** Editable fields for the editor; `args` is the joined form. */
  command: string | null;
  args: string;
  cwd: string | null;
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  /** `oauth` is the default for an HTTP server without an Authorization header. */
  auth: "oauth" | "provider" | "none";
  enabled: boolean;
  /** The file this definition comes from; what an edit or delete targets. */
  sourcePath: string;
  sourceKind: "user" | "project";
}

export interface McpView {
  agentDir: string;
  projectPath: string | null;
  servers: McpServerView[];
  /** Problems read from the config files; the list still renders without them. */
  errors: string[];
  paths: { global: string; project: string };
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
  transport: "stdio" | "http";
  command: string;
  args: string;
  cwd: string;
  url: string;
  env: McpSecretRow[];
  headers: McpSecretRow[];
}

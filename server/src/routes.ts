import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { SessionManager, type RpcClient } from "@earendil-works/pi-coding-agent";
import { wantsFrame, type EventBus } from "./bus.ts";
import { BUILTIN_COMMANDS, runBuiltinCommand } from "./commands.ts";
import { badRequest, conflict, forbidden, HttpError, notFound } from "./errors.ts";
import type { StaticHandler } from "./static.ts";
import {
  ExtensionConfigError,
  readExtensions,
  setExtensionEnabled,
} from "./extensions.ts";
import {
  UpdatesConfigError,
  readUpdates,
  updateApp,
  updateExtension,
} from "./updates.ts";
import {
  readPrompts,
  savePrompt,
} from "./prompts.ts";
import {
  readSkills,
  readSkill,
  setSkillEnabled,
} from "./skills.ts";
import {
  McpConfigError,
  deleteMcpServer,
  probeMcpServer,
  readMcp,
  saveMcpServer,
  setMcpServerEnabled,
  type McpSecretRow,
  type McpServerDraft,
} from "./mcp.ts";
import { listDirectories, startLocations } from "./fs-browse.ts";
import {
  GitError,
  gitCheckout,
  gitCommit,
  gitDiscard,
  gitPush,
  gitStage,
  gitStageAll,
  readGitStatus,
} from "./git.ts";
import {
  readWorkspaceFile,
  readWorkspaceRaw,
  readWorkspaceTextPage,
  resolveWorkspaceFile,
  listWorkspaceDirectory,
} from "./workspace-files.ts";
import {
  canOpenNatively,
  listFileApplications,
  openFileWithApplication,
  openFileWithDefault,
  revealFile,
  type NativeApplication,
} from "./open-with.ts";
import { DEFAULT_LIMIT, searchWorkspaceFiles } from "./file-search.ts";
import { TerminalManager, type TerminalHost } from "./terminal.ts";
import { pendingUiRequests, type PendingUiRequests } from "./ui-requests.ts";
import {
  ConflictAfterRequeue,
  mutateQueue,
  parseQueueMode,
  recordEnqueue,
  type QueueAction,
} from "./queue.ts";
import {
  THINKING_LEVELS,
  readComposerFromClient,
  readComposerFromDefaults,
  readComposerFromDisk,
  type ComposerState,
} from "./composer.ts";
import {
  API_PROTOCOLS,
  KNOWN_PROVIDERS,
  ModelConfigError,
  authPath,
  deleteProvider,
  fetchProviderModels,
  modelsPath,
  readModelCatalog,
  readProviders,
  saveProvider,
  type FetchModelsInput,
  type ProviderInput,
  type ProviderModelEntry,
} from "./models.ts";
import {
  addProject,
  getProject,
  listProjects,
  ProjectError,
  removeProject,
  renameProject,
  reorderProjects,
  setSessionOverride,
} from "./projects.ts";
import { type SessionHandle, type SessionRegistry, type SlashCommand } from "./registry.ts";
import { DEFAULT_PRESET_ID, findPreset, listPresets } from "./presets.ts";
import { deleteSession } from "./session-delete.ts";
import { openSessionForRead } from "./session-open.ts";
import { presetIdOfSession, readSessionComposition } from "./session-preset.ts";
import { readSessionPlanActive, planActiveOfEntries } from "./session-plan.ts";
import { assertAllowedSessionPath, getSessionRoot, sessionDirFor } from "./session-path.ts";
import { readSessionSnapshot } from "./session-reader.ts";
import {
  collectSessionImages,
  isLiveImageVersion,
  readSessionImage,
  sessionImageVersion,
  withToolResultImageUrls,
  type SessionImage,
} from "./session-images.ts";
import { setSessionTitle } from "./session-title.ts";
import { listSessions } from "./sessions.ts";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  mutateStore,
  readStore,
  type AppearancePreference,
  type BusySendBehavior,
  type LanguagePreference,
  type TitleModelChoice,
  type TranscriptDisplay,
} from "./store.ts";
import { REQUEST_BODY_MAX_BYTES, SSE_MAX_BUFFERED_BYTES } from "./config.ts";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: RequestContext) => Promise<void> | void;

/**
 * The host-side half of "open with": what this machine's desktop can do with
 * one file.
 *
 * An interface rather than four imports at the call sites, because a route test
 * has to be able to say what was launched without launching it — the same
 * reason the terminal routes take a host.
 */
export interface OpenWithHost {
  /** Whether a desktop can take a launch at all. */
  canOpen(): boolean;
  /** The applications registered for this file, in the operating system's order. */
  applications(absolutePath: string): Promise<NativeApplication[]>;
  /** Open with the default application, or with the named one. */
  open(absolutePath: string, application: string | null): Promise<void>;
  /** Show the file in the desktop's file manager. */
  reveal(absolutePath: string): Promise<void>;
}

/** The real desktop, which is what the server and the app both want. */
const nativeOpenWith: OpenWithHost = {
  canOpen: canOpenNatively,
  applications: (absolutePath) => listFileApplications(absolutePath),
  open: (absolutePath, application) =>
    application === null ? openFileWithDefault(absolutePath) : openFileWithApplication(absolutePath, application),
  reveal: (absolutePath) => revealFile(absolutePath),
};

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export interface RouteDeps {
  registry: SessionRegistry;
  bus: EventBus;
  /** Directory the API is allowed to open sessions from. Defaults to pi's store. */
  sessionRoot?: string;
  /** Blocking extension dialogs. Defaults to the process-wide table. */
  uiRequests?: PendingUiRequests;
  /**
   * Serves the built front end for everything outside `/api`. Null (or
   * omitted) leaves the server API-only, which is what the dev setup wants:
   * Vite owns the browser-facing port there and proxies `/api` here.
   */
  staticHandler?: StaticHandler | null;
  /**
   * Bytes one SSE connection may buffer before it is dropped. Defaults to
   * `SSE_MAX_BUFFERED_BYTES`; tests lower it to reach the limit in a few writes.
   */
  sseMaxBufferedBytes?: number;
  /** Maximum JSON request body size. Tests lower it to exercise 413 handling. */
  requestBodyMaxBytes?: number;
  /**
   * The shells behind `/api/terminal`. Defaults to a manager owned by this
   * handler, which is what the server and every test want: one handler means
   * one set of shells, torn down with it. A test supplies a stand-in when it
   * cares about which shell the routes ask for rather than about the shell.
   */
  terminals?: TerminalHost;
  /**
   * The desktop behind `/api/projects/:id/file/open`. Defaults to this host's
   * own opener; a test supplies a stand-in when it cares about what was
   * launched rather than about launching it.
   */
  openWith?: OpenWithHost;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * One image's bytes on the wire, under a URL that names them.
 *
 * The URL carries the version the bytes were current for, so they cannot change
 * under it and the browser may keep them as long as it likes. The type header is
 * a promise about the body, so a body that is not really that image must not be
 * allowed to claim otherwise.
 */
function sendImage(res: ServerResponse, image: SessionImage): void {
  const bytes = Buffer.from(image.data, "base64");
  res.writeHead(200, {
    "content-type": image.mimeType,
    "content-length": bytes.byteLength,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  res.end(bytes);
}

async function readJsonBody(req: IncomingMessage, limit = REQUEST_BODY_MAX_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, "request body too large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("invalid JSON body");
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("expected a JSON object body");
  }
  return body as Record<string, unknown>;
}

/** Narrow a patch field to one of its allowed literals, or reject the write. */
function requireChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * Out-of-range font sizes are rejected rather than clamped. A settings field
 * that quietly stores a different number than the one that was typed is worse
 * than one that refuses the write, and the UI never offers an invalid value in
 * the first place. Bounds mirror dsh's theme schema (10..22).
 */
function requireFontSize(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < FONT_SIZE_MIN ||
    value > FONT_SIZE_MAX
  ) {
    throw badRequest(
      `contentFontSize must be an integer between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}`,
    );
  }
  return value;
}

/**
 * The title model is either `null` — nobody writes titles — or a provider/model
 * pair. Only the shape is checked here: whether that provider still exists is a
 * question for the call itself, which answers it by leaving the deterministic
 * title in place.
 */
function requireTitleModel(value: unknown): TitleModelChoice | null {
  if (value === null) return null;
  const candidate = value as { provider?: unknown; model?: unknown } | null;
  if (typeof candidate !== "object" || candidate === null) {
    throw badRequest("titleModel must be null or { provider, model }");
  }
  const { provider, model } = candidate;
  if (typeof provider !== "string" || provider.length === 0
    || typeof model !== "string" || model.length === 0) {
    throw badRequest("titleModel must be null or { provider, model }");
  }
  return { provider, model };
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`${key} is required`);
  }
  return value;
}

/**
 * A finite number from the request body.
 *
 * Bounds are not checked here — `TerminalManager` clamps to what a PTY can
 * actually hold, and doing it in two places would mean two answers.
 */
function requireNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`${key} must be a number`);
  }
  return value;
}

/** A whole number from the request body — a queue position, for one. */
function requireInt(body: Record<string, unknown>, key: string): number {
  const value = requireNumber(body, key);
  if (!Number.isInteger(value)) throw badRequest(`${key} must be an integer`);
  return value;
}

/**
 * The model a new session should start on, as the hero's picker sends it.
 *
 * Absent means "whatever pi starts on" — the field is only sent when the user
 * picked something other than the default, and a missing one must not be read
 * as a request for the first available model. A present but malformed value is
 * a caller mistake and is rejected rather than silently ignored.
 */
function optionalModel(body: Record<string, unknown>): { provider: string; id: string } | null {
  const value = body.model;
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw badRequest("model must be an object");
  const { provider, id } = value;
  if (typeof provider !== "string" || provider.length === 0) {
    throw badRequest("model.provider is required");
  }
  if (typeof id !== "string" || id.length === 0) {
    throw badRequest("model.id is required");
  }
  return { provider, id };
}

/**
 * The hero's thinking-level choice, or null when nothing was picked.
 *
 * Same shape and reasoning as `optionalModel`: absent means "let pi decide",
 * which is not the same request as naming a level, and a present but unknown
 * value is the caller's mistake rather than something to ignore.
 */
function optionalThinkingLevel(body: Record<string, unknown>): string | null {
  const value = body.thinkingLevel;
  if (value === undefined || value === null) return null;
  return requireChoice(value, THINKING_LEVELS, "thinkingLevel");
}

/**
 * The preset a session is created with, or the default when nothing was picked.
 *
 * Unlike the model and the thinking level — both of which pi can be asked to
 * change while the process runs — this one decided the spawn arguments, so
 * there is no later moment at which it could be corrected. An unknown id would
 * create a session that can never be what the caller asked for, which is why it
 * is a 400 here rather than a failure reported after the fact.
 */
function optionalPresetId(body: Record<string, unknown>): string {
  const value = body.presetId;
  if (value === undefined || value === null) return DEFAULT_PRESET_ID;
  if (typeof value !== "string") throw badRequest("presetId must be a string");
  if (findPreset(value) === null) throw badRequest(`unknown preset: ${value}`);
  return value;
}

/**
 * The composer figures plus the session's composition.
 *
 * The preset rides along because the composer read is the one request every
 * session switch makes, and the conversation header's label needs it — a
 * separate endpoint would be a second round trip for one string. It is a
 * property of the session, not of the input bar, which is why it is merged in
 * by the route rather than produced by `composer.ts`.
 *
 * `planMode` rides along for exactly the same reason: it is a property of the
 * session (one log entry, `session-plan.ts`), and the header shows it beside
 * the composition. `sessionOnDisk` says whether the session file exists at all,
 * which is what lets a client tell "the mode is off" apart from "there is no
 * file yet to say anything" — pi writes a session lazily, so a switch made in a
 * session that has not spoken exists only in the process.
 */
type SessionComposerState = ComposerState & {
  presetId: string;
  presetLocked: boolean;
  planMode: boolean;
  sessionOnDisk: boolean;
};

/**
 * The formats a provider will actually decode. The same list the composer
 * enforces, repeated here because the two ends are separately reachable: a
 * curl or an extension can post a prompt without going through the input bar.
 */
const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Ceiling per image, in encoded characters: 4/3 of 5MB plus padding. */
const MAX_IMAGE_CHARS = Math.ceil((5 * 1024 * 1024 * 4) / 3);

/** How many images one message may carry. Mirrors the composer's own limit. */
const MAX_IMAGES_PER_MESSAGE = 8;

/**
 * pi's `ImageContent`, spelled out: `@earendil-works/pi-coding-agent` does not
 * re-export the type, and the RPC client takes it structurally anyway.
 */
interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * The images riding along with a message, or undefined when there are none.
 *
 * This is the only place the shape is checked before it is forwarded verbatim to
 * a running pi. A malformed block would otherwise fail somewhere inside a
 * provider request — after a spawn, with an error that names the model rather
 * than the request — and the limits are the ones the composer already holds the
 * user to, so a rejection here is always something the UI could not have sent.
 */
function parseImages(body: Record<string, unknown>): ImageAttachment[] | undefined {
  const value = body.images;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badRequest("images must be an array");
  if (value.length === 0) return undefined;
  if (value.length > MAX_IMAGES_PER_MESSAGE) {
    throw badRequest(`最多 ${String(MAX_IMAGES_PER_MESSAGE)} 张图片`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw badRequest(`images[${String(index)}] must be an object`);
    }
    const { data, mimeType } = entry as { data?: unknown; mimeType?: unknown };
    if (typeof data !== "string" || data.length === 0) {
      throw badRequest(`images[${String(index)}].data is required`);
    }
    if (data.length > MAX_IMAGE_CHARS) {
      throw badRequest(`images[${String(index)}] 超过 5MB`);
    }
    if (typeof mimeType !== "string" || !ACCEPTED_IMAGE_TYPES.has(mimeType)) {
      throw badRequest(`images[${String(index)}].mimeType 不受支持`);
    }
    return { type: "image", data, mimeType };
  });
}

/**
 * A message that is allowed to be empty — as long as a picture came with it.
 *
 * pi writes the same `[{ type: "text", text }, ...images]` content either way,
 * so a screenshot with no caption is a complete message; requiring text would
 * turn a legitimate turn into a 400 the composer cannot explain.
 */
function messageWithImages(body: Record<string, unknown>): {
  message: string;
  images: ImageAttachment[] | undefined;
} {
  const message = optionalString(body, "message") ?? "";
  const images = parseImages(body);
  if (message.length === 0 && images === undefined) {
    throw badRequest("message or images is required");
  }
  return { message, images };
}

/**
 * A field the editor may omit. Absent means "leave the stored value alone",
 * which is what lets a save that did not retype the API key preserve it.
 */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${key} must be a string`);
  return value;
}

/**
 * A count from the query string, or undefined when it is missing or nonsense.
 *
 * A page size is a rendering hint, not a constraint on the data: a client that
 * asks for something unusable gets the default view rather than a 400.
 */
function optionalPositiveInt(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The workspace a settings request is about, or null for the user scope.
 *
 * `null` and the empty string both mean "no workspace": the settings page sends
 * null before one is selected, and an empty query parameter is what a missing
 * value looks like on the wire.
 */
function optionalProjectPath(body: Record<string, unknown>): string | null {
  const value = body.projectPath;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest("projectPath must be a string");
  return value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One `KEY=value` row from the MCP editor; an empty value means "keep stored". */
function parseSecretRows(value: unknown): McpSecretRow[] {
  if (!Array.isArray(value)) return [];
  const rows: McpSecretRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (key.length === 0) continue;
    rows.push({ key, value: typeof entry.value === "string" ? entry.value : "" });
  }
  return rows;
}

function parseMcpDraft(value: unknown): McpServerDraft {
  const draft = asObject(value);
  const transport = draft.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw badRequest("transport must be stdio or http");
  }
  const text = (key: string): string => (typeof draft[key] === "string" ? draft[key] : "");
  return {
    name: text("name"),
    transport,
    command: text("command"),
    args: text("args"),
    cwd: text("cwd"),
    url: text("url"),
    env: parseSecretRows(draft.env),
    headers: parseSecretRows(draft.headers),
  };
}

/**
 * One model entry from a provider write.
 *
 * Every field here is refused rather than coerced when it is malformed: the file
 * this ends up in is read by pi at startup, and pi rejects a whole provider whose
 * model list it cannot validate. A 400 in the form is recoverable; a
 * `models.json` pi refuses to load is not.
 */
function parseModelEntries(value: unknown): ProviderModelEntry[] {
  if (!Array.isArray(value)) throw badRequest("models must be an array");
  return value.map((entry) => {
    const item = asObject(entry);
    const id = optionalString(item, "id") ?? "";
    if (id.length === 0) throw badRequest("模型 ID 不能为空。");
    const name = optionalString(item, "name") ?? "";
    const parsed: ProviderModelEntry = name.length === 0 ? { id } : { id, name };
    for (const field of ["contextWindow", "maxTokens"] as const) {
      const raw = item[field];
      if (raw === undefined) continue;
      // A blank field arrives as absent, so anything that does arrive is meant
      // as a number. `null` is also caught here: it is what `NaN` becomes on the
      // wire, which is how a typo in the capacity box would otherwise travel.
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
        throw badRequest(field === "contextWindow" ? "上下文窗口必须是正数。" : "最大输出 token 数必须是正数。");
      }
      parsed[field] = raw;
    }
    if (item.input !== undefined) {
      if (!Array.isArray(item.input)) throw badRequest("input must be an array");
      const modalities: string[] = [];
      for (const modality of item.input) {
        if (modality !== "text" && modality !== "image") {
          throw badRequest("输入类型只能是 text 或 image。");
        }
        if (!modalities.includes(modality)) modalities.push(modality);
      }
      // An empty list is how the editor spells "not declared", which is a state
      // pi expresses by leaving the field out.
      if (modalities.length > 0) parsed.input = modalities;
    }
    // `reasoning` is deliberately tri-state: a boolean is a claim — pi reads
    // `false` as "this model does not think" — while an absent field says
    // nothing and leaves pi's own catalog in charge. The editor sends `false`
    // when its box is unchecked, which is the statement the user just made.
    if (item.reasoning !== undefined) {
      if (typeof item.reasoning !== "boolean") {
        throw badRequest("reasoning 必须是 true 或 false。");
      }
      parsed.reasoning = item.reasoning;
    }
    if (item.thinkingLevelMap !== undefined) {
      if (!isRecord(item.thinkingLevelMap)) throw badRequest("thinkingLevelMap 必须是一个对象。");
      const map: Record<string, string | null> = {};
      for (const [level, effort] of Object.entries(item.thinkingLevelMap)) {
        // A key pi does not know is a level it would silently ignore, and a
        // map that does nothing is worse than a 400 that does.
        if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
          throw badRequest(`thinkingLevelMap 的键只能是 pi 的档位名：${THINKING_LEVELS.join("、")}。`);
        }
        if (effort !== null && (typeof effort !== "string" || effort.length === 0)) {
          throw badRequest("thinkingLevelMap 的值必须是非空字符串或 null。");
        }
        map[level] = effort;
      }
      if (Object.keys(map).length > 0) parsed.thinkingLevelMap = map;
    }
    return parsed;
  });
}

function parseProviderInput(body: Record<string, unknown>, id: string): ProviderInput {
  const input: ProviderInput = { id };
  const name = optionalString(body, "name");
  if (name !== undefined) input.name = name;
  const baseUrl = optionalString(body, "baseUrl");
  if (baseUrl !== undefined) input.baseUrl = baseUrl;
  const api = optionalString(body, "api");
  if (api !== undefined) input.api = api;
  const apiKey = optionalString(body, "apiKey");
  if (apiKey !== undefined) input.apiKey = apiKey;
  if (body.models !== undefined) input.models = parseModelEntries(body.models);
  return input;
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  // Bad provider configuration is the user's input being wrong, not the server
  // failing. "已有提供方使用了这个 ID" belongs in the form, at 400, not in the
  // error banner as a 500.
  if (err instanceof ModelConfigError) return badRequest(err.message);
  if (err instanceof ExtensionConfigError) return badRequest(err.message);
  if (err instanceof UpdatesConfigError) return badRequest(err.message);
  if (err instanceof McpConfigError) return badRequest(err.message);
  // A git write that git itself refused — nothing staged, no identity, a
  // rejected push — is the user's action not landing, not the server breaking.
  // Its own message ("nothing to commit, working tree clean") is the message.
  if (err instanceof GitError) return badRequest(err.message);
  if (err instanceof ProjectError) {
    switch (err.code) {
      case "ENOENT":
      case "ENOTFOUND":
        return new HttpError(404, err.message);
      case "EEXIST":
        return new HttpError(409, err.message);
      default:
        return badRequest(err.message);
    }
  }
  const message = err instanceof Error ? err.message : "internal error";
  return new HttpError(500, message);
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function declaredBodyTooLarge(req: IncomingMessage, limit: number): boolean {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength !== "string") return false;
  const size = Number(contentLength);
  return Number.isFinite(size) && size > limit;
}

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Reject any request whose Host (or Origin, when present) is not loopback.
 *
 * This server has no authentication and can enumerate the filesystem, so a
 * page on the public internet must not be able to drive it. Under DNS
 * rebinding a malicious origin resolves to 127.0.0.1 but still sends its own
 * Host header, which this rejects.
 */
function assertLocalRequest(req: IncomingMessage): void {
  const host = req.headers.host ?? "";
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  if (!LOCAL_HOSTNAMES.has(hostname.toLowerCase())) {
    throw forbidden(`unexpected Host header: ${host || "(missing)"}`);
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let originHostname: string;
    try {
      originHostname = new URL(origin).hostname.toLowerCase();
    } catch {
      throw forbidden(`unparseable Origin: ${origin}`);
    }
    if (!LOCAL_HOSTNAMES.has(originHostname)) {
      throw forbidden(`unexpected Origin: ${origin}`);
    }
  }
}

/**
 * Builds the HTTP request handler for the API. Dependencies are injected so
 * tests can drive a stub pi process and a private storage root.
 */
export function createRequestHandler(deps: RouteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const {
    registry,
    bus,
    staticHandler = null,
    sseMaxBufferedBytes = SSE_MAX_BUFFERED_BYTES,
    requestBodyMaxBytes = REQUEST_BODY_MAX_BYTES,
  } = deps;
  const sessionRoot = deps.sessionRoot ?? getSessionRoot();
  const uiRequests = deps.uiRequests ?? pendingUiRequests;
  const terminals = deps.terminals ?? new TerminalManager({ bus });
  const openWith = deps.openWith ?? nativeOpenWith;
  const routes: Route[] = [];

  const route = (method: string, path: string, handler: Handler): void => {
    routes.push({ method, segments: path.split("/").filter(Boolean), handler });
  };

  const allowedPath = (raw: string): string => assertAllowedSessionPath(raw, sessionRoot);

  /** External absolute image paths are allowed only when the session itself named them. */
  const externalImagePath = async (raw: string, sessionRaw: string | null, projectPath: string): Promise<string | null> => {
    if (!raw.startsWith("/") || sessionRaw === null) return null;
    const sessionPath = allowedPath(sessionRaw);
    const live = registry.get(sessionPath);
    let cwd = projectPath;
    let messages: unknown;
    if (live && !live.dead) {
      cwd = live.projectPath;
      messages = await callClient(live, () => live.client.getMessages());
    } else {
      try {
        const manager = openSessionForRead(sessionPath);
        cwd = manager.getCwd();
        messages = manager.buildSessionContext().messages;
      } catch {
        throw notFound("无法读取会话");
      }
    }
    // The project route must be the same project that owns the session.
    if (resolve(cwd) !== resolve(projectPath)) throw forbidden("会话不属于此项目");
    const target = resolve(raw);
    const hasPathToken = (text: string): boolean => {
      let at = text.indexOf(target);
      while (at >= 0) {
        const before = at === 0 ? "" : text[at - 1]!;
        const afterAt = at + target.length;
        const after = afterAt === text.length ? "" : text[afterAt]!;
        const boundary = (char: string): boolean => char === "" || /[\s\"'`()\[\]<>,;:!?]/.test(char);
        if (boundary(before) && boundary(after)) return true;
        at = text.indexOf(target, at + 1);
      }
      return false;
    };
    let referenced = false;
    const visit = (value: unknown): void => {
      if (referenced) return;
      if (typeof value === "string") {
        if (hasPathToken(value)) referenced = true;
        return;
      }
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (typeof value === "object" && value !== null) {
        for (const item of Object.values(value as Record<string, unknown>)) visit(item);
      }
    };
    visit(messages);
    if (!referenced) throw forbidden("外部文件未被会话引用");
    const extension = extname(target).slice(1).toLowerCase();
    if (!new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]).has(extension)) {
      throw forbidden("只允许预览图片");
    }
    // Refuse symlinks escaping the named file's canonical location.
    const canonicalTarget = await realpath(target);
    if (extname(canonicalTarget).toLowerCase() !== extname(target).toLowerCase()) {
      throw forbidden("不允许通过符号链接读取非图片文件");
    }
    return target;
  };

  /**
   * Whether this id names a session file this process may read.
   *
   * Used where an unreadable path has a fallback rather than an error: the
   * question there is "is there something on disk?", not "is this allowed?".
   */
  const isSessionFile = (raw: string): boolean => {
    try {
      allowedPath(raw);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Attach to a session, spawning a pi process when none is live. Draft
   * sessions are already registered by path, so they resolve without disk I/O.
   */
  const openSession = async (sessionPath: string): Promise<SessionHandle> => {
    const live = registry.get(sessionPath);
    if (live && !live.dead) {
      registry.touch(sessionPath);
      return live;
    }
    // One parse answers both questions: the cwd pi needs, and the composition
    // the file records. Opening a minimal session under the default arguments
    // would start a process whose prompt and tool set contradict the session's
    // own leading system message (see `session-preset.ts`).
    let manager: ReturnType<typeof openSessionForRead>;
    try {
      manager = openSessionForRead(sessionPath);
    } catch (err) {
      throw notFound(`cannot open session: ${(err as Error).message}`);
    }
    return registry.open(manager.getCwd(), sessionPath, presetIdOfSession(manager));
  };

  /** Any RPC failure marks the handle dead so the next request respawns it. */
  const callClient = async <T>(handle: SessionHandle, fn: () => Promise<T>): Promise<T> => {
    try {
      const result = await fn();
      registry.touch(handle.sessionPath);
      return result;
    } catch (err) {
      // An HttpError raised by the handler itself is a caller mistake — an
      // unknown command name, say — not a broken process. Killing a healthy pi
      // process over a typo would cost a 1.6s respawn on the next request.
      if (err instanceof HttpError) throw err;
      registry.markDead(handle.sessionPath);
      throw new HttpError(502, `pi rpc failed: ${(err as Error).message}`);
    }
  };

  /**
   * Composer state from a resident process.
   *
   * The runtime answers with the model's window but not its display name —
   * names live in `models.json` — so the on-disk catalog rides along and fills
   * that in. Reading it is a few hundred bytes next to the RPCs already in
   * flight, and the alternative is showing raw model ids where the settings page
   * shows names.
   */
  /**
   * Plan mode as the running process holds it, falling back to the file.
   *
   * The file lags the process — pi writes a session lazily, on the first real
   * message — so a switch made in a session that has not spoken yet exists only
   * in memory, and `get_entries` is the only thing that can see it. The file is
   * the fallback for a process that went away between the command and this read.
   */
  const planModeNow = async (handle: SessionHandle, sessionPath: string): Promise<boolean> => {
    try {
      const { entries, leafId } = await callClient(handle, () => handle.client.getEntries());
      return planActiveOfEntries(entries, leafId);
    } catch {
      return readSessionPlanActive(sessionPath);
    }
  };

  const liveComposer = async (handle: SessionHandle): Promise<SessionComposerState> => {
    const catalog = await readModelCatalog();
    const state = await callClient(handle, () => readComposerFromClient(handle.client, catalog));
    // The composition comes from the process — it decided the arguments — while
    // the lock comes from the file. A live session that has not sent a request
    // yet is still recomposable, and the parse here is the one the switch
    // already paid for (`session-open.ts`).
    return {
      ...state,
      presetId: handle.presetId,
      presetLocked: readSessionComposition(handle.sessionPath).locked,
      // The process is the authority while one is here; see `planModeNow`.
      planMode: await planModeNow(handle, handle.sessionPath),
      sessionOnDisk: existsSync(handle.sessionPath),
    };
  };

  /**
   * Composer state from the session file, with a missing session reported as
   * 404 and a broken `models.json` left to bubble up as the 400 it is.
   */
  const diskComposer = async (sessionPath: string): Promise<SessionComposerState> => {
    // Read first, so a config error is not misreported as a missing session.
    const catalog = await readModelCatalog();
    try {
      const state = await readComposerFromDisk(sessionPath, catalog);
      const { presetId, locked } = readSessionComposition(sessionPath);
      return {
        ...state,
        presetId,
        presetLocked: locked,
        planMode: readSessionPlanActive(sessionPath),
        sessionOnDisk: existsSync(sessionPath),
      };
    } catch (err) {
      throw notFound(`无法读取会话：${(err as Error).message}`);
    }
  };

  /**
   * Apply the hero's model choice to a session that was just created.
   *
   * A failure is reported in the response rather than thrown: the session
   * already exists, and discarding it because one id had gone stale would cost
   * the user the draft they were about to type into. The picker only offers ids
   * pi listed a moment ago, so the failing path is "the model was removed
   * between the two reads", not "the client sent something wrong".
   */
  const applyModel = async (
    handle: SessionHandle,
    model: { provider: string; id: string } | null,
  ): Promise<{ modelError?: string }> => {
    if (model === null) return {};
    try {
      await handle.client.setModel(model.provider, model.id);
      registry.touch(handle.sessionPath);
      return {};
    } catch (err) {
      return {
        modelError: `无法切换到 ${model.provider}/${model.id}：${(err as Error).message}`,
      };
    }
  };

  /**
   * Apply the hero's thinking-level choice to a session that was just created.
   *
   * Same contract as `applyModel`, and it runs *after* it: pi clamps a level to
   * what the just-switched model supports, so the order is the difference
   * between the user's choice landing on that model and landing on the previous
   * one.
   */
  const applyThinking = async (
    handle: SessionHandle,
    level: string | null,
  ): Promise<{ thinkingError?: string }> => {
    if (level === null) return {};
    try {
      await handle.client.setThinkingLevel(level as Parameters<RpcClient["setThinkingLevel"]>[0]);
      registry.touch(handle.sessionPath);
      return {};
    } catch (err) {
      return { thinkingError: `无法设置思考强度为 ${level}：${(err as Error).message}` };
    }
  };

  // --- health ---------------------------------------------------------------

  route("GET", "/api/health", ({ res }) => {
    json(res, 200, { ok: true, activeSessions: registry.list().length });
  });

  // --- host environment -----------------------------------------------------

  // The UI shortens absolute paths to `~/...`. Only the host knows where home
  // is, and guessing from a path prefix would be wrong on every other machine.
  route("GET", "/api/env", ({ res }) => {
    json(res, 200, { home: homedir() });
  });

  // --- settings -------------------------------------------------------------

  // Shell preferences owned by this UI end to end. They live in our own store
  // file rather than pi's config, because none of them has a pi-side
  // counterpart: changing how this page looks or how Enter behaves must never
  // change what the terminal does.
  route("GET", "/api/settings", async ({ res }) => {
    const store = await readStore();
    json(res, 200, store.settings);
  });

  route("PUT", "/api/settings", async ({ res, body }) => {
    const patch = asObject(body);
    const settings = await mutateStore((draft) => {
      const next = draft.settings;
      if (patch.appearance !== undefined) {
        next.appearance = requireChoice<AppearancePreference>(
          patch.appearance,
          ["light", "dark", "system"],
          "appearance",
        );
      }
      if (patch.language !== undefined) {
        next.language = requireChoice<LanguagePreference>(
          patch.language,
          ["system", "zh-CN", "en"],
          "language",
        );
      }
      if (patch.contentFontSize !== undefined) {
        next.contentFontSize = requireFontSize(patch.contentFontSize);
      }
      if (patch.transcriptDisplay !== undefined) {
        next.transcriptDisplay = requireChoice<TranscriptDisplay>(
          patch.transcriptDisplay,
          ["compact", "standard", "detailed", "verbose"],
          "transcriptDisplay",
        );
      }
      if (patch.busySendBehavior !== undefined) {
        next.busySendBehavior = requireChoice<BusySendBehavior>(
          patch.busySendBehavior,
          ["queue", "steer"],
          "busySendBehavior",
        );
      }
      if (patch.browserNotifications !== undefined) {
        if (typeof patch.browserNotifications !== "boolean") {
          throw badRequest("browserNotifications must be a boolean");
        }
        next.browserNotifications = patch.browserNotifications;
      }
      if (patch.titleModel !== undefined) {
        next.titleModel = requireTitleModel(patch.titleModel);
      }
      return next;
    });
    json(res, 200, settings);
  });

  // Agent behaviour that belongs to pi, not to us: read back from a live
  // process rather than mirrored, so the terminal and this page cannot
  // disagree. Split from `/api/settings` because it can wait on a cold start.
  const agentHandle = async (projectPath: string): Promise<SessionHandle | null> => {
    return registry.findLive(projectPath) ?? (await registry.ensurePrewarmed(projectPath));
  };

  route("GET", "/api/settings/agent", async ({ res, query }) => {
    const projectPath = query.get("projectPath") ?? "";
    const handle = projectPath.length > 0 ? await agentHandle(projectPath) : null;
    if (handle === null) {
      // Nothing to read from. The row renders as unavailable instead of
      // showing a value we invented, which the user would then "change" to
      // the value it already appeared to have.
      json(res, 200, { available: false });
      return;
    }
    const state = await callClient(handle, () => handle.client.getState());
    json(res, 200, { available: true, autoCompaction: state.autoCompactionEnabled });
  });

  route("PUT", "/api/settings/agent", async ({ res, body }) => {
    const patch = asObject(body);
    const projectPath = requireString(patch, "projectPath");
    const handle = await agentHandle(projectPath);
    if (handle === null) throw new HttpError(503, "cannot start a pi process for this project");

    if (patch.autoCompaction !== undefined) {
      if (typeof patch.autoCompaction !== "boolean") {
        throw badRequest("autoCompaction must be a boolean");
      }
      await callClient(handle, () => handle.client.setAutoCompaction(patch.autoCompaction as boolean));
    }

    // pi persists this globally and only a freshly started process reads the
    // file back, so any other resident process would keep serving the value it
    // booted with. Retiring them costs one cold start on the next switch;
    // keeping them would show a stale setting in a session the user still has
    // open. `handle` itself already holds the new value.
    await registry.closeAllExcept(handle, "settings-changed");

    const state = await callClient(handle, () => handle.client.getState());
    json(res, 200, { available: true, autoCompaction: state.autoCompactionEnabled });
  });

  // --- model providers ------------------------------------------------------

  // pi reads `models.json` and `auth.json` once at startup, so this page edits
  // the files — there is no RPC for provider definitions. One response carries
  // everything the page needs: the providers plus the catalog and protocol
  // values the editors offer. Both lists are pi's, not ours, so they ship with
  // the response instead of being duplicated in the frontend.
  const modelsView = async (): Promise<Record<string, unknown>> => ({
    providers: await readProviders(),
    modelsPath: modelsPath(),
    authPath: authPath(),
    knownProviders: [...KNOWN_PROVIDERS],
    apiProtocols: [...API_PROTOCOLS],
  });

  // Every write retires the resident pi processes. They read the provider list
  // when they started, so a process that predates the edit would keep serving
  // the old set — the provider just added would appear nowhere, and a deleted
  // one would still answer. Sessions live on disk, so the cost is one cold
  // start on the next switch rather than lost work.
  const finishModelWrite = async (res: ServerResponse, status: number): Promise<void> => {
    await registry.closeAllExcept(null, "model-config-changed");
    json(res, status, await modelsView());
  };

  route("GET", "/api/models/providers", async ({ res }) => {
    json(res, 200, await modelsView());
  });

  route("POST", "/api/models/providers", async ({ res, body }) => {
    const payload = asObject(body);
    await saveProvider(parseProviderInput(payload, requireString(payload, "id")), "create");
    await finishModelWrite(res, 201);
  });

  route("PUT", "/api/models/providers/:id", async ({ res, body, params }) => {
    await saveProvider(parseProviderInput(asObject(body), params.id ?? ""), "update");
    await finishModelWrite(res, 200);
  });

  route("DELETE", "/api/models/providers/:id", async ({ res, params }) => {
    await deleteProvider(params.id ?? "");
    await finishModelWrite(res, 200);
  });

  // Ask a provider which models it serves. Deliberately takes the *unsaved*
  // form values: the useful moment for this is while creating a provider, when
  // there is no id yet and no stored definition to read an endpoint from.
  // Nothing is written, so this does not retire the resident processes.
  route("POST", "/api/models/fetch-models", async ({ res, body }) => {
    const payload = asObject(body);
    const input: FetchModelsInput = { baseUrl: requireString(payload, "baseUrl") };
    const id = optionalString(payload, "id");
    if (id !== undefined && id.length > 0) input.id = id;
    const api = optionalString(payload, "api");
    if (api !== undefined) input.api = api;
    const apiKey = optionalString(payload, "apiKey");
    if (apiKey !== undefined) input.apiKey = apiKey;
    json(res, 200, { models: await fetchProviderModels(input) });
  });

  // --- prompts --------------------------------------------------------------

  route("GET", "/api/prompts", async ({ res, query }) => {
    const projectPath = query.get("projectPath");
    json(res, 200, await readPrompts(projectPath && projectPath.length > 0 ? projectPath : null));
  });

  route("PUT", "/api/prompts", async ({ res, body }) => {
    const payload = asObject(body);
    const scope = requireString(payload, "scope");
    if (scope !== "global" && scope !== "workspace") throw badRequest("scope must be global or workspace");
    if (typeof payload.content !== "string") throw badRequest("content must be a string");
    const projectPath = optionalProjectPath(payload);
    if (scope === "workspace" && projectPath === null) throw badRequest("projectPath is required for workspace prompts");
    const view = await savePrompt(scope, payload.content, projectPath);
    // Context files are loaded when pi starts. Retire resident sessions so the
    // next session observes the edited instructions instead of stale state.
    await registry.closeAllExcept(null, "prompts-changed");
    json(res, 200, view);
  });

  // --- extensions -----------------------------------------------------------

  /**
   * Every extension pi would consider loading, resolved by pi's own package
   * manager against the settings and package files on disk.
   *
   * `projectPath` is optional: without it the answer covers the user scope only,
   * which is what the settings page asks for before a workspace is selected.
   * Resolution failures come back as `error` on a 200 rather than as an HTTP
   * error, because an empty list and a broken read are different states and the
   * page has to tell them apart.
   */
  route("GET", "/api/extensions", async ({ res, query }) => {
    const projectPath = query.get("projectPath");
    json(res, 200, await readExtensions(projectPath && projectPath.length > 0 ? projectPath : null));
  });

  /**
   * Turn one extension on or off, then answer with the full re-resolved list.
   *
   * The write lands in pi's settings file, and only a freshly started process
   * reads that file back — the same reason provider edits retire the resident
   * processes. Extensions are loaded at startup, so a process that predates
   * this change would keep running the old set; sessions live on disk, so the
   * cost is one cold start on the next switch.
   */
  route("PUT", "/api/extensions", async ({ res, body }) => {
    const payload = asObject(body);
    const path = requireString(payload, "path");
    if (typeof payload.enabled !== "boolean") throw badRequest("enabled must be a boolean");

    const view = await setExtensionEnabled({
      projectPath: optionalProjectPath(payload),
      path,
      enabled: payload.enabled,
    });
    await registry.closeAllExcept(null, "extensions-changed");
    json(res, 200, view);
  });

  // --- skills ---------------------------------------------------------------

  route("GET", "/api/skills", async ({ res, query }) => {
    const projectPath = query.get("projectPath");
    json(res, 200, await readSkills(projectPath && projectPath.length > 0 ? projectPath : null));
  });

  route("GET", "/api/skills/detail", async ({ res, query }) => {
    const path = query.get("path");
    if (!path) throw badRequest("path is required");
    const projectPath = query.get("projectPath");
    json(res, 200, await readSkill(path, projectPath && projectPath.length > 0 ? projectPath : null));
  });

  route("PUT", "/api/skills", async ({ res, body }) => {
    const payload = asObject(body);
    const path = requireString(payload, "path");
    if (typeof payload.enabled !== "boolean") throw badRequest("enabled must be a boolean");
    const view = await setSkillEnabled({
      path,
      enabled: payload.enabled,
      projectPath: optionalProjectPath(payload),
    });
    await registry.closeAllExcept(null, "skills-changed");
    json(res, 200, view);
  });

  // --- update notices -------------------------------------------------------

  /**
   * Whether a newer pi is published, and which installed packages are behind.
   *
   * `refresh=true` bypasses the server's short cache; the default read reuses
   * an answer from the last few minutes, so opening the settings page does not
   * spawn an `npm view` per package on every visit. A check that could not be
   * completed is reported inside the payload (`error`) rather than as an HTTP
   * error: "could not check" and "up to date" are different facts, and the page
   * renders them differently.
   */
  route("GET", "/api/updates", async ({ res, query }) => {
    const projectPath = query.get("projectPath");
    json(
      res,
      200,
      await readUpdates(projectPath && projectPath.length > 0 ? projectPath : null, {
        force: query.get("refresh") === "true",
      }),
    );
  });

  /**
   * Update one installed pi package to its upstream version.
   *
   * Slow by nature — npm has to resolve and download — and the resident pi
   * processes have to be retired afterwards so the next message loads the new
   * copy instead of the one already in memory.
   */
  route("POST", "/api/updates/extensions", async ({ res, body }) => {
    const payload = asObject(body);
    const view = await updateExtension(
      optionalProjectPath(payload),
      requireString(payload, "source"),
    );
    await registry.closeAllExcept(null, "extensions-updated");
    json(res, 200, view);
  });

  /**
   * Update this deployment itself to the version npm calls latest.
   *
   * Distinct from the extension route in the one way that matters: the code
   * this replaces is already running, so a successful response means new files
   * on disk, not a new program in memory. The page says so; nothing here tries
   * to restart the process, because doing that from inside the request that is
   * holding it open would kill the answer before it was sent.
   */
  route("POST", "/api/updates/app", async ({ res, body }) => {
    json(res, 200, await updateApp(optionalProjectPath(asObject(body))));
  });

  // --- MCP servers ----------------------------------------------------------

  /**
   * The MCP inventory: every server pi would load for a workspace, read from
   * pi's own two `mcp.json` files.
   */
  route("GET", "/api/mcp", async ({ res, query }) => {
    const projectPath = query.get("projectPath");
    json(res, 200, await readMcp(projectPath && projectPath.length > 0 ? projectPath : null));
  });

  /** Create or update one server. Secrets are write-only, like provider keys. */
  route("PUT", "/api/mcp/servers", async ({ res, body }) => {
    const payload = asObject(body);
    const originalName = payload.originalName;
    const view = await saveMcpServer({
      projectPath: optionalProjectPath(payload),
      scope: payload.scope === "project" ? "project" : "global",
      originalName:
        typeof originalName === "string" && originalName.length > 0 ? originalName : null,
      draft: parseMcpDraft(payload.draft),
    });
    await registry.closeAllExcept(null, "mcp-config-changed");
    json(res, 200, view);
  });

  route("DELETE", "/api/mcp/servers", async ({ res, body }) => {
    const payload = asObject(body);
    const view = await deleteMcpServer({
      projectPath: optionalProjectPath(payload),
      name: requireString(payload, "name"),
    });
    await registry.closeAllExcept(null, "mcp-config-changed");
    json(res, 200, view);
  });

  /**
   * Enable or disable one server for a workspace.
   *
   * This writes a project entry in the workspace's `.pi/mcp.json`, which is
   * what pi's own `/mcp` does — there is no user-level "off" for a server.
   */
  route("PUT", "/api/mcp/state", async ({ res, body }) => {
    const payload = asObject(body);
    if (typeof payload.enabled !== "boolean") throw badRequest("enabled must be a boolean");
    const view = await setMcpServerEnabled({
      projectPath: optionalProjectPath(payload),
      name: requireString(payload, "name"),
      enabled: payload.enabled,
    });
    await registry.closeAllExcept(null, "mcp-config-changed");
    json(res, 200, view);
  });

  /**
   * Connect to one server and report the handshake.
   *
   * Runs only when asked: a stdio entry is an arbitrary command, and a cold
   * `npx` download inside it can take a while.
   */
  route("POST", "/api/mcp/check", async ({ res, body }) => {
    const payload = asObject(body);
    const result = await probeMcpServer(
      optionalProjectPath(payload),
      requireString(payload, "name"),
    );
    json(res, 200, result);
  });

  /**
   * Retire every resident pi process so the next message re-reads the MCP
   * config. This is dsh's 重启, narrowed to what this server can actually do:
   * sessions live on disk, so the cost is one cold start per session.
   */
  route("POST", "/api/mcp/restart", async ({ res }) => {
    const closed = registry.list().length;
    await registry.closeAllExcept(null, "mcp-restart");
    json(res, 200, { ok: true, closed });
  });

  // --- filesystem (directory picker) ---------------------------------------

  route("GET", "/api/fs/locations", async ({ res }) => {
    json(res, 200, await startLocations());
  });

  route("GET", "/api/fs/list", async ({ res, query }) => {
    json(res, 200, await listDirectories(query.get("path") ?? undefined));
  });

  // --- projects -------------------------------------------------------------

  route("GET", "/api/projects", async ({ res }) => {
    json(res, 200, await listProjects());
  });

  route("POST", "/api/projects", async ({ res, body }) => {
    const payload = asObject(body);
    const title = typeof payload.title === "string" ? payload.title : undefined;
    const project = await addProject(requireString(payload, "path"), title);
    bus.publish({ type: "projects_changed" });
    json(res, 201, project);
  });

  route("PUT", "/api/projects/order", async ({ res, body }) => {
    const { ids } = asObject(body);
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw badRequest("ids must be an array of project ids");
    }
    const projects = await reorderProjects(ids as string[]);
    bus.publish({ type: "projects_changed" });
    json(res, 200, projects);
  });

  route("PATCH", "/api/projects/:id", async ({ res, params, body }) => {
    const { title } = asObject(body);
    if (typeof title !== "string") throw badRequest("title is required");
    const project = await renameProject(params.id!, title);
    bus.publish({ type: "projects_changed" });
    json(res, 200, project);
  });

  route("DELETE", "/api/projects/:id", async ({ res, params }) => {
    await removeProject(params.id!);
    bus.publish({ type: "projects_changed" });
    json(res, 200, { ok: true });
  });

  route("GET", "/api/projects/:id/sessions", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    // One page plus the total: the sidebar draws a few rows and labels "show
    // more" with the count, so it never has to hold every session of a
    // workspace (see `listSessions`).
    const page = await listSessions(project.path, {
      sessionDir: sessionDirFor(project.path, sessionRoot),
      includeHidden: query.get("includeHidden") === "true",
      limit: optionalPositiveInt(query.get("limit")),
      focus: query.get("focus") ?? undefined,
    });
    json(res, 200, page);
  });

  /**
   * Slash commands available in one composition of a project: built-in
   * commands, extension commands, prompt templates, and skill commands.
   *
   * Built-in ones come from this server, not from pi — see `commands.ts`. They
   * are listed first and survive a failure to reach pi, since they need no
   * running process to be worth offering.
   *
   * `presetId` is what makes the rest of the list honest. A minimal session
   * registers no templates and no skills, so its menu is the built-ins plus
   * `/web`; answering from a standard process would list commands that session
   * cannot run. Naming none asks for the default composition, which is what a
   * caller that has no session in hand should get.
   */
  route("GET", "/api/projects/:id/commands", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    const builtin: SlashCommand[] = BUILTIN_COMMANDS.map((command) => ({
      name: command.name,
      description: command.argumentHint
        ? `${command.description}　${command.argumentHint}`
        : command.description,
      source: "builtin",
    }));

    const presetId = query.get("presetId") ?? DEFAULT_PRESET_ID;
    if (findPreset(presetId) === null) throw badRequest(`unknown preset: ${presetId}`);

    try {
      json(res, 200, {
        commands: [...builtin, ...(await registry.listCommands(project.path, presetId))],
        presetId,
      });
    } catch (err) {
      // A failure here only costs the user their completions, so report it
      // inline instead of as an error banner.
      json(res, 200, { commands: builtin, presetId, error: (err as Error).message });
    }
  });

  /**
   * One directory level of a project's files, for the right sidebar's tree.
   *
   * Paths are relative to the project root and validated against it; the
   * sidebar addresses files this way rather than by absolute path so the route
   * cannot be turned into a general-purpose file reader.
   */
  route("GET", "/api/projects/:id/files", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    json(res, 200, await listWorkspaceDirectory(project.path, query.get("path") ?? ""));
  });

  /**
   * Paths under a project matching an in-progress `@` query, for the composer's
   * file completion.
   *
   * A sibling of `/files` rather than a mode on it: the two answer different
   * questions — one directory level for the sidebar's tree, one flat search over
   * the whole project for a menu that has to fill from a single keystroke. The
   * index it searches is git's own file list where there is a repository, which
   * is also what keeps ignored files out of the menu.
   */
  route("GET", "/api/projects/:id/files/search", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    const requested = Number(query.get("limit") ?? String(DEFAULT_LIMIT));
    const limit = Number.isFinite(requested) ? requested : DEFAULT_LIMIT;
    json(res, 200, await searchWorkspaceFiles(project.path, query.get("q") ?? "", limit));
  });

  /**
   * One file for the right sidebar's preview tab: text, an image as base64, or
   * a PDF by reference.
   *
   * A file the UI cannot render comes back as `kind: "unsupported"` with a
   * reason rather than as an HTTP error — "this is a .xlsx" is an answer, not a
   * failure, and the tab renders it differently from a broken read. A PDF is the
   * third case: it is renderable, just not here, so this answers with its size
   * and `/raw` hands over the bytes.
   */
  route("GET", "/api/projects/:id/file", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    const path = query.get("path") ?? "";
    if (path.length === 0) throw badRequest("path is required");
    const external = await externalImagePath(path, query.get("session"), project.path);
    if (external !== null) {
      json(res, 200, await readWorkspaceFile(dirname(external), basename(external)));
      return;
    }
    json(res, 200, await readWorkspaceFile(project.path, path));
  });

  /**
   * One page of a text file, for files too large to hand over whole.
   *
   * The first page is what decides whether the reader pages at all: it carries
   * `eof`, so a file that fits in one page costs exactly one request more than
   * reading it whole would have. `offset` is a byte offset from the previous
   * page, not a line number — a line number would mean rescanning the file from
   * the start for every page.
   *
   * `fromLine` is the exception, for a reader that wants one line rather than
   * the head of the file: it scans once, here, and answers with the page that
   * contains it (a little above it, so there is something to scroll back into).
   * It is only read on the first page; the pages after it walk by offset again.
   */
  route("GET", "/api/projects/:id/text", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    const path = query.get("path") ?? "";
    if (path.length === 0) throw badRequest("path is required");
    const offset = Number(query.get("offset") ?? "0");
    const line = query.get("fromLine");
    const fromLine = line === null ? undefined : Number(line);
    json(res, 200, await readWorkspaceTextPage(project.path, path, offset, fromLine));
  });

  /**
   * A file for the browser's own viewer rather than for this app's renderers.
   *
   * The PDF preview is the whole reason this route exists: the panel has no PDF
   * renderer, and the browser has one that keys off the response's content type.
   * Only `readWorkspaceRaw`'s list of formats is served — this is not a general
   * byte endpoint, and everything else still goes through `/file` as JSON.
   */
  route("GET", "/api/projects/:id/raw", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    const path = query.get("path") ?? "";
    if (path.length === 0) throw badRequest("path is required");
    const external = await externalImagePath(path, query.get("session"), project.path);
    const file = external === null
      ? await readWorkspaceRaw(project.path, path)
      : await readWorkspaceRaw(dirname(external), basename(external));
    res.writeHead(200, {
      "content-type": file.mimeType,
      "content-length": file.size,
      // `inline`, because this response is an iframe's source: a browser that
      // cannot display it should say so in place rather than download it.
      // The RFC 5987 form keeps a non-ASCII name intact and escapes CR/LF.
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      // A preview is reloaded on demand, so a cached copy would only ever be the
      // stale one.
      "cache-control": "no-store",
      // The type above is a promise about the bytes, and the promise is what
      // decides who renders them: a PDF is handed to the browser's own trusted
      // viewer without a sandbox, so a body that was not really a PDF must not
      // be allowed to talk the browser into rendering it as anything else.
      "x-content-type-options": "nosniff",
    });
    await pipeline(createReadStream(file.absolutePath), res);
  });

  /**
   * The applications this machine can open one workspace file with.
   *
   * `desktop: false` is the headless answer — an ssh session, a container — and
   * the one case where the preview hides its controls: a button that would spawn
   * an opener into nothing is worse than no button, which is the line dsh draws
   * too. An empty `applications` list is *not* that case: a platform with no
   * association query still opens and still reveals, so the list is empty and
   * the menu is the rest of what the buttons do.
   */
  route("GET", "/api/projects/:id/file/applications", async ({ res, params, query }) => {
    const project = await getProject(params.id!);
    const path = query.get("path") ?? "";
    if (path.length === 0) throw badRequest("path is required");
    const file = await resolveWorkspaceFile(project.path, path);
    if (!openWith.canOpen()) {
      json(res, 200, { desktop: false, applications: [] });
      return;
    }
    json(res, 200, {
      desktop: true,
      applications: await openWith.applications(file.absolutePath),
    });
  });

  /**
   * Open one workspace file, or show where it is.
   *
   * A launch the desktop refused answers 200 with `ok: false` rather than an
   * HTTP error: the gesture arrived and the desktop said no, which is a sentence
   * for the reader where a failed request would be a broken panel. The path goes
   * through the same resolver the preview reads through, so the file the
   * operating system is handed is the file the API already agreed to serve.
   */
  route("POST", "/api/projects/:id/file/open", async ({ res, params, body }) => {
    const project = await getProject(params.id!);
    const payload = asObject(body);
    const path = payload.path;
    if (typeof path !== "string" || path.length === 0) throw badRequest("path is required");
    const action = payload.action;
    if (action !== "open" && action !== "reveal") {
      throw badRequest("action must be open or reveal");
    }
    const application = payload.application;
    if (application !== undefined && typeof application !== "string") {
      throw badRequest("application must be a string");
    }
    if (action === "reveal" && application !== undefined) {
      throw badRequest("reveal does not take an application");
    }
    if (!openWith.canOpen()) {
      json(res, 200, { ok: false, error: "这台主机没有可以打开的桌面" });
      return;
    }

    const file = await resolveWorkspaceFile(project.path, path);
    try {
      if (action === "reveal") await openWith.reveal(file.absolutePath);
      else await openWith.open(file.absolutePath, application ?? null);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * The changes panel's state: branch, staged/unstaged files with their patches,
   * upstream drift and recent history.
   *
   * "Not a git repository" is a normal answer (`repository: false` on a 200):
   * most directories this app can open are not repositories, and a 4xx would
   * make the panel render a failure where it should simply say so.
   */
  route("GET", "/api/projects/:id/git", async ({ res, params }) => {
    const project = await getProject(params.id!);
    json(res, 200, await readGitStatus(project.path));
  });

  /**
   * Stage or unstage paths — one file, or everything (`all: true`).
   *
   * Every write below answers with the re-read state rather than the bare
   * acknowledgement, so the panel never shows a list computed from what it
   * *expected* git to do.
   */
  route("POST", "/api/projects/:id/git/stage", async ({ res, params, body }) => {
    const project = await getProject(params.id!);
    const payload = asObject(body);
    if (typeof payload.staged !== "boolean") throw badRequest("staged must be a boolean");
    const view =
      payload.all === true
        ? await gitStageAll(project.path, payload.staged)
        : await gitStage(project.path, payload.paths, payload.staged);
    json(res, 200, view);
  });

  /** Commit what is staged. `-a` is deliberately not offered — see `git.ts`. */
  route("POST", "/api/projects/:id/git/commit", async ({ res, params, body }) => {
    const project = await getProject(params.id!);
    const payload = asObject(body);
    const result = await gitCommit(project.path, payload.message);
    bus.publish({ type: "projects_changed" });
    json(res, 200, result);
  });

  /**
   * Push the current branch.
   *
   * Slow by nature (network), and the only git write here that leaves the
   * machine. Force pushing is never offered.
   */
  route("POST", "/api/projects/:id/git/push", async ({ res, params }) => {
    const project = await getProject(params.id!);
    json(res, 200, await gitPush(project.path));
  });

  /** Throw away the work-tree changes of the given paths (the panel confirms first). */
  route("POST", "/api/projects/:id/git/discard", async ({ res, params, body }) => {
    const project = await getProject(params.id!);
    const payload = asObject(body);
    json(res, 200, await gitDiscard(project.path, payload.paths));
  });

  /** Switch to an existing local branch, then answer with the new state. */
  route("POST", "/api/projects/:id/git/branch", async ({ res, params, body }) => {
    const project = await getProject(params.id!);
    const payload = asObject(body);
    json(res, 200, await gitCheckout(project.path, payload.branch));
  });

  /**
   * The model a not-yet-created session in this project would start on, plus
   * every model it could switch to — what the new-session page's picker shows.
   *
   * Resolved from pi's own config files rather than from a prewarm process: the
   * list is ready in ~15ms with no spawn and no network (see
   * `readComposerFromDefaults`), so offering the choice before a session exists
   * costs nothing like opening one does.
   */
  route("GET", "/api/projects/:id/composer", async ({ res, params }) => {
    const project = await getProject(params.id!);
    json(res, 200, await readComposerFromDefaults(project.path));
  });

  // --- agent presets ---------------------------------------------------------

  /**
   * The compositions a new session can be created with.
   *
   * Only identity and the fixed facts travel: the label and the sentence
   * describing it are the client's, so one list renders in either language
   * without the server holding copy.
   */
  route("GET", "/api/presets", ({ res }) => {
    json(res, 200, {
      presets: listPresets().map((preset) => ({
        id: preset.id,
        systemPrompt: preset.systemPrompt,
        tools: preset.tools,
      })),
    });
  });

  // --- sessions -------------------------------------------------------------

  route("POST", "/api/sessions", async ({ res, body }) => {
    const payload = asObject(body);
    const { projectId } = payload;
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw badRequest("projectId is required");
    }
    const project = await getProject(projectId);
    const model = optionalModel(payload);
    const thinkingLevel = optionalThinkingLevel(payload);
    const presetId = optionalPresetId(payload);

    // A prewarmed process has already paid pi's cold start, so it can be
    // handed over without waiting. Claiming it also frees the slot, so warm
    // the next one immediately to keep back-to-back "new session" instant.
    //
    // The claim is per composition: a prewarm is a process that already booted
    // with one preset's arguments, and pi cannot recompose it. A minimal
    // creation therefore misses the prewarm and pays its own cold start, while
    // the warm standard process stays available for the next standard session.
    const claimed = registry.claimPrewarmed(project.path, presetId);
    if (claimed) {
      void registry.prewarm(project.path, presetId);
      json(res, 201, {
        sessionPath: claimed.sessionPath,
        sessionId: claimed.sessionId,
        projectPath: project.path,
        presetId: claimed.presetId,
        prewarmed: true,
        ...(await applyModel(claimed, model)),
        ...(await applyThinking(claimed, thinkingLevel)),
      });
      return;
    }

    const handle = await registry.open(project.path, undefined, presetId);
    json(res, 201, {
      sessionPath: handle.sessionPath,
      sessionId: handle.sessionId,
      projectPath: project.path,
      presetId: handle.presetId,
      prewarmed: false,
      ...(await applyModel(handle, model)),
      ...(await applyThinking(handle, thinkingLevel)),
    });
  });

  /**
   * Start warming a session for a project. Returns immediately: the caller
   * must not wait for pi's cold start.
   */
  route("POST", "/api/sessions/prewarm", async ({ res, body }) => {
    const { projectId } = asObject(body);
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw badRequest("projectId is required");
    }
    const project = await getProject(projectId);
    void registry.prewarm(project.path);
    json(res, 202, { ok: true, projectPath: project.path });
  });

  /**
   * The transcript, served from the file whenever the file can answer it.
   *
   * Switching to a session is the single most latency-sensitive action in the
   * UI, and it used to spawn pi (1.5–3.2s) just to read a file. Only a process
   * that is *mid-turn* is asked now: memory is authoritative while the agent
   * runs, but pi appends each committed entry to the session file as it lands,
   * so a settled session's file already holds the same transcript — and hauling
   * tens of megabytes of base64 back out of pi costs hundreds of milliseconds
   * where reading the file costs a few.
   */
  route("GET", "/api/sessions/:id/messages", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const live = registry.get(sessionPath);

    // A process with nothing on disk yet — a session pi has not written its
    // first message for, or an unclaimed prewarm — is the other case memory has
    // to answer, because there is no file to read.
    if (live && !live.dead && (live.running || !existsSync(sessionPath))) {
      const messages = await callClient(live, () => live.client.getMessages());
      // pi answers this from the live session, so it already knows which user
      // messages are forkable — no need to re-derive it from the file.
      const forkPoints = await callClient(live, () => live.client.getForkMessages());
      // A live transcript is the expensive one: it holds every picture the
      // process still remembers, so a session that has been working all day
      // answers with tens of megabytes of base64 — and *this* is the switch the
      // reader makes over and over. Its pictures therefore go out as URLs as
      // well, but they cannot be addressed in the file, because memory may hold
      // turns the file has never seen. The handle keeps the bytes instead and the
      // URL names that copy.
      const version = registry.rememberLiveTranscript(
        live.sessionPath,
        collectSessionImages(messages),
      );
      json(res, 200, {
        sessionPath: live.sessionPath,
        sessionId: live.sessionId,
        messages: withToolResultImageUrls(messages, live.sessionPath, version),
        forkPoints,
      });
      return;
    }

    let snapshot;
    try {
      snapshot = readSessionSnapshot(sessionPath);
    } catch (err) {
      throw notFound(`无法读取会话：${(err as Error).message}`);
    }
    // The file's version is read *before* the snapshot, so a file that changed
    // underneath us produces URLs whose version no longer matches — a 404 the UI
    // heals on its next reload, rather than an ordinal pointing at the wrong
    // picture.
    const version = sessionImageVersion(sessionPath);
    const messages =
      version === null
        ? snapshot.messages
        : withToolResultImageUrls(snapshot.messages, sessionPath, version);
    json(res, 200, {
      sessionPath,
      sessionId: snapshot.sessionId,
      messages,
      forkPoints: snapshot.forkPoints,
    });
  });

  /**
   * One image from a session's transcript, by its position in it.
   *
   * The transcript hands its pictures out as these URLs (see
   * `session-images.ts`), so a switch no longer ships every screenshot of a
   * session in one response. Addressed by ordinal plus a version, which makes the
   * bytes immutable under this URL and lets the browser keep them; a request
   * carrying a version the transcript has moved past is refused rather than
   * answered with whatever now sits at that position.
   *
   * The version also says *where* the bytes are: a `live-` one names the copy the
   * session's handle kept, anything else the file, addressed by its mtime.
   */
  route("GET", "/api/sessions/:id/image/:index", async ({ res, params, query }) => {
    const sessionPath = allowedPath(params.id!);
    const index = Number(params.index);
    if (!Number.isSafeInteger(index) || index < 0) throw notFound("图片不存在");
    const version = query.get("v");

    if (version !== null && isLiveImageVersion(version)) {
      const live = registry.readLiveImage(sessionPath, version, index);
      if (live === null) throw notFound("图片不存在");
      sendImage(res, live);
      return;
    }

    if (version !== null && sessionImageVersion(sessionPath) !== version) {
      throw notFound("图片不存在");
    }
    const image = readSessionImage(sessionPath, index);
    if (image === null) throw notFound("图片不存在");
    sendImage(res, image);
  });

  /**
   * Fork the session at a previous user message.
   *
   * This is not a copy — pi moves the session's leaf pointer back to that entry,
   * so the next prompt continues from there and the abandoned turns stay in the
   * file as a sibling branch. The response therefore reports the session's
   * identity *after* the fork; the caller has to reload the transcript, because
   * what the session now contains has changed.
   */
  route("POST", "/api/sessions/:id/fork", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const entryId = requireString(payload, "entryId");
    const handle = await openSession(sessionPath);
    const result = await callClient(handle, () => handle.client.fork(entryId));
    const state = await callClient(handle, () => handle.client.getState());
    json(res, 200, {
      ok: true,
      text: result.text,
      cancelled: result.cancelled,
      sessionPath: handle.sessionPath,
      sessionId: handle.sessionId,
      sessionFile: state.sessionFile ?? null,
    });
  });

  route("GET", "/api/sessions/:id/state", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const handle = await openSession(sessionPath);
    const state = await callClient(handle, () => handle.client.getState());
    json(res, 200, { sessionPath: handle.sessionPath, state });
  });

  /**
   * The figures the composer shows on the right: the current model, the models
   * it could switch to, and the context-window usage.
   *
   * Served from the JSONL file whenever no process is resident, for the same
   * reason the transcript is: opening a session must not cost a pi cold start,
   * and pi records the model in the file itself (`model_change`). `spawn=true`
   * is the deliberate exception, used the moment the user opens the model menu
   * or the context panel — the *list* of switchable models only exists inside a
   * running process, and at that point the cold start is buying something the
   * user asked for rather than blocking a click on the sidebar.
   */
  route("GET", "/api/sessions/:id/composer", async ({ res, params, query }) => {
    const sessionPath = allowedPath(params.id!);
    const live = registry.get(sessionPath);

    if (live && !live.dead) {
      json(res, 200, await liveComposer(live));
      return;
    }

    if (query.get("spawn") === "true") {
      const handle = await openSession(sessionPath);
      json(res, 200, await liveComposer(handle));
      return;
    }

    json(res, 200, await diskComposer(sessionPath));
  });

  /**
   * Switch the model a session talks to.
   *
   * pi persists this by appending a `model_change` entry, so the choice
   * survives a reload and is visible to the terminal as well. An unknown model
   * is the caller's mistake (`pi` rejects it too), so it answers 400 without
   * retiring the process — a healthy pi should not be killed over a bad id.
   */
  route("POST", "/api/sessions/:id/model", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const provider = requireString(payload, "provider");
    const id = requireString(payload, "id");
    const handle = await openSession(sessionPath);

    try {
      await handle.client.setModel(provider, id);
      registry.touch(handle.sessionPath);
    } catch (err) {
      throw badRequest(`无法切换到 ${provider}/${id}：${(err as Error).message}`);
    }

    json(res, 200, await liveComposer(handle));
  });

  /**
   * Switch the session's thinking level.
   *
   * pi persists this by appending a `thinking_level_change` entry, so it
   * survives a reload and the terminal sees the same choice. A level the model
   * does not support is *clamped* rather than rejected — that is pi's own
   * `set_thinking_level` behaviour, and the answer below reports the level that
   * actually took effect instead of the one that was asked for. A value outside
   * pi's seven levels is still the caller's mistake and answers 400.
   */
  route("POST", "/api/sessions/:id/thinking", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const level = requireChoice(payload.level, THINKING_LEVELS, "level");
    const handle = await openSession(sessionPath);

    try {
      await handle.client.setThinkingLevel(level);
      registry.touch(handle.sessionPath);
    } catch (err) {
      throw badRequest(`无法设置思考强度为 ${level}：${(err as Error).message}`);
    }

    json(res, 200, await liveComposer(handle));
  });

  /**
   * Recompose a session that has not started talking.
   *
   * A preset is the arguments pi was started with, so changing it means a new
   * process rather than a setting — which is why the choice normally lives on
   * the new-session page. It stays open here for exactly as long as the session
   * has recorded no leading system message: nothing was produced under the old
   * composition, so replacing it contradicts no history. Once a turn exists the
   * transcript holds tool calls made under the old tool set, and the answer is
   * 409 — the same line dsh draws with `agent-preset-locked`.
   *
   * The session keeps its path, its id and its place in the sidebar; only the
   * process behind it is replaced.
   */
  route("POST", "/api/sessions/:id/preset", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const presetId = requireString(payload, "presetId");
    if (findPreset(presetId) === null) throw badRequest(`unknown preset: ${presetId}`);

    if (readSessionComposition(sessionPath).locked) {
      throw conflict("会话已经开始，组成无法更改；请新建一个会话");
    }

    // The cwd pi needs, from the same parse the lock check just made.
    let manager: ReturnType<typeof openSessionForRead>;
    try {
      manager = openSessionForRead(sessionPath);
    } catch (err) {
      throw notFound(`cannot open session: ${(err as Error).message}`);
    }

    // Close first: `open` hands back the live handle, which keeps the
    // composition it booted with. The replacement starts from the same file,
    // so nothing about the session moves but the arguments.
    await registry.close(sessionPath, "recompose");
    const handle = await registry.open(manager.getCwd(), sessionPath, presetId);
    json(res, 200, await liveComposer(handle));
  });

  route("POST", "/api/sessions/:id/prompt", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { message, images } = messageWithImages(asObject(body));
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.prompt(message, images));
    json(res, 200, { ok: true, sessionPath: handle.sessionPath });
  });

  route("POST", "/api/sessions/:id/steer", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { message, images } = messageWithImages(asObject(body));
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.steer(message, images));
    // The queue mirror needs the payloads this server saw; pi's queue_update
    // only reports texts, so the images of a queued message live only here.
    recordEnqueue(handle, "steer", message, images);
    json(res, 200, { ok: true });
  });

  route("POST", "/api/sessions/:id/follow-up", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { message, images } = messageWithImages(asObject(body));
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.followUp(message, images));
    recordEnqueue(handle, "followUp", message, images);
    json(res, 200, { ok: true });
  });

  /**
   * Edit or remove one queued message.
   *
   * pi's queue has no per-item operations — the whole lane is opaque strings —
   * so the server drains the lane, rewrites it, and pushes everything back
   * (see `queue.ts`). `expectedText` guards against a client acting on a view
   * that has already moved: on a mismatch pi's queue is restored untouched and
   * the caller gets a conflict to re-render from.
   */
  route("POST", "/api/sessions/:id/queue/update", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const mode = parseQueueMode(payload.mode);
    const index = requireInt(payload, "index");
    const expectedText = requireString(payload, "expectedText");
    const actionBody = asObject(payload.action);
    const action: QueueAction =
      actionBody.kind === "edit"
        ? { kind: "edit", text: requireString(actionBody, "text") }
        : { kind: "remove" };
    if (action.kind === "edit" && action.text.length === 0) {
      throw badRequest("edited text must not be empty");
    }
    const handle = await openSession(sessionPath);
    try {
      const { queue, failed } = await callClient(handle, () =>
        mutateQueue(handle, { mode, index, expectedText, action }),
      );
      json(res, 200, { ok: true, queue, failed });
    } catch (err) {
      if (err instanceof ConflictAfterRequeue) {
        throw conflict(
          err.failed.length > 0
            ? `queue changed; ${err.failed.length} message(s) could not be restored`
            : "queued item is no longer pending",
        );
      }
      throw err;
    }
  });

  route("POST", "/api/sessions/:id/abort", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.abort());
    json(res, 200, { ok: true });
  });

  /**
   * Run a built-in slash command (`/compact`, `/export`, …).
   *
   * These are not prompts — each maps to a dedicated RPC method — so the text
   * never reaches the model. The reply is a single line for the user.
   */
  route("POST", "/api/sessions/:id/command", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const name = requireString(payload, "name");
    const args = typeof payload.args === "string" ? payload.args : "";
    const handle = await openSession(sessionPath);
    const message = await callClient(handle, () => runBuiltinCommand(handle, name, args));
    json(res, 200, { ok: true, message });
  });

  /**
   * Plan mode, as the running process holds it.
   *
   * The read-only sibling of the switch below, and it exists for the same
   * reason: the session file lags the process (pi writes it lazily), so a `/plan`
   * typed into a session that has not spoken yet is only in memory. A client
   * that just sent that command asks here to learn what the log now holds,
   * instead of waiting for some later composer read that would answer from a
   * file with no entry in it.
   */
  route("GET", "/api/sessions/:id/plan", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const handle = await openSession(sessionPath);
    json(res, 200, { planMode: await planModeNow(handle, sessionPath) });
  });

  /**
   * Switch plan mode for a session.
   *
   * Plan mode belongs to a pi extension, so the switch is an extension command
   * (`/plan` / `/plan off`), and it has to go through `prompt` because that is
   * what expands extension commands. The browser could send the same text
   * itself, but it would then have to pretend it had sent a user message pi
   * never records; here the mode has one entry point, and the reply carries the
   * state the session file now holds.
   *
   * `active` is required and explicit rather than a toggle, so a repeated
   * request cannot flip the mode a second time.
   */
  route("POST", "/api/sessions/:id/plan", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { active } = asObject(body);
    if (typeof active !== "boolean") throw badRequest("active must be a boolean");
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.prompt(active ? "/plan" : "/plan off"));
    json(res, 200, { ok: true, planMode: await planModeNow(handle, sessionPath) });
  });

  /**
   * Rename a session by writing pi's own `session_info` entry, so the Web UI
   * and the CLI cannot disagree about what a session is called. An empty name
   * clears it, which is how "back to automatic" is spelled without a second
   * endpoint. See `session-title.ts` for the two writers.
   */
  route("POST", "/api/sessions/:id/rename", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { name } = asObject(body);
    if (typeof name !== "string") throw badRequest("name is required");
    if (!existsSync(sessionPath)) throw notFound("会话文件不存在");
    const live = registry.get(sessionPath);
    const trimmed = name.trim();
    await setSessionTitle(sessionPath, trimmed, live && !live.dead ? live.client : undefined);
    bus.publish({ type: "sessions_changed", projectPath: "" });
    json(res, 200, { ok: true, name: trimmed });
  });

  route("POST", "/api/sessions/:id/hidden", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { hidden } = asObject(body);
    if (typeof hidden !== "boolean") throw badRequest("hidden must be a boolean");
    const override = await setSessionOverride(sessionPath, { hidden });
    bus.publish({ type: "sessions_changed", projectPath: "" });
    json(res, 200, { ok: true, override });
  });

  /**
   * Delete a session for good.
   *
   * The resident pi process is retired first, so nothing keeps a file handle
   * on a JSONL that is about to disappear — and so the next click on that row
   * cannot respawn against a missing file. The file itself prefers the system
   * trash (see `session-delete.ts`), and the UI-side rename/hide override goes
   * with it. Sessions live only in pi's storage, so there is no local copy to
   * clean up beyond that override.
   */
  route("DELETE", "/api/sessions/:id", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    await registry.close(sessionPath, "deleted");
    // The session is gone for good, so its shells have nowhere left to be
    // shown. Leaving them running would keep a `node` process alive under a
    // tab that can never be reopened.
    terminals.closeForSession(sessionPath);
    const result = await deleteSession(sessionPath);
    if (!result.ok) {
      if (result.missing === true) throw notFound("会话文件不存在");
      throw new HttpError(500, `无法删除会话：${result.error}`);
    }
    bus.publish({ type: "sessions_changed", projectPath: "" });
    json(res, 200, { ok: true, method: result.method });
  });

  route("POST", "/api/sessions/:id/stop", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    await registry.close(sessionPath, "user-request");
    json(res, 200, { ok: true });
  });

  /**
   * Re-read a session from disk. Used after `session_external_changed`: the
   * Web UI drops its process and adopts whatever the CLI wrote last.
   */
  route("POST", "/api/sessions/:id/reload", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    await registry.close(sessionPath, "reload");
    const handle = await openSession(sessionPath);
    const messages = await callClient(handle, () => handle.client.getMessages());
    json(res, 200, {
      ok: true,
      sessionPath: handle.sessionPath,
      sessionId: handle.sessionId,
      messages,
    });
  });

  // --- terminals ------------------------------------------------------------

  /**
   * Where a session's shell starts.
   *
   * A live session answers directly: its handle carries the canonical project
   * directory the pi process runs in. One that has not been opened yet is read
   * from disk — the same lookup `openSession` does, minus the spawn, because
   * opening a shell must not cost a pi process.
   *
   * A draft session has neither. pi writes a session file only once an
   * assistant message arrives, so until then there is nothing on disk to read,
   * and the client sends the workspace it is showing instead. That path is
   * checked against the registered projects rather than trusted: it still
   * arrives from a browser, and while "browse the host filesystem" is a feature
   * this app has on purpose (the directory picker), "run a shell anywhere" is
   * not one of them.
   */
  const terminalCwd = async (input: {
    sessionPath: string;
    requested: string | undefined;
  }): Promise<string> => {
    if (input.sessionPath.length > 0) {
      const live = registry.get(input.sessionPath);
      if (live !== undefined) return live.projectPath;
      // The id has to be checked before it is handed to `SessionManager`. On a
      // path that is not a session — a draft, `draft:…`, is one — `open` does
      // not fail: it answers with the *server process's own* working directory.
      // Trusting that would start a brand-new session's shell wherever the
      // server happened to be launched, and would skip the workspace check
      // below for exactly the case that check exists for.
      if (isSessionFile(input.sessionPath)) {
        try {
          return SessionManager.open(input.sessionPath).getCwd();
        } catch {
          // On disk but unreadable. The requested workspace below answers.
        }
      }
    }
    if (input.requested !== undefined) {
      const projects = await listProjects();
      const known = projects.find((project) => project.path === input.requested);
      if (known !== undefined) return known.path;
      throw badRequest(`不是已注册的工作区：${input.requested}`);
    }
    throw badRequest("无法确定这个会话的工作目录");
  };

  /**
   * What this host can offer, what is already open for a session, and the
   * bounds the browser has to respect.
   *
   * One request rather than three because the panel asks them at the same
   * moment, and the last two are meaningless when the answer to the first is
   * "no shells here". Support is cheap: it reports whether the optional native
   * module loads, not whether a shell can start.
   */
  route("GET", "/api/terminal", ({ res, query }) => {
    const requested = query.get("sessionPath");
    const sessionPath = requested === null || requested.length === 0 ? undefined : requested;
    json(res, 200, {
      support: terminals.support(),
      environment: terminals.environment(),
      terminals: terminals.list(sessionPath),
    });
  });

  /**
   * The shell picker's choices: installed shells, execution default first.
   *
   * Registered before `/:id` so "shells" is a path, not a terminal id. The
   * default is repeated as a field rather than left implicit, because "the
   * first one" is the server's rule and the browser must not have to guess it.
   */
  route("GET", "/api/terminal/shells", ({ res }) => {
    const shells = terminals.shells();
    json(res, 200, { shells, default: shells[0] ?? null });
  });

  /** Terminals whose process outlived a failed close, and can be retried. */
  route("GET", "/api/terminal/cleanup", ({ res }) => {
    json(res, 200, { failures: terminals.cleanupFailures() });
  });

  route("POST", "/api/terminal/cleanup/:id/retry", ({ res, params }) => {
    json(res, 200, { retried: terminals.retryCleanup(params.id!) });
  });

  /** Open a shell. The response is the tab's handle, so it is a 201. */
  route("POST", "/api/terminal", async ({ res, body }) => {
    const payload = asObject(body);
    const sessionPath = optionalString(payload, "sessionPath") ?? "";
    const cols = requireNumber(payload, "cols");
    const rows = requireNumber(payload, "rows");
    const cwd = await terminalCwd({
      sessionPath,
      requested: optionalString(payload, "cwd"),
    });
    const id = optionalString(payload, "id");
    const shellPath = optionalString(payload, "shellPath");
    json(
      res,
      201,
      terminals.create({
        ...(id === undefined ? {} : { id }),
        ...(shellPath === undefined ? {} : { shellPath }),
        sessionPath,
        cwd,
        cols,
        rows,
      }),
    );
  });

  /**
   * Attach a page to a shell: take input control and answer with the screen.
   *
   * The snapshot is what makes reconnecting cheap and correct: a headless
   * xterm serialized the screen up to `sequence`, so the client resets its own
   * xterm, writes this, and then applies live frames from `sequence + 1`.
   */
  route("POST", "/api/terminal/:id/attach", async ({ res, params, body }) => {
    const attachmentId = requireString(asObject(body), "attachmentId");
    json(res, 200, await terminals.attach(params.id!, attachmentId));
  });

  /** Let go of the shell without ending it. */
  route("POST", "/api/terminal/:id/detach", ({ res, params, body }) => {
    terminals.detach(params.id!, requireString(asObject(body), "attachmentId"));
    json(res, 200, { ok: true });
  });

  /** The screen without taking control — used to repair a sequence gap. */
  route("GET", "/api/terminal/:id/snapshot", async ({ res, params }) => {
    json(res, 200, await terminals.snapshot(params.id!));
  });

  /**
   * The screen so far, in the pre-snapshot shape.
   *
   * Kept for one release so a page served from an older build can still mount;
   * new clients use `/:id/snapshot`, which also carries the sequence.
   */
  route("GET", "/api/terminal/:id", ({ res, params }) => {
    const scrollback = terminals.scrollbackOf(params.id!);
    if (scrollback === null) throw notFound(`终端不存在：${params.id!}`);
    json(res, 200, { scrollback });
  });

  route("POST", "/api/terminal/:id/input", ({ res, params, body }) => {
    const payload = asObject(body);
    terminals.write(params.id!, requireString(payload, "attachmentId"), requireString(payload, "data"));
    json(res, 200, { ok: true });
  });

  route("POST", "/api/terminal/:id/resize", ({ res, params, body }) => {
    const payload = asObject(body);
    terminals.resize(
      params.id!,
      requireString(payload, "attachmentId"),
      requireNumber(payload, "cols"),
      requireNumber(payload, "rows"),
    );
    json(res, 200, { ok: true });
  });

  /** Rename a shell. The title belongs to the session, not to one tab strip. */
  route("PATCH", "/api/terminal/:id", ({ res, params, body }) => {
    json(res, 200, terminals.rename(params.id!, optionalString(asObject(body), "title") ?? ""));
  });

  /** A mounted page says it is still looking; this is what keeps it from being reaped. */
  route("POST", "/api/terminal/:id/heartbeat", ({ res, params, body }) => {
    terminals.heartbeat(params.id!, requireString(asObject(body), "attachmentId"));
    json(res, 200, { ok: true });
  });

  /**
   * Close a shell.
   *
   * An id that is already gone answers `{ closed: false }` rather than 404:
   * closing a tab and closing the session it belongs to race by nature, and the
   * loser of that race was not doing anything wrong.
   */
  route("DELETE", "/api/terminal/:id", ({ res, params }) => {
    json(res, 200, { closed: terminals.close(params.id!) });
  });

  // --- extension UI responses ----------------------------------------------

  /**
   * The dialogs still waiting on the user.
   *
   * A page that loads (or reloads) while a dialog is pending learns about it
   * here: the SSE stream carries no history, so without this the card would
   * never come back and the pi process would stay blocked with nobody able to
   * answer it.
   */
  route("GET", "/api/ui-requests", ({ res }) => {
    json(res, 200, { requests: uiRequests.list() });
  });

  /**
   * Answer a dialog by its own id.
   *
   * The id is the address rather than the session path, because a fresh session
   * has no path yet when its extension asks: pi only reports one through
   * `get_state`, after `session_start` has already run.
   */
  route("POST", "/api/ui-requests/:id/response", async ({ res, params, body }) => {
    const payload = asObject(body);
    const outcome = await uiRequests.answer(params.id!, payload);
    if (outcome === "unknown") throw notFound("no dialog is waiting under that id");
    // The card is still on screen and still answerable, so this is a rejected
    // attempt rather than a settled question: the entry stays pending.
    if (outcome === "invalid") throw badRequest("that dialog cannot read this answer");
    json(res, 200, { ok: true });
  });

  // --- event stream ---------------------------------------------------------

  /**
   * Live SSE connections, keyed by the id handed to the client in `hello`.
   *
   * Two things live here that the client cannot know on its own: which session
   * this tab is reading, and how far behind its socket has fallen.
   */
  interface EventStream {
    /**
     * The session this client is reading.
     *
     * `undefined` (not declared yet) means send everything: the frames before
     * the client's first subscription must not be lost, and a client that never
     * subscribes is an older build. `null` means it is reading no session and
     * wants none of the per-session stream.
     */
    sessionPath: string | null | undefined;
    /** Set while `res.write` reported a full buffer; cleared by `drain`. */
    throttled: boolean;
    /** Frames held back while throttled, in order. */
    queue: string[];
    /** Running byte total of `queue` — the bound that actually matters. */
    queuedBytes: number;
  }

  const streams = new Map<string, EventStream>();

  route("GET", "/api/events", ({ req, res }) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const stream: EventStream = {
      sessionPath: undefined,
      throttled: false,
      queue: [],
      queuedBytes: 0,
    };
    const connectionId = randomUUID();
    streams.set(connectionId, stream);

    /**
     * Write a frame, waiting out the socket's own buffer when it is full.
     *
     * `res.write` returning false is Node saying its buffer is full — the
     * client is not reading fast enough. Ignoring that (writing anyway) is what
     * let a stalled stream grow without bound: the benchmark held ~690MB across
     * four slow readers. Here the frame waits for `drain`, every later frame
     * queues behind it, and a queue past the cap ends the connection.
     *
     * Ending it is the only honest option. The held frames are stream deltas,
     * so discarding them would leave the transcript wrong; a dropped socket
     * makes `EventSource` reconnect, and the client re-reads an authoritative
     * snapshot on the way back.
     */
    const write = (chunk: string): void => {
      if (res.destroyed) return;
      if (stream.throttled) {
        stream.queue.push(chunk);
        stream.queuedBytes += Buffer.byteLength(chunk);
        if (stream.queuedBytes > sseMaxBufferedBytes) {
          stream.queue.length = 0;
          stream.queuedBytes = 0;
          res.destroy();
        }
        return;
      }
      if (!res.write(chunk)) stream.throttled = true;
    };

    res.on("drain", () => {
      stream.throttled = false;
      while (stream.queue.length > 0) {
        const next = stream.queue.shift()!;
        stream.queuedBytes -= Buffer.byteLength(next);
        if (!res.write(next)) {
          stream.throttled = true;
          return;
        }
      }
    });

    // Ask the browser to come back within a second: a reconnect only costs a
    // snapshot read, and waiting out its multi-second default stalls the UI.
    write("retry: 1000\n\n");
    write(": connected\n\n");
    write(
      `event: hello\ndata: ${JSON.stringify({
        connectionId,
        activeSessions: registry.list().map((handle) => handle.sessionPath),
      })}\n\n`,
    );

    const unsubscribe = bus.subscribe((event) => {
      if (!wantsFrame(stream.sessionPath, event)) return;
      write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => write(": ping\n\n"), 20_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(connectionId);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  /**
   * Point a live stream at the session its tab is reading.
   *
   * The client calls this on every session switch. Until it lands the stream
   * still carries everything, so a switch never races the filter.
   */
  route("POST", "/api/events/subscription", ({ res, body }) => {
    const payload = asObject(body);
    const stream = streams.get(requireString(payload, "connectionId"));
    if (!stream) throw notFound("no live event stream with that id");
    stream.sessionPath =
      payload.sessionPath === null ? null : requireString(payload, "sessionPath");
    json(res, 200, { ok: true });
  });

  // --- dispatch -------------------------------------------------------------

  const matchRoute = (
    method: string,
    pathname: string,
  ): { handler: Handler; params: Record<string, string> } | null => {
    const segments = pathname.split("/").filter(Boolean);
    for (const candidate of routes) {
      if (candidate.method !== method) continue;
      if (candidate.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < candidate.segments.length; i += 1) {
        const pattern = candidate.segments[i]!;
        const value = segments[i]!;
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(value);
        } else if (pattern !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: candidate.handler, params };
    }
    return null;
  };

  return async (req, res) => {
    try {
      assertLocalRequest(req);

      const url = new URL(req.url ?? "/", "http://localhost");
      const match = matchRoute(req.method ?? "GET", url.pathname);
      if (!match) {
        // Not an API route: the built front end gets first refusal, and only
        // then does an unknown path become a 404.
        if (staticHandler && (await staticHandler(req, res, url.pathname))) {
          return;
        }
        json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
        return;
      }
      const hasBody = BODY_METHODS.has(req.method ?? "GET");
      if (hasBody && declaredBodyTooLarge(req, requestBodyMaxBytes)) {
        throw new HttpError(413, "request body too large");
      }
      const body = hasBody ? await readJsonBody(req, requestBodyMaxBytes) : undefined;
      await match.handler({ req, res, params: match.params, query: url.searchParams, body });
    } catch (err) {
      const httpError = toHttpError(err);
      if (!res.headersSent) {
        json(res, httpError.status, { error: httpError.message });
      } else {
        res.end();
      }
    }
  };
}

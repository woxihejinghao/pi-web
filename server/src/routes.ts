import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "./bus.ts";
import { BUILTIN_COMMANDS, runBuiltinCommand } from "./commands.ts";
import { badRequest, forbidden, HttpError, notFound } from "./errors.ts";
import type { StaticHandler } from "./static.ts";
import {
  ExtensionConfigError,
  readExtensions,
  setExtensionEnabled,
} from "./extensions.ts";
import { TodoConfigError, installTodoExtension, readTodo } from "./todo.ts";
import {
  UpdatesConfigError,
  readUpdates,
  updateExtension,
} from "./updates.ts";
import {
  McpConfigError,
  deleteMcpServer,
  importMcpConfigs,
  installMcpAdapter,
  probeMcpServer,
  readMcp,
  saveMcpServer,
  setMcpServerEnabled,
  type McpSecretRow,
  type McpServerDraft,
} from "./mcp.ts";
import { listDirectories, startLocations } from "./fs-browse.ts";
import { pendingUiRequests, type PendingUiRequests } from "./ui-requests.ts";
import {
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
import { deleteSession } from "./session-delete.ts";
import { assertAllowedSessionPath, getSessionRoot, sessionDirFor } from "./session-path.ts";
import { readSessionSnapshot, readSessionTree } from "./session-reader.ts";
import { listSessions } from "./sessions.ts";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  mutateStore,
  readStore,
  type AppearancePreference,
  type BusySendBehavior,
  type TranscriptDisplay,
} from "./store.ts";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: RequestContext) => Promise<void> | void;

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
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<unknown> {
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
 * the first place. Bounds mirror dsh's theme schema (12..17).
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

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`${key} is required`);
  }
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
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw badRequest("transport must be stdio, http, or sse");
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

function parseModelEntries(value: unknown): ProviderModelEntry[] {
  if (!Array.isArray(value)) throw badRequest("models must be an array");
  return value.map((entry) => {
    const item = asObject(entry);
    const id = optionalString(item, "id") ?? "";
    if (id.length === 0) throw badRequest("模型 ID 不能为空。");
    const name = optionalString(item, "name") ?? "";
    return name.length === 0 ? { id } : { id, name };
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
  if (err instanceof TodoConfigError) return badRequest(err.message);
  if (err instanceof UpdatesConfigError) return badRequest(err.message);
  if (err instanceof McpConfigError) return badRequest(err.message);
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
  const { registry, bus, staticHandler = null } = deps;
  const sessionRoot = deps.sessionRoot ?? getSessionRoot();
  const uiRequests = deps.uiRequests ?? pendingUiRequests;
  const routes: Route[] = [];

  const route = (method: string, path: string, handler: Handler): void => {
    routes.push({ method, segments: path.split("/").filter(Boolean), handler });
  };

  const allowedPath = (raw: string): string => assertAllowedSessionPath(raw, sessionRoot);

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
    let cwd: string;
    try {
      cwd = SessionManager.open(sessionPath).getCwd();
    } catch (err) {
      throw notFound(`cannot open session: ${(err as Error).message}`);
    }
    return registry.open(cwd, sessionPath);
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
  const liveComposer = async (handle: SessionHandle): Promise<ComposerState> => {
    const catalog = await readModelCatalog();
    return await callClient(handle, () => readComposerFromClient(handle.client, catalog));
  };

  /**
   * Composer state from the session file, with a missing session reported as
   * 404 and a broken `models.json` left to bubble up as the 400 it is.
   */
  const diskComposer = async (sessionPath: string): Promise<ComposerState> => {
    // Read first, so a config error is not misreported as a missing session.
    const catalog = await readModelCatalog();
    try {
      return await readComposerFromDisk(sessionPath, catalog);
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
      if (patch.contentFontSize !== undefined) {
        next.contentFontSize = requireFontSize(patch.contentFontSize);
      }
      if (patch.transcriptDisplay !== undefined) {
        next.transcriptDisplay = requireChoice<TranscriptDisplay>(
          patch.transcriptDisplay,
          ["normal", "compact"],
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
      if (patch.todoNoticeDismissed !== undefined) {
        if (typeof patch.todoNoticeDismissed !== "boolean") {
          throw badRequest("todoNoticeDismissed must be a boolean");
        }
        next.todoNoticeDismissed = patch.todoNoticeDismissed;
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

  // --- the task-list extension ----------------------------------------------

  /**
   * Whether the next pi start would load the extension behind the `todo` tool.
   *
   * The task panel is a projection of that tool's transcript output, so with
   * the extension missing there is nothing to project. The answer separates
   * `available` (loadable now) from `installed` (referenced in pi's settings at
   * all), so the UI can tell "not installed" apart from "installed but
   * disabled" — only the first one should offer an install button.
   */
  route("GET", "/api/todo", async ({ res, query }) => {
    const projectPath = query.get("projectPath");
    json(res, 200, await readTodo(projectPath && projectPath.length > 0 ? projectPath : null));
  });

  /**
   * Install the extension the `todo` tool ships in.
   *
   * The same operation as `pi install npm:@juicesharp/rpiv-todo`, through pi's
   * own package manager. Slow by nature (npm has to resolve and download), and
   * the resident pi processes have to be retired afterwards so the next message
   * actually loads it.
   */
  route("POST", "/api/todo/install", async ({ res, body }) => {
    const payload = body === undefined ? {} : asObject(body);
    const view = await installTodoExtension(optionalProjectPath(payload));
    await registry.closeAllExcept(null, "todo-extension-installed");
    json(res, 200, view);
  });

  // --- MCP servers ----------------------------------------------------------

  /**
   * The MCP inventory: every server the adapter would load for a workspace,
   * plus the files it read and the host configs it could import.
   *
   * pi has no MCP support of its own — it comes from the `pi-mcp-adapter`
   * extension — so this is served through the adapter's exported config layer
   * rather than by parsing its files here. When the extension is missing the
   * response says so (`available: false`) instead of looking empty.
   */
  route("GET", "/api/mcp", async ({ res, query }) => {
    const projectPath = query.get("projectPath");
    json(res, 200, await readMcp(projectPath && projectPath.length > 0 ? projectPath : null));
  });

  /**
   * Install `pi-mcp-adapter` (the extension MCP support comes from).
   *
   * Same operation as `pi install npm:pi-mcp-adapter`, through pi's own package
   * manager, so the two agree on where the package lands and what settings.json
   * records. It can take a while — npm has to resolve and download — and the
   * page shows progress rather than blocking on a spinner with no explanation.
   */
  route("POST", "/api/mcp/install", async ({ res, body }) => {
    const payload = body === undefined ? {} : asObject(body);
    const view = await installMcpAdapter(optionalProjectPath(payload));
    // The next pi process has to load the new extension, and MCP servers are
    // connected at startup; retiring the resident ones is the equivalent of
    // dsh's 重启.
    await registry.closeAllExcept(null, "mcp-adapter-installed");
    json(res, 200, view);
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
   * This writes the project-local Pi override, which is what pi's own
   * `/mcp disable` does — there is no user-level "off" for an MCP server.
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

  route("POST", "/api/mcp/imports", async ({ res, body }) => {
    const payload = asObject(body);
    const kinds = Array.isArray(payload.kinds)
      ? payload.kinds.filter((kind): kind is string => typeof kind === "string")
      : [];
    const view = await importMcpConfigs(optionalProjectPath(payload), kinds);
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
    const sessions = await listSessions(project.path, {
      sessionDir: sessionDirFor(project.path, sessionRoot),
      includeHidden: query.get("includeHidden") === "true",
    });
    json(res, 200, sessions);
  });

  /**
   * Slash commands available in a project: built-in commands, extension
   * commands, prompt templates, and skill commands.
   *
   * Built-in ones come from this server, not from pi — see `commands.ts`. They
   * are listed first and survive a failure to reach pi, since they need no
   * running process to be worth offering.
   */
  route("GET", "/api/projects/:id/commands", async ({ res, params }) => {
    const project = await getProject(params.id!);
    const builtin: SlashCommand[] = BUILTIN_COMMANDS.map((command) => ({
      name: command.name,
      description: command.argumentHint
        ? `${command.description}　${command.argumentHint}`
        : command.description,
      source: "builtin",
    }));

    try {
      json(res, 200, { commands: [...builtin, ...(await registry.listCommands(project.path))] });
    } catch (err) {
      // A failure here only costs the user their completions, so report it
      // inline instead of as an error banner.
      json(res, 200, { commands: builtin, error: (err as Error).message });
    }
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

  // --- sessions -------------------------------------------------------------

  route("POST", "/api/sessions", async ({ res, body }) => {
    const payload = asObject(body);
    const { projectId } = payload;
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw badRequest("projectId is required");
    }
    const project = await getProject(projectId);
    const model = optionalModel(payload);

    // A prewarmed process has already paid pi's cold start, so it can be
    // handed over without waiting. Claiming it also frees the slot, so warm
    // the next one immediately to keep back-to-back "new session" instant.
    const claimed = registry.claimPrewarmed(project.path);
    if (claimed) {
      void registry.prewarm(project.path);
      json(res, 201, {
        sessionPath: claimed.sessionPath,
        sessionId: claimed.sessionId,
        projectPath: project.path,
        prewarmed: true,
        ...(await applyModel(claimed, model)),
      });
      return;
    }

    const handle = await registry.open(project.path);
    json(res, 201, {
      sessionPath: handle.sessionPath,
      sessionId: handle.sessionId,
      projectPath: project.path,
      prewarmed: false,
      ...(await applyModel(handle, model)),
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
   * The transcript, served from disk when no process is running.
   *
   * Switching to a session is the single most latency-sensitive action in the
   * UI, and it used to spawn pi (1.5–3.2s) just to read a file. A resident
   * session still answers from memory — it is authoritative there, and may hold
   * turns that have not been flushed yet — but everything else is read directly.
   */
  route("GET", "/api/sessions/:id/messages", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const live = registry.get(sessionPath);

    if (live && !live.dead) {
      const messages = await callClient(live, () => live.client.getMessages());
      // pi answers this from the live session, so it already knows which user
      // messages are forkable — no need to re-derive it from the file.
      const forkPoints = await callClient(live, () => live.client.getForkMessages());
      json(res, 200, {
        sessionPath: live.sessionPath,
        sessionId: live.sessionId,
        messages,
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
    json(res, 200, {
      sessionPath,
      sessionId: snapshot.sessionId,
      messages: snapshot.messages,
      forkPoints: snapshot.forkPoints,
    });
  });

  /**
   * The entry tree behind a session, for the `/tree` view.
   *
   * Read from disk when no process is resident, same as the transcript: a tree
   * is not worth a 1.5–3.2s cold start, and the file is the authority when
   * nothing is running.
   */
  route("GET", "/api/sessions/:id/tree", async ({ res, params }) => {
    const sessionPath = allowedPath(params.id!);
    const live = registry.get(sessionPath);

    if (live && !live.dead) {
      const { tree, leafId } = await callClient(live, () => live.client.getTree());
      json(res, 200, { sessionId: live.sessionId, tree, leafId, source: "live" });
      return;
    }

    let snapshot;
    try {
      snapshot = readSessionTree(sessionPath);
    } catch (err) {
      throw notFound(`无法读取会话：${(err as Error).message}`);
    }
    json(res, 200, { ...snapshot, source: "disk" });
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
    json(res, 200, { ok: true });
  });

  route("POST", "/api/sessions/:id/follow-up", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { message, images } = messageWithImages(asObject(body));
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.followUp(message, images));
    json(res, 200, { ok: true });
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

  route("POST", "/api/sessions/:id/rename", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const { name } = asObject(body);
    if (typeof name !== "string") throw badRequest("name is required");
    const override = await setSessionOverride(sessionPath, { name });
    bus.publish({ type: "sessions_changed", projectPath: "" });
    json(res, 200, { ok: true, override });
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
    const answered = await uiRequests.answer(params.id!, payload);
    if (!answered) throw notFound("no dialog is waiting under that id");
    json(res, 200, { ok: true });
  });

  // --- event stream ---------------------------------------------------------

  route("GET", "/api/events", ({ req, res }) => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        activeSessions: registry.list().map((handle) => handle.sessionPath),
      })}\n\n`,
    );

    const unsubscribe = bus.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
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
      const body = BODY_METHODS.has(req.method ?? "GET") ? await readJsonBody(req) : undefined;
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

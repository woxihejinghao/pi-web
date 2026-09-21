import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "./bus.ts";
import { BUILTIN_COMMANDS, runBuiltinCommand } from "./commands.ts";
import { badRequest, forbidden, HttpError, notFound } from "./errors.ts";
import { listDirectories, startLocations } from "./fs-browse.ts";
import {
  API_PROTOCOLS,
  KNOWN_PROVIDERS,
  ModelConfigError,
  authPath,
  deleteProvider,
  fetchProviderModels,
  modelsPath,
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
import { sendRawCommand, type SessionHandle, type SessionRegistry, type SlashCommand } from "./registry.ts";
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
 * A field the editor may omit. Absent means "leave the stored value alone",
 * which is what lets a save that did not retype the API key preserve it.
 */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${key} must be a string`);
  return value;
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
  const { registry, bus } = deps;
  const sessionRoot = deps.sessionRoot ?? getSessionRoot();
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

  // --- sessions -------------------------------------------------------------

  route("POST", "/api/sessions", async ({ res, body }) => {
    const { projectId } = asObject(body);
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw badRequest("projectId is required");
    }
    const project = await getProject(projectId);

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
      });
      return;
    }

    const handle = await registry.open(project.path);
    json(res, 201, {
      sessionPath: handle.sessionPath,
      sessionId: handle.sessionId,
      projectPath: project.path,
      prewarmed: false,
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

  route("POST", "/api/sessions/:id/prompt", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const message = requireString(payload, "message");
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.prompt(message, payload.images as never));
    json(res, 200, { ok: true, sessionPath: handle.sessionPath });
  });

  route("POST", "/api/sessions/:id/steer", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const message = requireString(payload, "message");
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.steer(message, payload.images as never));
    json(res, 200, { ok: true });
  });

  route("POST", "/api/sessions/:id/follow-up", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const payload = asObject(body);
    const message = requireString(payload, "message");
    const handle = await openSession(sessionPath);
    await callClient(handle, () => handle.client.followUp(message, payload.images as never));
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

  route("POST", "/api/sessions/:id/ui-response", async ({ res, params, body }) => {
    const sessionPath = allowedPath(params.id!);
    const handle = registry.get(sessionPath);
    if (!handle) throw notFound("session is not open");
    const payload = asObject(body);
    if (typeof payload.id !== "string") throw badRequest("id is required");
    await callClient(handle, () =>
      sendRawCommand(handle.client, { type: "extension_ui_response", ...payload }),
    );
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

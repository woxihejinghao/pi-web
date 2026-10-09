/**
 * pi's MCP servers, read and written in pi's own two `mcp.json` files.
 *
 * pi has built-in MCP support: it reads `mcp.json` in the agent dir and, for a
 * project, `<project>/.pi/mcp.json`. This module does not delegate that to an
 * extension — the semantics below mirror pi's own loader
 * (`extensions/mcp/config.ts`), because a list that disagrees with what pi
 * connects to is worse than no list:
 *
 * - a project entry replaces a global entry with the same name;
 * - a project entry without `command`, `url`, or `type` overrides only
 *   `enabled`, `exposure`, and `toolExposure` of the global server, so "off in
 *   this workspace" is expressible without restating credentials;
 * - two names that differ only in `-` versus `_` share a tool namespace and the
 *   second one is rejected;
 * - the format is strict JSON, like pi's reader (comments are an error there
 *   too, so they are an error here rather than something this page would
 *   silently rewrite away).
 *
 * Two things never leave this process: environment values and header values.
 * The config is a plain object holding API keys in `env`, so the views built
 * here carry key *names* only.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { probeMcpEntry, type McpProbeResult } from "./mcp-probe.ts";

/** pi's project config directory (`.pi`, next to the project's other pi files). */
const PROJECT_CONFIG_DIR = ".pi";
/** The file name in both layers. */
const CONFIG_FILE = "mcp.json";

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The subset of a pi server entry this UI reads and writes. The real schema is
 * wider (`oauth`, `toolExposure`, `timeout`, …) and unknown fields are preserved
 * by spreading the stored entry before applying an edit.
 */
export interface McpServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** OAuth client settings for servers without dynamic client registration. */
  oauth?: Record<string, unknown>;
  /** Use a `/login` provider's token instead of OAuth. Global layer only. */
  auth?: { provider: string };
  enabled?: boolean;
  exposure?: string;
  description?: string;
  toolExposure?: Record<string, string>;
  timeout?: number;
  [key: string]: unknown;
}

export type McpTransport = "stdio" | "http" | "unknown";

export interface McpServerView {
  name: string;
  transport: McpTransport;
  /** Command line for stdio, URL for remote. */
  detail: string;
  /**
   * The editable fields, so the editor can prefill them without the row having
   * to round-trip through pi. `args` is the joined form; the server keeps the
   * stored array untouched unless the text actually changed.
   */
  command: string | null;
  args: string;
  cwd: string | null;
  url: string | null;
  /** Environment variable *names* — values never leave the server. */
  envKeys: string[];
  /** Header *names* only, same reason. */
  headerKeys: string[];
  /**
   * Declared authentication. `oauth` is the default for an HTTP server without
   * an `Authorization` header (pi signs in on 401); `provider` means the entry
   * sends a `/login` provider's token instead.
   */
  auth: "oauth" | "provider" | "none";
  /** Whether the server would connect: pi only skips `enabled: false`. */
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
  /** Every file this page may read or write, for the layout footer. */
  paths: {
    /** Where "add (global)" writes, and where pi reads user-level servers. */
    global: string;
    /** Where "add (workspace)" writes. Empty without a workspace. */
    project: string;
  };
  error: string | null;
}

// --- paths ------------------------------------------------------------------

export function mcpPaths(projectPath: string | null): McpView["paths"] {
  return {
    global: join(getAgentDir(), CONFIG_FILE),
    project:
      projectPath === null || projectPath.length === 0
        ? ""
        : join(projectPath, PROJECT_CONFIG_DIR, CONFIG_FILE),
  };
}

// --- reading ----------------------------------------------------------------

/** Keys a project entry may set when it only overrides a global server. */
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/**
 * Whether an entry overrides a server defined elsewhere instead of defining
 * one. This is pi's own test, so the page and the loader agree on which project
 * entries need a global counterpart.
 */
function isOverride(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined;
}

/** pi's tool namespace for a server: `mcp__<name>` with `-` replaced by `_`. */
function namespaceOf(name: string): string {
  return `mcp__${name.replace(/-/g, "_")}`;
}

interface LoadedServer {
  name: string;
  entry: McpServerEntry;
  scope: "global" | "project";
  path: string;
}

/**
 * Read one `mcp.json`. A missing file is an empty config; an unreadable or
 * malformed one is an error the caller records and skips, so one bad file does
 * not hide the other layer.
 */
async function readConfigFile(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new McpConfigError(`无法读取 ${filePath}：${(err as Error).message}`);
  }
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // pi's loader is strict JSON too; rather than strip comments and rewrite the
    // file differently, refuse and let the user fix that file by hand.
    throw new McpConfigError(`${filePath} 不是标准 JSON：${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new McpConfigError(`${filePath} 的顶层必须是对象。`);
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new McpConfigError(`${filePath} 的 mcpServers 必须是对象。`);
  }
  return parsed;
}

/**
 * Merge the two layers the way pi does: global first, project on top.
 * Disabled servers stay in the list so they can be enabled again.
 */
async function loadServers(
  projectPath: string | null,
): Promise<{ servers: LoadedServer[]; errors: string[] }> {
  const paths = mcpPaths(projectPath);
  const layers: Array<{ scope: "global" | "project"; path: string }> = [
    { scope: "global", path: paths.global },
  ];
  if (paths.project.length > 0) layers.push({ scope: "project", path: paths.project });

  const servers = new Map<string, LoadedServer>();
  const errors: string[] = [];

  for (const layer of layers) {
    let raw: Record<string, unknown>;
    try {
      raw = await readConfigFile(layer.path);
    } catch (err) {
      errors.push((err as Error).message);
      continue;
    }
    const entries = isRecord(raw.mcpServers) ? raw.mcpServers : {};

    for (const [name, value] of Object.entries(entries)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        errors.push(`${layer.path}：服务器名 ${name} 含非法字符（只允许字母、数字、_ 和 -）。`);
        continue;
      }
      if (!isRecord(value)) {
        errors.push(`${layer.path}：${name} 不是一个对象。`);
        continue;
      }

      if (layer.scope === "project" && isOverride(value)) {
        const base = servers.get(name);
        if (base === undefined) {
          errors.push(`${layer.path}：${name} 没有 command 或 url，全局层也没有同名服务器可以覆盖。`);
          continue;
        }
        const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
        if (extra.length > 0) {
          errors.push(`${layer.path}：${name} 是覆盖项，只能设置 ${OVERRIDE_KEYS.join("、")}。`);
          continue;
        }
        servers.set(name, { ...base, entry: { ...base.entry, ...value } });
        continue;
      }

      if (typeof value.command !== "string" && typeof value.url !== "string") {
        errors.push(`${layer.path}：${name} 需要 command 或 url。`);
        continue;
      }

      // Names that differ only in `-` and `_` would share a tool namespace.
      const clash = [...servers.keys()].find(
        (other) => other !== name && namespaceOf(other) === namespaceOf(name),
      );
      if (clash !== undefined) {
        errors.push(`${layer.path}：${name} 与 ${clash} 的工具命名空间冲突。`);
        continue;
      }

      servers.set(name, {
        name,
        entry: value as McpServerEntry,
        scope: layer.scope,
        path: layer.path,
      });
    }
  }

  return { servers: [...servers.values()], errors };
}

function transportOf(entry: McpServerEntry): McpTransport {
  if (typeof entry.command === "string" && entry.command.length > 0) return "stdio";
  if (typeof entry.url === "string" && entry.url.length > 0) return "http";
  return "unknown";
}

function detailOf(entry: McpServerEntry, transport: McpTransport): string {
  if (transport === "stdio") {
    const args = Array.isArray(entry.args) ? entry.args.filter((arg) => typeof arg === "string") : [];
    return [entry.command, ...args].join(" ");
  }
  return typeof entry.url === "string" ? entry.url : "";
}

function authOf(entry: McpServerEntry): "oauth" | "provider" | "none" {
  if (typeof entry.url !== "string" || entry.url.length === 0) return "none";
  if (isRecord(entry.auth) && typeof entry.auth.provider === "string") return "provider";
  // OAuth only applies to HTTP servers without an `Authorization` header; a
  // literal header means the credential comes from the config file instead.
  const headers = isRecord(entry.headers) ? entry.headers : {};
  if (Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) return "none";
  return "oauth";
}

function keyNames(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).filter((key) => typeof key === "string") : [];
}

function toServerView(server: LoadedServer): McpServerView {
  const { entry } = server;
  const transport = transportOf(entry);
  const args = Array.isArray(entry.args) ? entry.args.filter((arg) => typeof arg === "string") : [];
  return {
    name: server.name,
    transport,
    detail: detailOf(entry, transport),
    command: typeof entry.command === "string" ? entry.command : null,
    args: args.join(" "),
    cwd: typeof entry.cwd === "string" ? entry.cwd : null,
    url: typeof entry.url === "string" ? entry.url : null,
    envKeys: keyNames(entry.env),
    headerKeys: keyNames(entry.headers),
    auth: authOf(entry),
    enabled: entry.enabled !== false,
    sourcePath: server.path,
    sourceKind: server.scope === "project" ? "project" : "user",
  };
}

/** Read the MCP inventory for one workspace. Never throws; reports failure. */
export async function readMcp(projectPath: string | null): Promise<McpView> {
  const paths = mcpPaths(projectPath);
  try {
    const { servers, errors } = await loadServers(projectPath);
    return {
      agentDir: getAgentDir(),
      projectPath,
      servers: servers.map(toServerView),
      errors,
      paths,
      error: null,
    };
  } catch (err) {
    return {
      agentDir: getAgentDir(),
      projectPath,
      servers: [],
      errors: [],
      paths,
      error: (err as Error).message,
    };
  }
}

// --- writing ----------------------------------------------------------------

/** One editable environment/header row. An empty value means "keep stored". */
export interface McpSecretRow {
  key: string;
  value: string;
}

export interface McpServerDraft {
  name: string;
  transport: "stdio" | "http";
  /** stdio fields. */
  command: string;
  args: string;
  cwd: string;
  /** remote fields. */
  url: string;
  env: McpSecretRow[];
  headers: McpSecretRow[];
}

export interface SaveMcpServerInput {
  projectPath: string | null;
  scope: "global" | "project";
  /** Present when editing; the row's current name, which may be renamed. */
  originalName: string | null;
  draft: McpServerDraft;
}

/**
 * Resolve a secret map from the submitted rows.
 *
 * A row whose value is empty keeps whatever is stored: the page never receives
 * the current value, so it has no way to echo one back, and treating "did not
 * retype" as "clear it" would delete keys on every save. Rows the user removed
 * are simply absent from the result, which is what makes the form's row list
 * the authority on which keys exist.
 */
function mergeSecrets(
  rows: McpSecretRow[],
  stored: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    if (row.value.length > 0) out[key] = row.value;
    else if (stored !== undefined && stored[key] !== undefined) out[key] = stored[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The entry an edit should start from.
 *
 * The write target's own copy wins, so editing a project entry does not import
 * values the global layer happens to carry. When the target file has no copy at
 * all, the merged definition is the fallback — that is what keeps stored secret
 * values when a server defined in one layer is edited into the other.
 */
async function storedEntry(
  servers: Record<string, unknown>,
  lookupName: string | null,
  projectPath: string | null,
  name: string,
): Promise<McpServerEntry> {
  if (lookupName !== null && isRecord(servers[lookupName])) {
    return servers[lookupName] as McpServerEntry;
  }
  const { servers: merged } = await loadServers(projectPath);
  return merged.find((server) => server.name === name)?.entry ?? {};
}

/** Build the entry an edit should store, keeping everything the form omits. */
function buildEntry(stored: McpServerEntry, draft: McpServerDraft): McpServerEntry {
  const next: McpServerEntry = { ...stored };
  const storedArgs = Array.isArray(stored.args)
    ? stored.args.filter((arg) => typeof arg === "string")
    : [];
  delete next.command;
  delete next.args;
  delete next.cwd;
  delete next.env;
  delete next.url;
  delete next.headers;

  if (draft.transport === "stdio") {
    next.command = draft.command.trim();
    const argsText = draft.args.trim();
    if (argsText.length > 0) {
      // Split only when the text actually changed. Round-tripping the editor's
      // joined preview back through a split would rewrite an argument that
      // contains a space into two arguments, for a save that touched nothing.
      next.args = argsText === storedArgs.join(" ") ? storedArgs : argsText.split(/\s+/);
    }
    if (draft.cwd.trim().length > 0) next.cwd = draft.cwd.trim();
    const env = mergeSecrets(draft.env, stored.env);
    if (env !== undefined) next.env = env;
  } else {
    next.url = draft.url.trim();
    const headers = mergeSecrets(draft.headers, stored.headers);
    if (headers !== undefined) next.headers = headers;
  }
  return next;
}

function requireName(value: string): string {
  const name = value.trim();
  if (name.length === 0) throw new McpConfigError("服务器名称不能为空。");
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new McpConfigError("名称只能包含字母、数字、下划线和短横线。");
  }
  return name;
}

function validateDraft(draft: McpServerDraft): McpServerDraft {
  const name = requireName(draft.name);
  if (draft.transport === "stdio" && draft.command.trim().length === 0) {
    throw new McpConfigError("stdio 服务器需要一个命令。");
  }
  if (draft.transport === "http") {
    const url = draft.url.trim();
    if (url.length === 0) throw new McpConfigError("远程服务器需要一个 URL。");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
    } catch {
      throw new McpConfigError("URL 必须以 http:// 或 https:// 开头。");
    }
  }
  return { ...draft, name };
}

/** Temp file + rename, so a crash mid-write cannot truncate the config. */
async function writeConfigFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, filePath);
}

/** Create or update one server, then answer with the re-read inventory. */
export async function saveMcpServer(input: SaveMcpServerInput): Promise<McpView> {
  const draft = validateDraft(input.draft);
  const paths = mcpPaths(input.projectPath);
  let filePath: string;
  if (input.scope === "project") {
    if (paths.project.length === 0) {
      throw new McpConfigError("要先选择一个工作区，才能把服务器加到工作区。");
    }
    filePath = paths.project;
  } else {
    filePath = paths.global;
  }

  const raw = await readConfigFile(filePath);
  const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
  const lookupName = input.originalName ?? draft.name;
  const stored = await storedEntry(servers, lookupName, input.projectPath, draft.name);

  // A rename has to remove the old key from the same file, or both definitions
  // would load.
  if (input.originalName !== null && input.originalName !== draft.name) {
    delete servers[input.originalName];
  }
  servers[draft.name] = buildEntry(stored, draft);
  raw.mcpServers = servers;
  await writeConfigFile(filePath, raw);
  return await readMcp(input.projectPath);
}

export interface DeleteMcpServerInput {
  projectPath: string | null;
  name: string;
}

/**
 * Delete a server definition from the topmost file that carries one.
 *
 * The project layer is tried first: for a server whose project entry is only an
 * override, removing it re-exposes the global definition, and the row coming
 * back after this is the truth rather than a failure.
 */
export async function deleteMcpServer(input: DeleteMcpServerInput): Promise<McpView> {
  const paths = mcpPaths(input.projectPath);
  const candidates = [paths.project, paths.global].filter((path) => path.length > 0);

  for (const filePath of candidates) {
    const raw = await readConfigFile(filePath);
    const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
    if (servers[input.name] === undefined) continue;
    delete servers[input.name];
    raw.mcpServers = servers;
    await writeConfigFile(filePath, raw);
    return await readMcp(input.projectPath);
  }
  throw new McpConfigError(`没有在配置文件里找到 MCP 服务器 ${input.name}。`);
}

export interface McpEnabledInput {
  projectPath: string | null;
  name: string;
  enabled: boolean;
}

/**
 * Enable or disable a server for one workspace.
 *
 * pi has no user-level "off": the state is a project entry. When the workspace's
 * own file already carries the definition, its `enabled` is edited in place;
 * otherwise a project override is added, of which `enabled` is the only key.
 */
export async function setMcpServerEnabled(input: McpEnabledInput): Promise<McpView> {
  const paths = mcpPaths(input.projectPath);
  if (paths.project.length === 0) {
    throw new McpConfigError("启用/停用会写入工作区的 .pi/mcp.json，请先选择一个工作区。");
  }

  const raw = await readConfigFile(paths.project);
  const servers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
  const existing = servers[input.name];

  if (isRecord(existing)) {
    // `enabled: true` on a full definition is the default, so pi drops the key
    // there; on an override it is a real statement and has to stay.
    if (input.enabled && !isOverride(existing)) delete existing.enabled;
    else existing.enabled = input.enabled;
    if (Object.keys(existing).length === 0) delete servers[input.name];
  } else {
    const merged = await loadServers(input.projectPath);
    const current = merged.servers.find((server) => server.name === input.name);
    if (current === undefined) throw new McpConfigError(`没有找到 MCP 服务器 ${input.name}。`);
    // Already on by default: an override that only says "enabled" would be noise.
    if (input.enabled && current.entry.enabled !== false) return await readMcp(input.projectPath);
    servers[input.name] = { enabled: input.enabled };
  }

  raw.mcpServers = servers;
  await writeConfigFile(paths.project, raw);
  return await readMcp(input.projectPath);
}

/**
 * Connect to one server and report what happened.
 *
 * This is the same handshake pi performs on startup — `initialize`, then
 * `tools/list` — done here rather than through a pi process, because the point
 * of the action is to answer "would this work?" for a definition the user just
 * typed, without spending a cold start on it. It runs only when asked: a stdio
 * server is an arbitrary command (`npx -y something@latest` included), so
 * nothing here is triggered by merely opening the page.
 */
export async function probeMcpServer(
  projectPath: string | null,
  name: string,
): Promise<McpProbeResult> {
  const { servers } = await loadServers(projectPath);
  const entry = servers.find((server) => server.name === name)?.entry;
  if (entry === undefined) throw new McpConfigError(`没有找到 MCP 服务器 ${name}。`);
  return await probeMcpEntry(entry);
}

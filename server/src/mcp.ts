/**
 * pi's MCP servers, read and written through pi-mcp-adapter's own config layer.
 *
 * pi itself has no MCP support; it comes from the `pi-mcp-adapter` extension.
 * That extension owns a config format with more moving parts than it looks:
 * a shared `~/.config/mcp/mcp.json`, the tool-agnostic `~/.agents` files, Pi's
 * own overrides in the agent dir and `.pi/`, project `.mcp.json`, compatibility
 * imports from cursor / claude-code / codex / opencode, and a merge order where
 * project wins over global and Pi-owned files win over shared ones. So this
 * module does not parse those files itself — it loads the adapter's exported
 * `pi-mcp-adapter/config` entry point and calls its `loadMcpConfig`,
 * `getServerProvenance`, `getMcpDiscoverySummary`, and write helpers.
 *
 * The same reasoning as the extensions section: a list that disagrees with what
 * pi actually connects to is worse than no list. The cost is that this page
 * only works when the adapter is installed, which is reported as
 * `available: false` rather than as an empty inventory.
 *
 * Two things never leave this process: environment values and header values.
 * The adapter's config is a plain object holding API keys in `env`, so the
 * views built here carry key *names* only.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { noProjectCwd } from "./config.ts";
import { probeMcpEntry, type McpProbeResult } from "./mcp-probe.ts";

const ADAPTER_PACKAGE = "pi-mcp-adapter";

/** What `pi install` takes on the command line, and what the page offers. */
export const ADAPTER_SOURCE = `npm:${ADAPTER_PACKAGE}`;

/**
 * Compatibility imports whose provenance is a *shared* file rather than another
 * agent's private config. They are reported with `kind: "import"` by the
 * adapter (that is how its merge list treats them), but their definitions do
 * live in files a user can edit here, unlike a cursor or claude-code file.
 */
const SHARED_IMPORT_KINDS = new Set([
  "global MCP config",
  ".agents MCP config",
  ".agents/mcp MCP config",
]);

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- the adapter's module surface -------------------------------------------

/**
 * The subset of a server entry this UI renders and writes. The real schema is
 * much wider (`lifecycle`, `directTools`, `searchKeywords`, `oauth`, …) and is
 * preserved by spreading the stored entry before applying an edit.
 */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  socket?: string;
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  httpTransport?: "streamable-http" | "sse";
  disabled?: boolean;
  [key: string]: unknown;
}

interface AdapterSource {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  scope: "global" | "project";
  kind: "shared" | "pi";
  serverCount: number;
}

interface AdapterSummary {
  sources: AdapterSource[];
  imports: Array<{ kind: string; path: string; serverCount: number }>;
  hostConfigs: Array<{ kind: string; path: string; serverCount: number; active: boolean }>;
  hostConfigDiscovery: "off" | "prompt" | "on";
  conflicts: Array<{
    serverName: string;
    sources: Array<{ kind: "shared" | "pi" | "host"; path: string }>;
    winner: { kind: "shared" | "pi" | "host"; path: string };
  }>;
  totalServerCount: number;
  hasAnyConfig: boolean;
}

interface AdapterProvenance {
  path: string;
  kind: "user" | "project" | "import";
  importKind?: string;
}

/** Declared locally because the package is not a dependency of this server. */
interface AdapterConfigModule {
  loadMcpConfig(overridePath?: string, cwd?: string): { mcpServers?: Record<string, McpServerEntry> };
  getMcpDiscoverySummary(overridePath?: string, cwd?: string): AdapterSummary;
  getServerProvenance(overridePath?: string, cwd?: string): Map<string, AdapterProvenance>;
  findAvailableImportConfigs(cwd?: string): Array<{ kind: string; path: string }>;
  previewCompatibilityImports(importKinds: string[], overridePath?: string): { afterText: string };
  ensureCompatibilityImports(kinds: string[], overridePath?: string): { path: string; added: string[] };
  writeSharedServerEntry(filePath: string, serverName: string, entry: McpServerEntry): string;
  writeProjectServerDisabledOverride(
    overridePath: string | undefined,
    cwd: string,
    serverName: string,
    disabled: boolean,
  ): { path: string; changed: boolean };
  getGenericGlobalConfigPath(): string;
  getProjectConfigPath(cwd?: string): string;
  getProjectPiConfigPath(cwd?: string): string;
  getPiGlobalConfigPath(overridePath?: string): string;
  getSharedConfigPath(target: "project" | "global", cwd?: string): string;
}

let cached: AdapterConfigModule | null = null;
let lastFailure: string | null = null;

/**
 * Test seam: forget the loaded module.
 *
 * The module is cached because loading it is not free, but the path it came
 * from is derived from the agent dir — which tests repoint per file. Dropping
 * the cache is also what makes installing the adapter take effect without a
 * server restart, so it is not a test-only concern.
 */
export function resetMcpAdapterCache(): void {
  cached = null;
  lastFailure = null;
}

/**
 * Where the adapter's config entry point lives, per its own `exports`.
 *
 * The adapter is installed by pi into the agent dir's npm root, so this is a
 * path lookup rather than a module resolution — the package is deliberately not
 * a dependency here (it is an extension the *user* installs, like any other pi
 * package). `exports["./config"]` is the public entry, so following it keeps us
 * off the package's internal layout.
 */
async function findConfigEntry(packageDir: string): Promise<string | null> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(manifest)) return null;

  const candidates: string[] = [];
  const declared = isRecord(manifest.exports) ? manifest.exports["./config"] : undefined;
  if (typeof declared === "string") {
    candidates.push(declared);
  } else if (isRecord(declared)) {
    for (const key of ["import", "default", "require", "types"]) {
      const value = declared[key];
      if (typeof value === "string") candidates.push(value);
    }
  }
  // A source checkout of the adapter has no `dist/`; tsx (which runs this
  // server) can load the TypeScript entry directly.
  candidates.push("./dist/config.js", "./config.ts");

  for (const candidate of candidates) {
    const path = resolve(packageDir, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Load the adapter's config module, or explain why it is not available.
 *
 * Failures are not cached: installing the adapter should be enough to make the
 * page work on the next refresh, without restarting this server.
 */
async function adapter(): Promise<AdapterConfigModule | null> {
  if (cached !== null) return cached;

  const packageDir = join(getAgentDir(), "npm", "node_modules", ADAPTER_PACKAGE);
  const entry = await findConfigEntry(packageDir);
  if (entry === null) {
    lastFailure = `未安装 ${ADAPTER_PACKAGE}（pi 的 MCP 支持由这个扩展提供）`;
    return null;
  }
  try {
    const module = (await import(pathToFileURL(entry).href)) as AdapterConfigModule;
    if (
      typeof module.loadMcpConfig !== "function" ||
      typeof module.getMcpDiscoverySummary !== "function" ||
      typeof module.writeProjectServerDisabledOverride !== "function"
    ) {
      lastFailure = `${ADAPTER_PACKAGE} 的 config 入口缺少预期的导出`;
      return null;
    }
    cached = module;
    return module;
  } catch (err) {
    lastFailure = `无法加载 ${ADAPTER_PACKAGE} 的 config 模块：${(err as Error).message}`;
    return null;
  }
}

// --- reading ----------------------------------------------------------------

export type McpTransport = "stdio" | "http" | "sse" | "socket" | "unknown";

export interface McpServerView {
  name: string;
  transport: McpTransport;
  /** Command line for stdio, URL for remote transports, socket path otherwise. */
  detail: string;
  /**
   * The editable fields, so the editor can prefill them without the row having
   * to round-trip through `pi`. `args` is the joined form; the server keeps the
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
  /** Declared authentication, resolved from `auth` plus the token fields. */
  auth: "oauth" | "bearer" | "none";
  /** Whether the server would connect: the adapter only honours `disabled: true`. */
  enabled: boolean;
  /** The file pi would write this server's override to. */
  sourcePath: string;
  sourceKind: "user" | "project" | "import";
  importKind: string | null;
  /**
   * True when the definition comes from another agent's config file (cursor,
   * claude-code, …). Those files are not ours to rewrite: the adapter can
   * disable such a server through the project override, and that is all this
   * page offers for them.
   */
  hostImport: boolean;
}

export interface McpView {
  available: boolean;
  unavailableReason: string | null;
  agentDir: string;
  projectPath: string | null;
  servers: McpServerView[];
  sources: AdapterSource[];
  imports: Array<{ kind: string; path: string; serverCount: number }>;
  hostConfigs: Array<{ kind: string; path: string; serverCount: number; active: boolean }>;
  /** Detected host configs that are not imported yet. */
  importable: Array<{ kind: string; path: string }>;
  /** `settings.hostConfigDiscovery`; when `on`, every detected host config loads. */
  hostConfigDiscovery: "off" | "prompt" | "on";
  conflicts: AdapterSummary["conflicts"];
  /** Every file this page may read or write, for the layout footer. */
  paths: {
    /** Where "add (global)" writes: the shared user-global config. */
    global: string;
    /** Where "add (workspace)" writes. */
    project: string;
    /** Where enable/disable writes: the workspace's Pi override. */
    projectPi: string;
    /** Pi's global override, which the adapter also rewrites on import. */
    piGlobal: string;
  };
  error: string | null;
}

function transportOf(entry: McpServerEntry): McpTransport {
  if (typeof entry.command === "string" && entry.command.length > 0) return "stdio";
  if (typeof entry.socket === "string" && entry.socket.length > 0) return "socket";
  if (typeof entry.url === "string" && entry.url.length > 0) {
    return entry.httpTransport === "sse" ? "sse" : "http";
  }
  return "unknown";
}

function detailOf(entry: McpServerEntry, transport: McpTransport): string {
  if (transport === "stdio") {
    const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === "string") : [];
    return [entry.command, ...args].join(" ");
  }
  if (transport === "socket") return String(entry.socket);
  if (typeof entry.url === "string") return entry.url;
  return "";
}

function authOf(entry: McpServerEntry): "oauth" | "bearer" | "none" {
  if (entry.auth === "bearer" || typeof entry.bearerToken === "string" || typeof entry.bearerTokenEnv === "string") {
    return "bearer";
  }
  if (entry.auth === false) return "none";
  if (entry.auth === "oauth" || isRecord(entry.oauth)) return "oauth";
  // A URL with no explicit mode is auto-detected as OAuth by the adapter.
  return typeof entry.url === "string" ? "oauth" : "none";
}

function keyNames(value: unknown): string[] {
  return isRecord(value)
    ? Object.keys(value).filter((key) => typeof key === "string")
    : [];
}

function toServerView(
  name: string,
  entry: McpServerEntry,
  provenance: AdapterProvenance | undefined,
): McpServerView {
  const transport = transportOf(entry);
  const importKind = provenance?.importKind ?? null;
  const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === "string") : [];
  return {
    name,
    transport,
    detail: detailOf(entry, transport),
    command: typeof entry.command === "string" ? entry.command : null,
    args: args.join(" "),
    cwd: typeof entry.cwd === "string" ? entry.cwd : null,
    url: typeof entry.url === "string" ? entry.url : null,
    envKeys: keyNames(entry.env),
    headerKeys: keyNames(entry.headers),
    auth: authOf(entry),
    enabled: entry.disabled !== true,
    sourcePath: provenance?.path ?? "",
    sourceKind: provenance?.kind ?? "user",
    importKind,
    hostImport: importKind !== null && !SHARED_IMPORT_KINDS.has(importKind),
  };
}

function cwdFor(projectPath: string | null): string {
  return projectPath ?? noProjectCwd();
}

/**
 * The compatibility imports Pi has been told to load.
 *
 * The adapter reports *detected* host configs separately from the ones that are
 * actually imported, and the difference lives in the `imports` array of Pi's
 * own `mcp.json`. Reading that array here would mean parsing a file the adapter
 * also reads (comments included), so the question is asked through its own
 * preview helper with an empty addition: the "after" text is that file with its
 * current imports, already normalized.
 */
function importedKinds(module: AdapterConfigModule): Set<string> {
  try {
    const parsed: unknown = JSON.parse(module.previewCompatibilityImports([]).afterText);
    const imports = isRecord(parsed) && Array.isArray(parsed.imports) ? parsed.imports : [];
    return new Set(imports.filter((kind): kind is string => typeof kind === "string"));
  } catch {
    return new Set();
  }
}

async function buildView(
  module: AdapterConfigModule,
  projectPath: string | null,
  extra: { servers?: McpServerView[] } = {},
): Promise<McpView> {
  const cwd = cwdFor(projectPath);
  const summary = module.getMcpDiscoverySummary(undefined, cwd);
  const provenance = module.getServerProvenance(undefined, cwd);

  let servers = extra.servers;
  if (servers === undefined) {
    const config = module.loadMcpConfig(undefined, cwd);
    const entries = isRecord(config?.mcpServers) ? config.mcpServers : {};
    servers = Object.entries(entries)
      .filter(([, entry]) => isRecord(entry))
      .map(([name, entry]) => toServerView(name, entry as McpServerEntry, provenance.get(name)));
  }

  const importable =
    summary.hostConfigDiscovery === "on"
      ? []
      : module
          .findAvailableImportConfigs(cwd)
          .filter((candidate) => !importedKinds(module).has(candidate.kind));

  return {
    available: true,
    unavailableReason: null,
    agentDir: getAgentDir(),
    projectPath,
    servers,
    sources: summary.sources,
    imports: summary.imports,
    hostConfigs: summary.hostConfigs,
    importable,
    hostConfigDiscovery: summary.hostConfigDiscovery,
    conflicts: summary.conflicts,
    paths: {
      global: module.getSharedConfigPath("global", cwd),
      project: module.getSharedConfigPath("project", cwd),
      projectPi: module.getProjectPiConfigPath(cwd),
      piGlobal: module.getPiGlobalConfigPath(),
    },
    error: null,
  };
}

function unavailableView(projectPath: string | null, reason: string): McpView {
  const agentDir = getAgentDir();
  return {
    available: false,
    unavailableReason: reason,
    agentDir,
    projectPath,
    servers: [],
    sources: [],
    imports: [],
    hostConfigs: [],
    importable: [],
    hostConfigDiscovery: "off",
    conflicts: [],
    paths: {
      global: join(homedir(), ".config", "mcp", "mcp.json"),
      project: projectPath === null ? "" : join(projectPath, ".mcp.json"),
      projectPi: projectPath === null ? "" : join(projectPath, ".pi", "mcp.json"),
      piGlobal: join(agentDir, "mcp.json"),
    },
    error: null,
  };
}

/** Read the MCP inventory for one workspace. Never throws; reports failure. */
export async function readMcp(projectPath: string | null): Promise<McpView> {  const module = await adapter();
  if (module === null) return unavailableView(projectPath, lastFailure ?? "MCP 支持不可用");
  try {
    return await buildView(module, projectPath);
  } catch (err) {
    const view = unavailableView(projectPath, (err as Error).message);
    return { ...view, available: true, error: (err as Error).message };
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
  transport: "stdio" | "http" | "sse";
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

/** Existing entry for a name, used to preserve fields the form does not show. */
async function storedEntry(
  module: AdapterConfigModule,
  cwd: string,
  name: string | null,
): Promise<McpServerEntry> {
  if (name === null) return {};
  try {
    const config = module.loadMcpConfig(undefined, cwd);
    const entries = isRecord(config?.mcpServers) ? config.mcpServers : {};
    const entry = entries[name];
    return isRecord(entry) ? (entry as McpServerEntry) : {};
  } catch {
    return {};
  }
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
  delete next.socket;
  delete next.httpTransport;

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
    if (draft.transport === "sse") next.httpTransport = "sse";
    const headers = mergeSecrets(draft.headers, stored.headers);
    if (headers !== undefined) next.headers = headers;
  }
  return next;
}

function requireName(value: string): string {
  const name = value.trim();
  if (name.length === 0) throw new McpConfigError("服务器名称不能为空。");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new McpConfigError("名称只能包含字母、数字、点、下划线和短横线。");
  }
  return name;
}

function validateDraft(draft: McpServerDraft): McpServerDraft {
  const name = requireName(draft.name);
  if (draft.transport === "stdio" && draft.command.trim().length === 0) {
    throw new McpConfigError("stdio 服务器需要一个命令。");
  }
  if (draft.transport !== "stdio") {
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

/** Read a JSON config file, tolerating anything unreadable as `{}`. */
async function readConfigJson(filePath: string): Promise<Record<string, unknown>> {
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
    // The adapter tolerates comments in these files; JSON.parse does not. Rather
    // than strip them (and risk rewriting the file differently), refuse and let
    // the user edit that file by hand.
    throw new McpConfigError(`${filePath} 不是标准 JSON（可能含注释）：${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new McpConfigError(`${filePath} 的顶层必须是对象。`);
  return parsed;
}

/** Temp file + rename, so a crash mid-write cannot truncate the config. */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, filePath);
}

function serversKeyOf(raw: Record<string, unknown>): string {
  if (raw.mcpServers !== undefined) return "mcpServers";
  if (raw["mcp-servers"] !== undefined) return "mcp-servers";
  return "mcpServers";
}

/**
 * Remove one server from a config file.
 *
 * The adapter has no delete helper — its own panel disables servers instead of
 * removing them — so this is the one place that rewrites a file directly. It
 * touches a single key and keeps every other field as it was read.
 */
async function removeServerFromFile(filePath: string, name: string): Promise<boolean> {
  const raw = await readConfigJson(filePath);
  const key = serversKeyOf(raw);
  const servers = raw[key];
  if (!isRecord(servers) || servers[name] === undefined) return false;
  delete servers[name];
  raw[key] = servers;
  await writeJsonAtomic(filePath, raw);
  return true;
}

function targetFileFor(
  module: AdapterConfigModule,
  input: SaveMcpServerInput,
): string {
  const cwd = cwdFor(input.projectPath);
  if (input.scope === "project") {
    if (input.projectPath === null) {
      throw new McpConfigError("要先选择一个工作区，才能把服务器加到工作区。");
    }
    return module.getSharedConfigPath("project", cwd);
  }
  return module.getSharedConfigPath("global", cwd);
}

/** Create or update one MCP server, then answer with the re-read inventory. */
export async function saveMcpServer(input: SaveMcpServerInput): Promise<McpView> {
  const module = await adapter();
  if (module === null) throw new McpConfigError(lastFailure ?? "MCP 支持不可用");

  const draft = validateDraft(input.draft);
  const cwd = cwdFor(input.projectPath);
  const filePath = targetFileFor(module, input);
  const stored = await storedEntry(module, cwd, input.originalName);
  const entry = buildEntry(stored, draft);

  // The adapter owns this write: it knows the file's `mcp-servers` alias and
  // how to keep the rest of the document intact.
  module.writeSharedServerEntry(filePath, draft.name, entry);

  // A rename has to remove the old key from the same file, or both definitions
  // would load. When the old name came from a shared file instead, it stays
  // there — this write is an override, and the origin is reported on the row.
  if (input.originalName !== null && input.originalName !== draft.name) {
    await removeServerFromFile(filePath, input.originalName);
  }

  return await buildView(module, input.projectPath);
}

export interface DeleteMcpServerInput {
  projectPath: string | null;
  name: string;
}

/**
 * Delete a server definition from the file that actually carries it.
 *
 * `sourcePath` from the adapter is the *write* target, which for a shared or
 * imported server is Pi's override file — deleting there would leave the
 * original definition loading. So the definition is located in the readable
 * layers first, highest precedence last, and removed from the topmost file that
 * has it. If a lower layer also defines it, the row comes back after this,
 * which is the truth: removing an override re-exposes what it shadowed.
 */
export async function deleteMcpServer(input: DeleteMcpServerInput): Promise<McpView> {
  const module = await adapter();
  if (module === null) throw new McpConfigError(lastFailure ?? "MCP 支持不可用");

  const cwd = cwdFor(input.projectPath);
  const provenance = module.getServerProvenance(undefined, cwd).get(input.name);
  if (provenance === undefined) {
    throw new McpConfigError(`没有找到 MCP 服务器 ${input.name}。`);
  }
  const importKind = provenance.importKind ?? null;
  if (importKind !== null && !SHARED_IMPORT_KINDS.has(importKind)) {
    throw new McpConfigError(
      `${input.name} 定义在 ${importKind} 的配置里，请在那个文件里删除；这里只能停用它。`,
    );
  }

  for (const filePath of definitionFiles(module, input.projectPath, cwd)) {
    if (await removeServerFromFile(filePath, input.name)) {
      return await buildView(module, input.projectPath);
    }
  }
  throw new McpConfigError(`没有在可写的配置文件里找到 ${input.name}。`);
}

/**
 * The readable definition files, lowest precedence first.
 *
 * Mirrors the adapter's merge order (`~/.config/mcp` → `.agents` → Pi global →
 * project `.mcp.json` → `.pi/mcp.json`). Ancestor-directory discovery is
 * deliberately left out: a file outside the selected workspace is not something
 * this page should rewrite.
 */
function definitionFiles(
  module: AdapterConfigModule,
  projectPath: string | null,
  cwd: string,
): string[] {
  const files: string[] = [
    module.getGenericGlobalConfigPath(),
    join(homedir(), ".agents", "mcp.json"),
    join(homedir(), ".agents", "mcp", "mcp.json"),
    module.getPiGlobalConfigPath(),
  ];
  if (projectPath !== null) {
    files.push(module.getProjectConfigPath(cwd), module.getProjectPiConfigPath(cwd));
  }
  return files;
}

export interface McpEnabledInput {
  projectPath: string | null;
  name: string;
  enabled: boolean;
}

/**
 * Enable or disable a server for one workspace.
 *
 * Disabling writes the project-local Pi override, which is what the adapter's
 * own `/mcp disable` does: pi has no user-level "off" for an MCP server, so the
 * state is per workspace. Enabling writes `disabled: false` only when a lower
 * layer had disabled it.
 */
export async function setMcpServerEnabled(input: McpEnabledInput): Promise<McpView> {
  const module = await adapter();
  if (module === null) throw new McpConfigError(lastFailure ?? "MCP 支持不可用");
  if (input.projectPath === null) {
    throw new McpConfigError("启用/停用会写入工作区的 .pi/mcp.json，请先选择一个工作区。");
  }
  module.writeProjectServerDisabledOverride(
    undefined,
    cwdFor(input.projectPath),
    input.name,
    !input.enabled,
  );
  return await buildView(module, input.projectPath);
}

/**
 * Install `pi-mcp-adapter` through pi's own package manager.
 *
 * This is the same operation as `pi install npm:pi-mcp-adapter`: the manager
 * installs into the agent dir's npm root and records the source in settings, so
 * the terminal and this page agree afterwards. It lives here because the
 * alternative — printing a command and sending the user out of the page — turns
 * a missing dependency into a dead end.
 *
 * Installing is not instant (npm has to resolve and download), so the caller
 * shows progress. A failure is not cached anywhere: the module loader retries on
 * every read, so a successful install takes effect on the next refresh without
 * restarting this server.
 */
export async function installMcpAdapter(projectPath: string | null): Promise<McpView> {
  const existing = await adapter();
  if (existing !== null) {
    // Already installed. Do not touch settings again just because the button
    // was pressed twice.
    return await buildView(existing, projectPath);
  }

  const agentDir = getAgentDir();
  const cwd = noProjectCwd();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  try {
    await packages.installAndPersist(ADAPTER_SOURCE);
  } catch (err) {
    throw new McpConfigError(`安装 ${ADAPTER_SOURCE} 失败：${(err as Error).message}`);
  }

  resetMcpAdapterCache();
  const module = await adapter();
  if (module === null) {
    // The install reported success but the package still cannot be loaded.
    // Saying so matters: retrying the install will not help.
    throw new McpConfigError(
      `已安装 ${ADAPTER_SOURCE}，但仍无法加载：${lastFailure ?? "未知原因"}`,
    );
  }
  return await buildView(module, projectPath);
}

/** Import servers from other agents' config files (`/mcp setup`'s job). */
export async function importMcpConfigs(projectPath: string | null, kinds: string[]): Promise<McpView> {
  const module = await adapter();
  if (module === null) throw new McpConfigError(lastFailure ?? "MCP 支持不可用");
  if (kinds.length === 0) throw new McpConfigError("没有选择要导入的配置。");
  module.ensureCompatibilityImports(kinds);
  return await buildView(module, projectPath);
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
  const module = await adapter();
  if (module === null) throw new McpConfigError(lastFailure ?? "MCP 支持不可用");

  const cwd = cwdFor(projectPath);
  const config = module.loadMcpConfig(undefined, cwd);
  const entries = isRecord(config?.mcpServers) ? config.mcpServers : {};
  const entry = entries[name];
  if (!isRecord(entry)) throw new McpConfigError(`没有找到 MCP 服务器 ${name}。`);

  return await probeMcpEntry(entry as McpServerEntry);
}

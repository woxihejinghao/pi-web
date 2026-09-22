/**
 * A stand-in for `pi-mcp-adapter/config`, which the MCP settings page loads by
 * path from the agent dir.
 *
 * Tests must not read or write the real `~/.config/mcp` or `~/.pi/agent`
 * files, and they must not depend on which version of the adapter a machine
 * happens to have installed. This stub implements the slice of the adapter's
 * exported API the server calls, over a deliberately simple three-layer file
 * model (agent `mcp.json` → `<cwd>/.mcp.json` → `<cwd>/.pi/mcp.json`, later
 * layers winning). The adapter's real merge order and import handling are its
 * own concern; what is under test here is how the server calls it and what it
 * does with the answers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CURSOR_SERVERS = {
  "from-cursor": { command: "cursor-mcp", args: ["--serve"] },
};

function agentDir() {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) throw new Error("PI_CODING_AGENT_DIR is not set");
  return dir;
}

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function getPiGlobalConfigPath() {
  return join(agentDir(), "mcp.json");
}

export function getGenericGlobalConfigPath() {
  return join(agentDir(), "mcp.json");
}

export function getProjectConfigPath(cwd = process.cwd()) {
  return join(cwd, ".mcp.json");
}

export function getProjectPiConfigPath(cwd = process.cwd()) {
  return join(cwd, ".pi", "mcp.json");
}

export function getSharedConfigPath(target, cwd = process.cwd()) {
  return target === "project" ? getProjectConfigPath(cwd) : getGenericGlobalConfigPath();
}

function layers(cwd) {
  return [
    { id: "pi-global", path: getPiGlobalConfigPath(), scope: "global" },
    { id: "shared-project", path: getProjectConfigPath(cwd), scope: "project" },
    { id: "pi-project", path: getProjectPiConfigPath(cwd), scope: "project" },
  ];
}

function importedKinds() {
  const imports = readJson(getPiGlobalConfigPath()).imports;
  return Array.isArray(imports) ? imports.filter((kind) => typeof kind === "string") : [];
}

export function loadMcpConfig(_overridePath, cwd = process.cwd()) {
  const mcpServers = {};
  for (const layer of layers(cwd)) Object.assign(mcpServers, readJson(layer.path).mcpServers ?? {});
  if (importedKinds().includes("cursor")) Object.assign(mcpServers, CURSOR_SERVERS);
  return { mcpServers };
}

export function getServerProvenance(_overridePath, cwd = process.cwd()) {
  const provenance = new Map();
  for (const layer of layers(cwd)) {
    for (const name of Object.keys(readJson(layer.path).mcpServers ?? {})) {
      provenance.set(name, { path: layer.path, kind: layer.id === "pi-global" ? "user" : "project" });
    }
  }
  if (importedKinds().includes("cursor")) {
    for (const name of Object.keys(CURSOR_SERVERS)) {
      provenance.set(name, { path: getPiGlobalConfigPath(), kind: "import", importKind: "cursor" });
    }
  }
  return provenance;
}

export function getMcpDiscoverySummary(_overridePath, cwd = process.cwd()) {
  const sources = layers(cwd).map((layer) => ({
    id: layer.id,
    label: layer.id,
    path: layer.path,
    exists: existsSync(layer.path),
    scope: layer.scope,
    kind: layer.id === "pi-global" ? "pi" : "pi",
    serverCount: Object.keys(readJson(layer.path).mcpServers ?? {}).length,
  }));
  const imports = importedKinds().includes("cursor")
    ? [{ kind: "cursor", path: join(process.env.HOME ?? "", ".cursor", "mcp.json"), serverCount: 1 }]
    : [];
  return {
    sources,
    imports,
    hostConfigs: imports.map((entry) => ({ ...entry, active: false })),
    hostConfigDiscovery: "off",
    conflicts: [],
    totalServerCount: sources.reduce((sum, source) => sum + source.serverCount, 0),
    hasAnyConfig: sources.some((source) => source.exists),
  };
}

export function findAvailableImportConfigs() {
  return [{ kind: "cursor", path: join(process.env.HOME ?? "", ".cursor", "mcp.json") }];
}

export function previewCompatibilityImports(kinds = []) {
  const raw = readJson(getPiGlobalConfigPath());
  const current = importedKinds();
  const merged = [...new Set([...current, ...kinds])];
  return { afterText: `${JSON.stringify({ ...raw, imports: merged }, null, 2)}\n` };
}

export function ensureCompatibilityImports(kinds = []) {
  const path = getPiGlobalConfigPath();
  const raw = readJson(path);
  const current = importedKinds();
  const merged = [...new Set([...current, ...kinds])];
  const added = merged.filter((kind) => !current.includes(kind));
  if (added.length > 0) writeJson(path, { ...raw, imports: merged });
  return { path, added };
}

export function writeSharedServerEntry(filePath, serverName, entry) {
  const raw = readJson(filePath);
  raw.mcpServers = { ...(raw.mcpServers ?? {}), [serverName]: entry };
  writeJson(filePath, raw);
  return filePath;
}

export function writeProjectServerDisabledOverride(_overridePath, cwd, serverName, disabled) {
  const path = getProjectPiConfigPath(cwd);
  const raw = readJson(path);
  const servers = { ...(raw.mcpServers ?? {}) };
  const existing = { ...(servers[serverName] ?? {}) };
  if (disabled) existing.disabled = true;
  else delete existing.disabled;
  servers[serverName] = existing;
  raw.mcpServers = servers;
  writeJson(path, raw);
  return { path, changed: true };
}

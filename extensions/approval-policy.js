// Shared by the HTTP server and the web-only extension. No provider dependencies.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MODES = ["ask", "smart", "off"];
/**
 * The policy, as one document shared by the server and every gate process.
 *
 * `mode` is the **default**: the mode a session starts on, and the one the
 * settings page edits. `sessions` holds the per-session overrides the composer
 * writes; a session without an entry follows `mode`, and the entries are keyed
 * by session file so the gate can look one up without asking the server.
 */
export const DEFAULT_APPROVAL = { mode: "ask", classifierModel: null, language: "en", timeoutSeconds: 120, sessions: {} };

/** Overrides are small and expire; this keeps a runaway file from being one. */
const MAX_SESSIONS = 200;
/** A session that has not been touched in a month is not coming back. */
export const SESSION_OVERRIDE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Long enough for any session path, short enough not to hold a whole file. */
const MAX_SESSION_KEY = 1024;

export function approvalPath() {
  if (!process.env.PI_WEB_APPROVAL_CONFIG) throw new Error("Web approval configuration path is missing");
  return process.env.PI_WEB_APPROVAL_CONFIG;
}

export function validateApproval(value) {
  if (!value || typeof value !== "object" || !MODES.includes(value.mode)
      || !["en", "zh-CN"].includes(value.language)
      || !(value.classifierModel === null || (typeof value.classifierModel === "string" && value.classifierModel.length > 0))
      || !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 10 || value.timeoutSeconds > 600) {
    throw new Error("Invalid web approval configuration; tool execution is blocked");
  }
  return {
    mode: value.mode,
    classifierModel: value.classifierModel,
    language: value.language,
    timeoutSeconds: value.timeoutSeconds,
    sessions: validateSessions(value.sessions),
  };
}

/**
 * The per-session overrides.
 *
 * Absent is the normal case for an older file, so it validates as empty. A bad
 * entry is an error and not something to skip: overrides grant or withhold
 * permission, so a file this process cannot read whole must not be half-honored.
 * The map has no prototype, because the keys are file paths and one of them
 * could spell `__proto__`.
 */
function validateSessions(value) {
  const sessions = Object.create(null);
  if (value === undefined) return sessions;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid web approval sessions; tool execution is blocked");
  const entries = Object.entries(value);
  if (entries.length > MAX_SESSIONS) throw new Error("Too many web approval session overrides; tool execution is blocked");
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > MAX_SESSION_KEY
        || !entry || typeof entry !== "object" || !MODES.includes(entry.mode)
        || !(entry.updatedAt === undefined || entry.updatedAt === null || typeof entry.updatedAt === "string")) {
      throw new Error("Invalid web approval session override; tool execution is blocked");
    }
    sessions[key] = { mode: entry.mode, updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null };
  }
  return sessions;
}

/**
 * The mode in force for one session: its own override, else the default.
 *
 * A session with no key (a terminal run, or one whose file pi has not revealed
 * yet) has no override by definition and follows the default.
 */
export function effectiveMode(config, sessionKey) {
  const entry = typeof sessionKey === "string" && sessionKey.length > 0 ? config.sessions?.[sessionKey] : undefined;
  return entry && MODES.includes(entry.mode) ? entry.mode : config.mode;
}

/** One override written, cleared, or left alone; `mode: null` clears it. */
export function withSessionMode(config, sessionKey, mode, now = new Date()) {
  if (typeof sessionKey !== "string" || sessionKey.length === 0 || sessionKey.length > MAX_SESSION_KEY) {
    throw new Error("Invalid session key for an approval override");
  }
  const sessions = { ...config.sessions };
  if (mode === null) delete sessions[sessionKey];
  else {
    if (!MODES.includes(mode)) throw new Error("Unknown approval mode");
    sessions[sessionKey] = { mode, updatedAt: now.toISOString() };
  }
  return { ...config, sessions };
}

/**
 * Drop overrides nobody has touched in a month, and the oldest beyond the cap.
 *
 * Sessions end without telling this file they did: a deleted or moved session
 * would otherwise leave its mode behind forever, and nothing would ever read it
 * again.
 */
export function pruneSessions(config, now = new Date(), maxAgeMs = SESSION_OVERRIDE_MAX_AGE_MS) {
  // An entry without a usable timestamp (this code always writes one; an older
  // or hand-edited file may not) is treated as the freshest thing there is: it
  // cannot be proved stale, and dropping it would silently change a session's
  // mode.
  const touchedAt = (entry) => {
    const parsed = entry.updatedAt === null ? Number.NaN : Date.parse(entry.updatedAt);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  const kept = Object.entries(config.sessions ?? {})
    .filter(([, entry]) => now.getTime() - touchedAt(entry) < maxAgeMs)
    .sort(([, left], [, right]) => touchedAt(right) - touchedAt(left))
    .slice(0, MAX_SESSIONS);
  return { ...config, sessions: Object.fromEntries(kept) };
}

export function readApproval(path = approvalPath()) {
  return validateApproval(JSON.parse(readFileSync(path, "utf8")));
}

export function saveApproval(value, path = approvalPath(), exclusive = false) {
  const config = validateApproval(value);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(config, null, 2) + "\n";
  if (exclusive) writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  else {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  }
  return config;
}

// Only fixed, known tools bypass review. MCP annotations and tool names that
// merely contain "read" are not evidence that a call cannot mutate state.
const SAFE_TOOLS = new Set(["read", "grep", "find", "ls", "todo", "ask_user_question", "exit_plan_mode"]);
export function needsApproval(toolName) { return !SAFE_TOOLS.has(toolName); }

// Smart review never authorizes a shell, an opaque script, an MCP proxy, or
// another unknown tool. Those always need a person, including nested calls.
export function canUseSmartReview(toolName, input, cwd) {
  if (toolName !== "write" && toolName !== "edit") return false;
  if (JSON.stringify(input).length > 32_000) return false;
  const path = typeof input?.path === "string" ? input.path : "";
  if (!path || path.startsWith("/") || path.includes("..") || path.startsWith("~") || !/\.(?:txt|md|rst)$/i.test(path)) return false;
  // Configurations, executable files and hidden paths are never AI-approved.
  if (path.split(/[\\/]/).some(part => part.startsWith("."))
      || /(?:^|[\\/])(?:AGENTS(?:\.override)?\.md|CLAUDE\.md|package(?:-lock)?\.json|pnpm-lock\.yaml|Makefile|Dockerfile)$/i.test(path)
      || /\.(?:[cm]?[jt]sx?|sh|bash|zsh|py|rb|php|go|rs|c|cpp|h|ps1|exe|app|plist|jsonc?|ya?ml|toml|ini|cfg|env)$/i.test(path)) return false;
  // Boundary check is deliberately performed by the extension using realpath,
  // not by a lexical prefix check here.
  return typeof cwd === "string" && cwd.length > 0;
}

export async function decideApproval({ toolName, input, cwd, config, confirm, classify, isInternal = () => false }) {
  if (config.mode === "off" || !needsApproval(toolName)) return { allowed: true, route: config.mode === "off" ? "off" : "readonly" };
  if (config.mode === "smart" && canUseSmartReview(toolName, input, cwd) && isInternal(input.path)) {
    try {
      const decision = await classify();
      if (decision?.outcome === "allow" && decision.risk === "low") return { allowed: true, route: "smart" };
    } catch { /* Model failure is not permission: fall back to the human. */ }
  }
  try {
    return { allowed: (await confirm()) === true, route: "human" };
  } catch { return { allowed: false, route: "unavailable" }; }
}

export function auditApproval({ toolName, input, mode, allowed, route }, path = approvalPath()) {
  // Do not persist prompts, credentials, file contents, or raw shell arguments.
  const actionHash = createHash("sha256").update(JSON.stringify({ toolName, input })).digest("hex");
  appendFileSync(join(dirname(path), "approval-audit.jsonl"), JSON.stringify({
    timestamp: new Date().toISOString(), toolName, actionHash, mode, allowed, route,
  }) + "\n", { mode: 0o600 });
}

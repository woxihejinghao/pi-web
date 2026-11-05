// Shared by the HTTP server and the web-only extension. No provider dependencies.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MODES = ["ask", "smart", "off"];
export const DEFAULT_APPROVAL = { mode: "ask", classifierModel: null, language: "en", timeoutSeconds: 120 };

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
  return { mode: value.mode, classifierModel: value.classifierModel, language: value.language, timeoutSeconds: value.timeoutSeconds };
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

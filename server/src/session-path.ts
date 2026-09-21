import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve, sep } from "node:path";
import { badRequest, forbidden } from "./errors.ts";

/**
 * The only directory whose JSONL files the API will touch. pi reaches it via
 * `getAgentDir()`; tests override it with `PI_WEB_SIMPLE_SESSION_DIR`.
 */
export function getSessionRoot(): string {
  return process.env.PI_WEB_SIMPLE_SESSION_DIR
    ? resolve(process.env.PI_WEB_SIMPLE_SESSION_DIR)
    : resolve(getAgentDir(), "sessions");
}

/**
 * The per-project session directory inside a sessions root.
 *
 * Mirrors pi's private `getDefaultSessionDirPath`: it is not exported, so the
 * encoding (`--` + cwd with separators replaced by `-` + `--`) is repeated
 * here. `SessionManager.list(cwd, dir)` expects this directory, not the root.
 */
export function sessionDirFor(cwd: string, root = getSessionRoot()): string {
  const resolved = resolve(cwd);
  const safe = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(root, safe);
}

/**
 * Reject any session path outside pi's own storage. Without this, a page able
 * to reach the localhost server could ask it to open an arbitrary file as a
 * session (and pi would happily write to it).
 */
export function assertAllowedSessionPath(input: string, root = getSessionRoot()): string {
  if (typeof input !== "string" || input.length === 0) {
    throw badRequest("sessionPath is required");
  }
  const path = resolve(input);
  if (!path.endsWith(".jsonl")) {
    throw badRequest(`not a session file: ${path}`);
  }
  if (path !== root && !path.startsWith(root + sep)) {
    throw forbidden(`session path is outside ${root}`);
  }
  return path;
}

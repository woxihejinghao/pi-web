import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PACKAGE_ROOT } from "./config.ts";
import { DEFAULT_APPROVAL, MODES, pruneSessions, readApproval, saveApproval, withSessionMode, type ApprovalConfig, type ApprovalMode } from "../../extensions/approval-policy.js";

export const APPROVAL_EXTENSION = join(PACKAGE_ROOT, "extensions", "approval-gate.ts");
export const APPROVAL_CONFIG = join(DATA_DIR, "approval.json");

/** Always this deployment's own config; inherited variables cannot select an
 * old pi-web-home policy or affect an unrelated terminal session. */
export function initializeApprovals(): void {
  process.env.PI_WEB_APPROVAL_CONFIG = APPROVAL_CONFIG;
  if (!existsSync(APPROVAL_CONFIG)) {
    try { saveApproval(DEFAULT_APPROVAL, APPROVAL_CONFIG, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  if (!existsSync(APPROVAL_EXTENSION)) throw new Error("Required web approval extension is missing; refusing to start agents");
}

export function approvalView(): { available: boolean; config: ApprovalConfig | null; error?: string } {
  try {
    if (!existsSync(APPROVAL_EXTENSION)) throw new Error("Approval extension is missing");
    return { available: true, config: readApproval(APPROVAL_CONFIG) };
  } catch {
    return { available: false, config: null, error: "Approval configuration is unavailable; tool execution is blocked." };
  }
}

function isMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export function updateApproval(patch: Record<string, unknown>): ReturnType<typeof approvalView> {
  // `sessions` is deliberately not a settable field: an override names one
  // session and goes through `setSessionApproval`, which keeps the file's
  // timestamping and pruning in one place instead of letting a caller write raw
  // entries.
  if (Object.keys(patch).some(key => !["mode", "classifierModel", "language", "timeoutSeconds", "confirmOff"].includes(key))) {
    throw new Error("Unknown approval setting");
  }
  if (patch.mode === "off" && patch.confirmOff !== true) throw new Error("Disabling approval requires explicit confirmation");
  const current = approvalView().config;
  // A broken policy can only be recovered by an explicit full mode selection,
  // never by a background language synchronization request.
  if (current === null && !isMode(patch.mode)) throw new Error("Select an approval mode to repair the configuration");
  const { confirmOff: _, ...fields } = patch;
  saveApproval({ ...(current ?? DEFAULT_APPROVAL), ...fields } as ApprovalConfig, APPROVAL_CONFIG);
  return approvalView();
}

/**
 * One session's mode, written by the composer.
 *
 * `null` removes the override, which puts the session back on the default — the
 * "follow default" row in the composer's menu. This is the only writer of the
 * `sessions` map, so the pruning that keeps it from growing forever happens
 * here rather than on every read.
 */
export function setSessionApproval(sessionKey: string, mode: unknown): ReturnType<typeof approvalView> {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) throw new Error("Missing session key");
  if (mode !== null && !isMode(mode)) throw new Error("Unknown approval mode");
  const current = approvalView().config;
  // An unreadable policy is not repaired by a per-session write: the default it
  // would be relative to is exactly what cannot be read.
  if (current === null) throw new Error("Select an approval mode to repair the configuration");
  saveApproval(pruneSessions(withSessionMode(current, sessionKey, mode)), APPROVAL_CONFIG);
  return approvalView();
}

/** A deleted session must not leave its override behind. */
export function forgetSessionApproval(sessionKey: string): void {
  const current = approvalView().config;
  if (current === null || current.sessions[sessionKey] === undefined) return;
  saveApproval(withSessionMode(current, sessionKey, null), APPROVAL_CONFIG);
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PACKAGE_ROOT } from "./config.ts";
import { DEFAULT_APPROVAL, readApproval, saveApproval, type ApprovalConfig } from "../../extensions/approval-policy.js";

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

export function updateApproval(patch: Record<string, unknown>): ReturnType<typeof approvalView> {
  if (Object.keys(patch).some(key => !["mode", "classifierModel", "language", "timeoutSeconds", "confirmOff"].includes(key))) {
    throw new Error("Unknown approval setting");
  }
  if (patch.mode === "off" && patch.confirmOff !== true) throw new Error("Disabling approval requires explicit confirmation");
  const current = approvalView().config;
  // A broken policy can only be recovered by an explicit full mode selection,
  // never by a background language synchronization request.
  if (current === null && !["ask", "smart", "off"].includes(String(patch.mode))) throw new Error("Select an approval mode to repair the configuration");
  const { confirmOff: _, ...fields } = patch;
  saveApproval({ ...(current ?? DEFAULT_APPROVAL), ...fields } as ApprovalConfig, APPROVAL_CONFIG);
  return approvalView();
}

import { api } from "../../lib/api.ts";
import { createStore } from "../../lib/store.ts";

export type ApprovalMode = "ask" | "smart" | "off";
/** One session's own mode, written by the composer, and when it was last set. */
export interface ApprovalSession { mode: ApprovalMode; updatedAt: string | null }
export interface ApprovalConfig {
  /** The default: the mode a session starts on, edited from Settings. */
  mode: ApprovalMode;
  classifierModel: string | null;
  language: "en" | "zh-CN";
  timeoutSeconds: number;
  /** Overrides by session file. Missing is the same as empty. */
  sessions?: Record<string, ApprovalSession>;
}
export interface ApprovalView { available: boolean; config: ApprovalConfig | null; error?: string }
export const approvalStore = createStore<{ view: ApprovalView | null; pending: boolean; error: string | null }>({ view: null, pending: false, error: null });
let sequence = 0;

/**
 * The mode in force for one session.
 *
 * The same rule the gate applies when it reviews a call: a session with its own
 * entry uses it, everyone else follows the default. A session with no path yet
 * (a draft) has no override to read, so it shows the default it will start on.
 */
export function effectiveApprovalMode(config: ApprovalConfig | null, sessionKey: string | null): ApprovalMode | null {
  if (config === null) return null;
  const override = sessionKey === null ? undefined : config.sessions?.[sessionKey];
  return override?.mode ?? config.mode;
}

export async function refreshApprovals(): Promise<void> {
  const seq = ++sequence;
  try {
    const view = await api.getApproval();
    if (seq === sequence) approvalStore.update(state => ({ ...state, view, error: view.available ? null : view.error ?? "Approval unavailable" }));
  } catch (error) {
    if (seq === sequence) approvalStore.update(state => ({ ...state, view: null, error: (error as Error).message }));
  }
}

export async function changeApproval(patch: Partial<ApprovalConfig> & { confirmOff?: boolean }): Promise<void> {
  if (approvalStore.get().pending) return;
  ++sequence;
  approvalStore.update(state => ({ ...state, pending: true, error: null }));
  try {
    const view = await api.updateApproval(patch);
    approvalStore.set({ view, pending: false, error: view.available ? null : view.error ?? "Approval unavailable" });
  } catch (error) {
    approvalStore.update(state => ({ ...state, pending: false, error: (error as Error).message }));
  }
}

/** One session's mode; `null` clears the override and follows the default. */
export async function changeSessionApproval(sessionKey: string, mode: ApprovalMode | null): Promise<void> {
  if (approvalStore.get().pending) return;
  ++sequence;
  approvalStore.update(state => ({ ...state, pending: true, error: null }));
  try {
    const view = await api.updateSessionApproval(sessionKey, mode);
    approvalStore.set({ view, pending: false, error: view.available ? null : view.error ?? "Approval unavailable" });
  } catch (error) {
    approvalStore.update(state => ({ ...state, pending: false, error: (error as Error).message }));
  }
}

import { api } from "../../lib/api.ts";
import { createStore } from "../../lib/store.ts";

export type ApprovalMode = "ask" | "smart" | "off";
export interface ApprovalConfig { mode: ApprovalMode; classifierModel: string | null; language: "en" | "zh-CN"; timeoutSeconds: number }
export interface ApprovalView { available: boolean; config: ApprovalConfig | null; error?: string }
export const approvalStore = createStore<{ view: ApprovalView | null; pending: boolean; error: string | null }>({ view: null, pending: false, error: null });
let sequence = 0;

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

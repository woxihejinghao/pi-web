export type ApprovalMode = "ask" | "smart" | "off";
export interface ApprovalConfig { mode: ApprovalMode; classifierModel: string | null; language: "en" | "zh-CN"; timeoutSeconds: number }
export interface ApprovalDecision { allowed: boolean; route: string }
export const MODES: readonly ApprovalMode[];
export const DEFAULT_APPROVAL: ApprovalConfig;
export function approvalPath(): string;
export function validateApproval(value: unknown): ApprovalConfig;
export function readApproval(path?: string): ApprovalConfig;
export function saveApproval(value: ApprovalConfig, path?: string, exclusive?: boolean): ApprovalConfig;
export function needsApproval(toolName: string): boolean;
export function canUseSmartReview(toolName: string, input: unknown, cwd: string): boolean;
export function decideApproval(input: {
  toolName: string; input: unknown; cwd: string; config: ApprovalConfig;
  confirm: () => Promise<boolean>;
  classify: () => Promise<{ outcome: string; risk: string }>;
  isInternal?: (path: string) => boolean;
}): Promise<ApprovalDecision>;
export function auditApproval(input: { toolName: string; input: unknown; mode: ApprovalMode; allowed: boolean; route: string }, path?: string): void;

export type ApprovalMode = "ask" | "smart" | "off";
/** One session's override: the mode it runs on, and when it was last written. */
export interface ApprovalSessionOverride { mode: ApprovalMode; updatedAt: string | null }
export interface ApprovalConfig {
  /** The default: the mode a session starts on, edited from Settings. */
  mode: ApprovalMode;
  classifierModel: string | null;
  language: "en" | "zh-CN";
  timeoutSeconds: number;
  /** Overrides keyed by session file; a session without one follows `mode`. */
  sessions: Record<string, ApprovalSessionOverride>;
}
export interface ApprovalDecision { allowed: boolean; route: string }
export const MODES: readonly ApprovalMode[];
export const DEFAULT_APPROVAL: ApprovalConfig;
export const SESSION_OVERRIDE_MAX_AGE_MS: number;
export function approvalPath(): string;
export function validateApproval(value: unknown): ApprovalConfig;
export function readApproval(path?: string): ApprovalConfig;
export function saveApproval(value: ApprovalConfig, path?: string, exclusive?: boolean): ApprovalConfig;
/** The mode in force for one session: its override, else the default. */
export function effectiveMode(config: ApprovalConfig, sessionKey: null | string): ApprovalMode;
/** One override written or cleared (`mode: null`); the rest of the policy is kept. */
export function withSessionMode(config: ApprovalConfig, sessionKey: string, mode: ApprovalMode | null, now?: Date): ApprovalConfig;
/** Drop overrides untouched for `maxAgeMs`, and the oldest beyond the cap. */
export function pruneSessions(config: ApprovalConfig, now?: Date, maxAgeMs?: number): ApprovalConfig;
export function needsApproval(toolName: string): boolean;
export function canUseSmartReview(toolName: string, input: unknown, cwd: string): boolean;
export function decideApproval(input: {
  toolName: string; input: unknown; cwd: string; config: ApprovalConfig;
  confirm: () => Promise<boolean>;
  classify: () => Promise<{ outcome: string; risk: string }>;
  isInternal?: (path: string) => boolean;
}): Promise<ApprovalDecision>;
export function auditApproval(input: { toolName: string; input: unknown; mode: ApprovalMode; allowed: boolean; route: string }, path?: string): void;

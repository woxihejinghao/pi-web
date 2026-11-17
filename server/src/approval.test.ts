import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPROVAL, auditApproval, canUseSmartReview, decideApproval, effectiveMode, needsApproval, pruneSessions, readApproval, saveApproval, validateApproval } from "../../extensions/approval-policy.js";
import { APPROVAL_CONFIG, approvalView, forgetSessionApproval, initializeApprovals, setSessionApproval, updateApproval } from "./approval.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function policy(overrides: Record<string, unknown> = {}) {
  const confirm = vi.fn(async () => false);
  const classify = vi.fn(async () => ({ outcome: "allow", risk: "low" }));
  return { toolName: "write", input: { path: "notes.md", content: "hello" }, cwd: "/workspace", config: { ...DEFAULT_APPROVAL }, confirm, classify, isInternal: () => true, ...overrides };
}

describe("approval policy", () => {
  it("defaults to Ask, never Off", () => expect(DEFAULT_APPROVAL.mode).toBe("ask"));
  it.each(["read", "grep", "find", "ls", "todo", "ask_user_question", "exit_plan_mode"])("allows known harmless tool %s", async toolName => {
    const input = policy({ toolName });
    expect((await decideApproval(input)).allowed).toBe(true);
    expect(input.confirm).not.toHaveBeenCalled();
    expect(input.classify).not.toHaveBeenCalled();
  });
  it.each(["bash", "powershell", "mcp", "mcpScript", "codemode", "mcp__apple_mail_rw", "mcp__send_email", "write", "edit", "unknown_read_tool"])("requires a human for %s in Ask", async toolName => {
    const input = policy({ toolName });
    expect(needsApproval(toolName)).toBe(true);
    expect((await decideApproval(input)).allowed).toBe(false);
    expect(input.confirm).toHaveBeenCalledOnce();
    expect(input.classify).not.toHaveBeenCalled();
  });
  it("only an explicit true allows a call", async () => {
    for (const value of [false, undefined, null, "yes", 1]) {
      expect((await decideApproval(policy({ confirm: async () => value }))).allowed).toBe(false);
    }
    expect((await decideApproval(policy({ confirm: async () => true }))).allowed).toBe(true);
  });
  it("denies if the UI is unavailable or times out", async () => {
    expect((await decideApproval(policy({ confirm: async () => { throw new Error("disconnected"); } }))).allowed).toBe(false);
  });
  it.each(["bash", "powershell", "codemode", "mcp", "mcpScript", "mcp__workspace_drive", "other"])("never auto-approves opaque %s in Smart", async toolName => {
    const input = policy({ toolName, config: { ...DEFAULT_APPROVAL, mode: "smart" } });
    expect((await decideApproval(input)).allowed).toBe(false);
    expect(input.classify).not.toHaveBeenCalled();
  });
  it("Smart allows only explicit low-risk document edits", async () => {
    const input = policy({ config: { ...DEFAULT_APPROVAL, mode: "smart" } });
    expect((await decideApproval(input)).route).toBe("smart");
    expect(input.confirm).not.toHaveBeenCalled();
  });
  it.each([".pi/settings.json", "AGENTS.md", "CLAUDE.md", "script", "code.ts", "../notes.md", "/tmp/notes.md", "README.md/../notes.md"])("never asks AI to approve sensitive path %s", path => {
    expect(canUseSmartReview("write", { path }, "/workspace")).toBe(false);
  });
  it("requires a real-path boundary check, not a lexical prefix", async () => {
    const input = policy({ config: { ...DEFAULT_APPROVAL, mode: "smart" }, isInternal: () => false });
    expect((await decideApproval(input)).allowed).toBe(false);
    expect(input.classify).not.toHaveBeenCalled();
  });
  it("falls back to Ask for model denial, invalid output or failure", async () => {
    for (const classify of [async () => ({ outcome: "deny", risk: "low" }), async () => ({ outcome: "allow", risk: "high" }), async () => { throw new Error("model timeout"); }]) {
      const input = policy({ config: { ...DEFAULT_APPROVAL, mode: "smart" }, classify });
      expect((await decideApproval(input)).allowed).toBe(false);
      expect(input.confirm).toHaveBeenCalledOnce();
    }
  });
  it("permits Off only when explicitly configured", async () => {
    const input = policy({ config: { ...DEFAULT_APPROVAL, mode: "off" } });
    expect((await decideApproval(input)).route).toBe("off");
  });
  it.each([null, {}, { ...DEFAULT_APPROVAL, mode: "garbage" }, { ...DEFAULT_APPROVAL, timeoutSeconds: 0 }])("rejects malformed config %j", value => {
    expect(() => validateApproval(value)).toThrow();
  });
  it("fails closed on missing or broken config and never overwrites exclusive config", () => {
    const root = mkdtempSync(join(tmpdir(), "piws-approval-")); roots.push(root);
    const path = join(root, "approval.json");
    expect(() => readApproval(path)).toThrow();
    writeFileSync(path, "broken");
    expect(() => readApproval(path)).toThrow();
    expect(() => saveApproval(DEFAULT_APPROVAL, path, true)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("broken");
    saveApproval(DEFAULT_APPROVAL, path);
    expect(readApproval(path).mode).toBe("ask");
    auditApproval({ toolName: "bash", input: { command: "SECRET_TOKEN=do-not-log" }, mode: "ask", allowed: false, route: "human" }, path);
    const log = readFileSync(join(root, "approval-audit.jsonl"), "utf8");
    expect(log).not.toContain("SECRET_TOKEN");
    expect(JSON.parse(log).allowed).toBe(false);
  });
});

describe("approval settings", () => {
  it("initializes safely and refuses silent Off or language-only recovery", () => {
    initializeApprovals();
    expect(approvalView().config?.mode).toBe("ask");
    expect(() => updateApproval({ mode: "off" })).toThrow(/confirmation/);
    expect(updateApproval({ mode: "off", confirmOff: true }).config?.mode).toBe("off");
    writeFileSync(APPROVAL_CONFIG, "broken");
    expect(approvalView().available).toBe(false);
    expect(() => updateApproval({ language: "en" })).toThrow();
    expect(updateApproval({ mode: "ask" }).config?.mode).toBe("ask");
    expect(() => updateApproval({ something: true })).toThrow();
    expect(() => updateApproval({ sessions: {} })).toThrow();
  });
});

/**
 * The two scopes: `mode` is the default a session starts on, `sessions` is what
 * the composer wrote for one session. The gate reads the second before the
 * first, so these pin the rule it applies.
 */
describe("session overrides", () => {
  it("writes one session's mode without touching the default", () => {
    initializeApprovals();
    updateApproval({ mode: "ask" });
    setSessionApproval("/sessions/one.jsonl", "smart");
    const config = approvalView().config!;
    expect(config.mode).toBe("ask");
    expect(effectiveMode(config, "/sessions/one.jsonl")).toBe("smart");
    expect(effectiveMode(config, "/sessions/two.jsonl")).toBe("ask");
    expect(effectiveMode(config, null)).toBe("ask");
  });

  it("clears an override back to the default, and rejects unknown keys or modes", () => {
    setSessionApproval("/sessions/one.jsonl", "off");
    setSessionApproval("/sessions/one.jsonl", null);
    expect(effectiveMode(approvalView().config!, "/sessions/one.jsonl")).toBe("ask");
    expect(() => setSessionApproval("", "ask")).toThrow(/session key/);
    expect(() => setSessionApproval("/sessions/one.jsonl", "garbage")).toThrow(/mode/);
    expect(() => setSessionApproval("/sessions/one.jsonl", 1)).toThrow(/mode/);
  });

  it("drops a deleted session's override", () => {
    setSessionApproval("/sessions/one.jsonl", "smart");
    forgetSessionApproval("/sessions/one.jsonl");
    expect(approvalView().config?.sessions["/sessions/one.jsonl"]).toBeUndefined();
  });

  it("refuses an override while the policy cannot be read", () => {
    initializeApprovals();
    writeFileSync(APPROVAL_CONFIG, "broken");
    expect(() => setSessionApproval("/sessions/one.jsonl", "smart")).toThrow(/repair/);
    expect(() => forgetSessionApproval("/sessions/one.jsonl")).not.toThrow();
  });

  it("prunes stale overrides and keeps the rest", () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const config = {
      ...DEFAULT_APPROVAL,
      sessions: {
        stale: { mode: "off" as const, updatedAt: "2025-01-01T00:00:00.000Z" },
        fresh: { mode: "smart" as const, updatedAt: "2026-01-31T00:00:00.000Z" },
        timeless: { mode: "ask" as const, updatedAt: null },
      },
    };
    expect(Object.keys(pruneSessions(config, now).sessions).sort()).toEqual(["fresh", "timeless"]);
  });

  it("rejects a malformed sessions map but accepts one that predates overrides", () => {
    expect(() => validateApproval({ ...DEFAULT_APPROVAL, sessions: [] })).toThrow();
    expect(() => validateApproval({ ...DEFAULT_APPROVAL, sessions: { a: { mode: "garbage" } } })).toThrow();
    expect(() => validateApproval({ ...DEFAULT_APPROVAL, sessions: { "": { mode: "ask" } } })).toThrow();
    expect(validateApproval({ ...DEFAULT_APPROVAL, sessions: undefined }).sessions).toEqual({});
  });
});

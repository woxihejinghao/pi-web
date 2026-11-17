import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore, resetAppState } from "../../lib/app-state.ts";
import { ApprovalControl } from "./ApprovalControl.tsx";
import { approvalStore, effectiveApprovalMode, type ApprovalConfig, type ApprovalView } from "./approval-store.ts";

// The copy asserted below is the Chinese one, and a bare node environment
// offers no navigator to prefer it.
vi.stubGlobal("navigator", { language: "zh-CN" });

const POLICY: ApprovalConfig = {
  mode: "ask",
  classifierModel: null,
  language: "zh-CN",
  timeoutSeconds: 120,
  sessions: {},
};

function setView(view: ApprovalView | null): void {
  approvalStore.set({ view, pending: false, error: view === null || view.available ? null : "broken" });
}

/** Open one real session, so the control edits that session rather than the default. */
function selectSession(path: string | null): void {
  appStore.update(state => ({ ...state, selectedSessionPath: path }));
}

function render(settings = false): string {
  return renderToStaticMarkup(<ApprovalControl settings={settings} />);
}

beforeEach(() => {
  resetAppState();
  setView({ available: true, config: POLICY });
});

afterEach(() => {
  resetAppState();
  approvalStore.set({ view: null, pending: false, error: null });
});

/**
 * The control's first paint.
 *
 * Which mode is in force, what the chip calls itself, and whether the row admits
 * that no confirmation will come — all decided before any pointer exists, so a
 * static render can speak for it. The menu itself is interaction; the popovers
 * over the composer have no component tests either.
 */
describe("ApprovalControl", () => {
  it("names the mode in effect on the composer chip", () => {
    const markup = render();
    expect(markup).toContain("逐次确认");
    // The label the screen reader hears still says what is being controlled —
    // the chip itself only has room for the mode.
    expect(markup).toContain('aria-label="审批：逐次确认"');
    // The explanation is the trigger's title, dsh's slot for the same copy.
    expect(markup).toContain("每次可能修改数据的操作都先询问");
    // The glyph is dsh's own read-only permission mark, not an approximation.
    expect(markup).toContain('data-glyph="permissionReadOnly"');
    expect(markup).not.toContain('aria-expanded="true"');
  });

  it("shows the session's own override instead of the default", () => {
    selectSession("/sessions/one.jsonl");
    setView({
      available: true,
      config: { ...POLICY, sessions: { "/sessions/one.jsonl": { mode: "smart", updatedAt: "2026-01-01T00:00:00.000Z" } } },
    });
    expect(render()).toContain('aria-label="审批：智能审批"');
    expect(render()).toContain('data-glyph="permissionWorkspaceWrite"');
  });

  it("ignores the override of a session that is not selected", () => {
    selectSession("/sessions/two.jsonl");
    setView({
      available: true,
      config: { ...POLICY, sessions: { "/sessions/one.jsonl": { mode: "smart", updatedAt: null } } },
    });
    expect(render()).toContain('aria-label="审批：逐次确认"');
  });

  it("shows the default for a draft, which has no file to override", () => {
    selectSession("draft:abc123");
    setView({
      available: true,
      config: { ...POLICY, mode: "smart", sessions: { "draft:abc123": { mode: "off", updatedAt: null } } },
    });
    expect(render()).toContain('aria-label="审批：智能审批"');
    expect(render()).toContain('data-glyph="permissionWorkspaceWrite"');
  });

  it("marks review left off in the composer row, without the warning ink", () => {
    setView({ available: true, config: { ...POLICY, mode: "off" } });
    const markup = render();
    expect(markup).toContain("完全权限");
    expect(markup).toContain("data-off");
    expect(markup).toContain('data-glyph="permissionFullAccess"');
    // The chip alone carries the state: Full access adds no sentence to the
    // composer, and no warning ink anywhere near the input.
    expect(markup).not.toContain("完全权限：不再确认");
    expect(markup).not.toMatch(/role="status"/);
  });

  it("falls back to the unavailable label when the policy cannot be read", () => {
    setView({ available: false, config: null, error: "broken" });
    const markup = render();
    expect(markup).toContain("审批不可用");
    expect(markup).toContain('role="alert"');
  });

  it("edits the default, not a session, on the settings page", () => {
    selectSession("/sessions/one.jsonl");
    setView({
      available: true,
      config: { ...POLICY, sessions: { "/sessions/one.jsonl": { mode: "off", updatedAt: null } } },
    });
    const markup = render(true);
    expect(markup).toContain("默认审批权限");
    expect(markup).toContain("以下是所有新会话的默认权限");
    expect(markup).toContain("审查模型");
    expect(markup).toContain("确认等待时间");
    // The composer's chip does not appear where the setting row does: Settings
    // writes the default, and a per-session caveat here would be a second scope.
    expect(markup).not.toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-label="默认审批权限"');
  });
});

describe("effectiveApprovalMode", () => {
  const config: ApprovalConfig = {
    ...POLICY,
    mode: "ask",
    sessions: { "/sessions/one.jsonl": { mode: "smart", updatedAt: null } },
  };

  it("prefers a session's override over the default", () => {
    expect(effectiveApprovalMode(config, "/sessions/one.jsonl")).toBe("smart");
  });

  it("falls back to the default for other sessions, drafts and unknown policies", () => {
    expect(effectiveApprovalMode(config, "/sessions/two.jsonl")).toBe("ask");
    expect(effectiveApprovalMode(config, null)).toBe("ask");
    expect(effectiveApprovalMode(config, "draft:abc")).toBe("ask");
    expect(effectiveApprovalMode(null, "/sessions/one.jsonl")).toBeNull();
  });

  it("tolerates a response from a server that predates overrides", () => {
    expect(effectiveApprovalMode({ ...POLICY, sessions: undefined }, "/sessions/one.jsonl")).toBe("ask");
  });
});

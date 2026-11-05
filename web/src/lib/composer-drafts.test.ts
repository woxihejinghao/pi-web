import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import { actions, appStore, resetAppState } from "./app-state.ts";
import { composerDraftFor, composerDraftPaths, deleteComposerDraft } from "./composer-drafts.ts";

const PATH = "/sessions/one.jsonl";
beforeEach(() => {
  resetAppState();
  vi.stubGlobal("navigator", { language: "zh-CN" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("composer draft cache lifecycle", () => {
  it("does not cache empty sessions simply because they were visited", () => {
    for (let i = 0; i < 1000; i++) {
      const path = `/sessions/${i}.jsonl`;
      const empty = composerDraftFor(path);
      expect(composerDraftFor(path)).not.toBe(empty);
    }
    expect(composerDraftPaths.get().size).toBe(0);
  });

  it("evicts cleared content and labels, while allowing the mounted input to be reused", () => {
    const draft = composerDraftFor(PATH);
    draft.update((state) => ({ ...state, text: "hello" }));
    draft.get().references.set("@api.ts", "src/api.ts");
    expect(composerDraftFor(PATH)).toBe(draft);
    draft.update((state) => ({ ...state, text: " \n " }));
    expect(composerDraftFor(PATH)).not.toBe(draft);
    expect(draft.get().references.size).toBe(0);
    expect(composerDraftPaths.get().has(PATH)).toBe(false);
    draft.update((state) => ({ ...state, text: "another draft" }));
    expect(composerDraftFor(PATH)).toBe(draft);
  });

  it("notifies sidebar subscribers only when draft presence changes", () => {
    const listener = vi.fn();
    const unsubscribe = composerDraftPaths.subscribe(listener);
    try {
      const draft = composerDraftFor(PATH);
      draft.update((state) => ({ ...state, text: "h" }));
      draft.update((state) => ({ ...state, text: "hello" }));
      draft.update((state) => ({ ...state, text: "hello world" }));
      expect(listener).toHaveBeenCalledTimes(1);
      draft.update((state) => ({ ...state, text: "" }));
      expect(listener).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });

  it("keeps an empty sending draft so a failure can restore into the same store", () => {
    const draft = composerDraftFor(PATH);
    draft.update((state) => ({ ...state, text: "hello", sending: true }));
    draft.update((state) => ({ ...state, text: "" }));
    expect(composerDraftFor(PATH)).toBe(draft);
    expect(composerDraftPaths.get().has(PATH)).toBe(false);
    draft.update((state) => ({ ...state, text: "hello", sending: false }));
    expect(composerDraftPaths.get().has(PATH)).toBe(true);
    draft.update((state) => ({ ...state, text: "", sending: false }));
    expect(composerDraftFor(PATH)).not.toBe(draft);
  });

  it("invalidates pending callbacks when a session is deleted", () => {
    const draft = composerDraftFor(PATH);
    draft.update((state) => ({ ...state, text: "hello", sending: true }));
    deleteComposerDraft(PATH);
    draft.update((state) => ({ ...state, text: "failed send restored", sending: false }));
    expect(draft.get().text).toBe("");
    expect(composerDraftFor(PATH)).not.toBe(draft);
    expect(composerDraftPaths.get().has(PATH)).toBe(false);
  });

  it("cleans the draft after a successful session deletion", async () => {
    vi.spyOn(api, "deleteSession").mockResolvedValue({ ok: true, method: "trash" });
    vi.spyOn(actions, "refreshProjects").mockResolvedValue(undefined);
    const draft = composerDraftFor(PATH);
    draft.update((state) => ({ ...state, text: "unsent" }));
    appStore.update((state) => ({ ...state, selectedSessionPath: PATH }));
    await actions.deleteSession(PATH);
    expect(appStore.get().selectedSessionPath).toBeNull();
    expect(composerDraftFor(PATH)).not.toBe(draft);
    expect(composerDraftPaths.get().has(PATH)).toBe(false);
  });

  it("preserves the draft if deleting the session fails", async () => {
    vi.spyOn(api, "deleteSession").mockRejectedValue(new Error("EPERM"));
    const draft = composerDraftFor(PATH);
    draft.update((state) => ({ ...state, text: "keep this" }));
    await actions.deleteSession(PATH);
    expect(composerDraftFor(PATH)).toBe(draft);
    expect(draft.get().text).toBe("keep this");
    expect(composerDraftPaths.get().has(PATH)).toBe(true);
  });
});

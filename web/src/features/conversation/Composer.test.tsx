import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actions, appStore, resetAppState } from "../../lib/app-state.ts";
import { composerDraftFor, composerDraftPaths, deleteComposerDraft } from "../../lib/composer-drafts.ts";
import * as attachments from "../../lib/image-attachments.ts";
import type { ImageBlock } from "../../lib/types.ts";
import { Composer } from "./Composer.tsx";
import { REFERENCE_SLOT } from "./reference-token.ts";
import { useImageDraft, type ImageDraft } from "./useImageDraft.ts";
import { useReferenceDraft, type ReferenceDraft } from "./useReferenceDraft.ts";

const ONE = "/sessions/one.jsonl";
const TWO = "/sessions/two.jsonl";
const picture: ImageBlock = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

function composer(path: string): string {
  appStore.update((state) => ({ ...state, selectedSessionPath: path }));
  return renderToStaticMarkup(<Composer isStreaming={false} onSend={async () => true} onAbort={() => undefined} />);
}

function imageDraft(path: string): ImageDraft {
  let draft!: ImageDraft;
  function Probe() {
    draft = useImageDraft({}, composerDraftFor(path));
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return draft;
}

beforeEach(() => {
  resetAppState();
  vi.stubGlobal("navigator", { language: "en" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session composer drafts", () => {
  it("shows only the selected session's text and restores it after remounting", () => {
    composerDraftFor(ONE).update((state) => ({ ...state, text: "first unsent message" }));
    composerDraftFor(TWO).update((state) => ({ ...state, text: "second unsent message" }));
    expect(composer(ONE)).toContain("first unsent message</textarea>");
    const other = composer(TWO);
    expect(other).toContain("second unsent message</textarea>");
    expect(other).not.toContain("first unsent message");
    expect(composer(ONE)).toContain("first unsent message</textarea>");
    expect(composer("/sessions/empty.jsonl")).not.toContain("unsent message");
  });

  it("keeps attachments and reference expansion with their session after remounting", () => {
    imageDraft(ONE).restore([picture]);
    const store = composerDraftFor(ONE);
    store.get().references.set("@api.ts", "src/server/api.ts");
    expect(imageDraft(TWO).images).toEqual([]);
    expect(imageDraft(ONE).images).toEqual([picture]);
    let reference!: ReferenceDraft;
    function Probe() {
      reference = useReferenceDraft({
        text: `${REFERENCE_SLOT}@api.ts`, setText: () => undefined, textareaRef: { current: null },
        workspacePath: "/project", references: store.get().references,
      });
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(reference.expand(`${REFERENCE_SLOT}@api.ts`)).toBe("@src/server/api.ts");
  });

  it("finishes an image read in its original session after switching away", async () => {
    let finish!: (value: Awaited<ReturnType<typeof attachments.readImageFile>>) => void;
    vi.spyOn(attachments, "readImageFile").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = imageDraft(ONE).attach([{} as File]);
    composer(TWO);
    finish({ image: picture, refusal: null });
    await pending;
    expect(imageDraft(ONE).images).toEqual([picture]);
    expect(imageDraft(TWO).images).toEqual([]);
  });

  it("preserves a draft typed before the session receives its real path", async () => {
    let finish!: (value: Awaited<ReturnType<typeof import("../../lib/api.ts").api.createSession>>) => void;
    const { api } = await import("../../lib/api.ts");
    vi.spyOn(api, "createSession").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    actions.startDraftSession("project-1");
    const localPath = appStore.get().selectedSessionPath!;
    const original = composerDraftFor(localPath);
    original.update((state) => ({ ...state, text: "typed while starting", images: [picture] }));
    finish({ sessionPath: ONE, sessionId: "one", projectPath: "/project", prewarmed: false, presetId: "standard" });
    await actions.resolveDraftSession();
    expect(composerDraftFor(ONE)).toBe(original);
    expect(composer(ONE)).toContain("typed while starting</textarea>");
    expect(imageDraft(ONE).images).toEqual([picture]);
    expect(composerDraftPaths.get().has(localPath)).toBe(false);
    expect(composerDraftPaths.get().has(ONE)).toBe(true);
  });

  it("does not resurrect a deleted session when its image read finishes", async () => {
    let finish!: (value: Awaited<ReturnType<typeof attachments.readImageFile>>) => void;
    vi.spyOn(attachments, "readImageFile").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = imageDraft(ONE).attach([{} as File]);
    deleteComposerDraft(ONE);
    finish({ image: picture, refusal: null });
    await pending;
    expect(imageDraft(ONE).images).toEqual([]);
    expect(composerDraftPaths.get().has(ONE)).toBe(false);
  });

  it("releases an empty draft when the final image read is refused", async () => {
    vi.spyOn(attachments, "readImageFile").mockResolvedValue({ image: null, refusal: null });
    const pending = imageDraft(ONE).attach([{} as File]);
    const store = composerDraftFor(ONE);
    expect(store.get().pendingReads).toBe(1);
    await pending;
    expect(composerDraftFor(ONE)).not.toBe(store);
    expect(composerDraftPaths.get().has(ONE)).toBe(false);
  });
});

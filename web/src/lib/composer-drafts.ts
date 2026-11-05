import { createStore, type Store } from "./store.ts";
import type { ImageBlock } from "./types.ts";

export interface ComposerDraft {
  text: string;
  images: ImageBlock[];
  references: Map<string, string>;
  sending: boolean;
  pendingReads: number;
}

// Cache only content or ongoing work. An empty mounted input owns its store
// locally; simply visiting sessions must not accumulate cache entries.
const drafts = new Map<string, Store<ComposerDraft>>();
const owners = new WeakMap<Store<ComposerDraft>, { path: string; disposed: boolean }>();
export const composerDraftPaths = createStore<ReadonlySet<string>>(new Set());

function hasContent(draft: ComposerDraft): boolean {
  return draft.text.trim().length > 0 || draft.images.length > 0;
}

function markDraft(path: string, present: boolean): void {
  composerDraftPaths.update((paths) => {
    if (paths.has(path) === present) return paths;
    const next = new Set(paths);
    if (present) next.add(path);
    else next.delete(path);
    return next;
  });
}

function emptyDraft(): ComposerDraft {
  return { text: "", images: [], references: new Map(), sending: false, pendingReads: 0 };
}

export function composerDraftFor(sessionPath: string): Store<ComposerDraft> {
  const existing = drafts.get(sessionPath);
  if (existing) return existing;
  const owner = { path: sessionPath, disposed: false };
  const base = createStore(emptyDraft());
  const store: Store<ComposerDraft> = {
    get: base.get,
    subscribe: base.subscribe,
    set(next) {
      // A deleted session's pending send/read must never resurrect its cache.
      if (owner.disposed) return;
      const content = hasContent(next);
      const retain = content || next.sending || next.pendingReads > 0;
      if (retain) drafts.set(owner.path, store);
      else {
        if (drafts.get(owner.path) === store) drafts.delete(owner.path);
        next.references.clear();
      }
      base.set(next);
      markDraft(owner.path, content);
    },
    update(updater) { store.set(updater(base.get())); },
  };
  owners.set(store, owner);
  return store;
}

/** Preserve in-flight work and labels when pi names the session file. */
export function moveComposerDraft(from: string, to: string): void {
  const draft = drafts.get(from);
  if (!draft) return;
  const owner = owners.get(draft)!;
  owner.path = to;
  drafts.delete(from);
  drafts.set(to, draft);
  composerDraftPaths.update((paths) => {
    const next = new Set(paths);
    next.delete(from);
    if (hasContent(draft.get())) next.add(to);
    return next;
  });
}

export function deleteComposerDraft(sessionPath: string): void {
  const draft = drafts.get(sessionPath);
  if (draft) {
    draft.get().references.clear();
    draft.set(emptyDraft());
    owners.get(draft)!.disposed = true;
  }
  drafts.delete(sessionPath);
  markDraft(sessionPath, false);
}

export function clearComposerDrafts(): void {
  for (const path of drafts.keys()) deleteComposerDraft(path);
  composerDraftPaths.set(new Set());
}

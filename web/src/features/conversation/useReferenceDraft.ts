import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { actions, useT } from "../../lib/app-state.ts";
import {
  expandReferences,
  FILE_SIGIL,
  fileLabel,
  fileReferenceInsertion,
  fileToken,
  REFERENCE_SLOT,
  referenceAtCaret,
  referenceInsertion,
  referenceLabel,
  referenceLabelFor,
  referenceSpans,
  relativeReference,
  tokenLabel,
  withTrailingSlash,
} from "./reference-token.ts";
import type { FolderDropHandlers } from "./useImageDraft.ts";

/** What a message input needs from the folder drops it accepts. */
export interface ReferenceDraft extends FolderDropHandlers {
  /** The draft as it should be sent: every label restored to its path. */
  expand(text: string): string;
  /**
   * Take a whole reference for one Backspace/Delete keystroke. Returns true
   * when it did — the caret was inside one, or against the edge the key comes
   * from.
   */
  removeAtCaret(key: "Backspace" | "Delete"): boolean;
  /** Forget the labels; the draft that carried them is gone. */
  clear(): void;
  /**
   * Write the chip for one picked path, replacing the text from `start` to the
   * caret.
   *
   * `start` is chosen by the completion (it is where the `@` token began,
   * including the glyph slot of a chip it is completing further), because only
   * the caller knows which of the two kinds of reference is being replaced.
   * The path is the server's spelling: relative to the workspace, `/`-separated.
   */
  insertReference(path: string, kind: "file" | "directory", start: number): void;
}

/**
 * The labels the draft already speaks for: the ones a chip stands on, plus the
 * reference-shaped words the user typed.
 *
 * Normalized to the bare label, because that is what a mint compares against —
 * a chip's token carries a sigil and possibly quotes, and neither is part of
 * the name being claimed. Collisions left unhandled here are the kind that
 * rewrite a sentence the user wrote.
 */
function takenLabels(text: string, references: ReadonlyMap<string, string>): Set<string> {
  const taken = new Set<string>();
  for (const token of references.keys()) taken.add(tokenLabel(token));
  for (const span of referenceSpans(text)) {
    const raw = text.slice(span.start, span.end);
    taken.add(tokenLabel(raw.startsWith(REFERENCE_SLOT) ? raw.slice(REFERENCE_SLOT.length) : raw));
  }
  return taken;
}

/**
 * References for one message input: a dropped folder, or a file picked from the
 * `@` menu.
 *
 * The drop arrives as an absolute path (the shell's bridge, see `pathForFile`)
 * and leaves as a short label at the caret — `alpha/` rather than the whole
 * `/tmp/pw-probe/alpha/` — which is what makes a draft with three references in
 * it stay readable. The path behind each label is kept here, in the one place
 * that knows both, and put back when the message is sent.
 *
 * The `@` menu writes through the same map, for the same reason and with one
 * difference in spelling: its token carries the sigil (`@api.ts`), because that
 * is what the completion was asked for and what the sentence should say when it
 * is sent. Both kinds are minted and removed identically — one Backspace takes
 * either chip whole — so the input only has one notion of "a reference".
 *
 * Keeping it here rather than in the draft is what makes a hand edit safe: a
 * label the user retypes is no longer the string this map minted, so it stops
 * resolving and travels as ordinary text. The other direction — sending a path
 * the user did not mean — cannot happen, because a label is only ever minted
 * for a path this input received.
 *
 * The caret is restored one commit later. It cannot be set where the value is
 * set: React has not written the new text into the textarea yet, and a browser
 * whose value changes puts the caret at the end on its own.
 */
export function useReferenceDraft({ text, setText, textareaRef, workspacePath, references: savedReferences }: {
  text: string;
  setText(value: string): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The workspace the message is about to be sent in; references are relative to it. */
  workspacePath: string | undefined;
  /** Session-owned labels, restored with the text when the input remounts. */
  references?: Map<string, string>;
}): ReferenceDraft {
  const t = useT();
  /** The caret the next commit owes, once the value it belongs to is in the DOM. */
  const pendingCaret = useRef<number | null>(null);
  /** Label → absolute path, for the references currently spelled in the draft. */
  const references = useRef(savedReferences ?? new Map<string, string>());

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const area = textareaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(caret, caret);
  });

  const onDroppedFolder = useCallback(
    (path: string): boolean => {
      const area = textareaRef.current;
      const start = area?.selectionStart ?? text.length;
      const end = area?.selectionEnd ?? start;
      const target = withTrailingSlash(relativeReference(path, workspacePath));
      // Labels already spoken for, plus the reference-shaped words the user
      // typed: a new label must not collide with either, or expanding it would
      // rewrite a sentence this drop never wrote.
      const label = referenceLabelFor(target, references.current, takenLabels(text, references.current));
      references.current.set(label, target);
      const next = referenceInsertion(text, start, end, label);
      pendingCaret.current = next.caret;
      setText(next.text);
      return true;
    },
    [text, setText, textareaRef, workspacePath],
  );

  const expand = useCallback(
    (draft: string): string => expandReferences(draft, references.current),
    [],
  );

  const removeAtCaret = useCallback(
    (key: "Backspace" | "Delete"): boolean => {
      const area = textareaRef.current;
      if (area === null) return false;
      const start = area.selectionStart;
      // A selection is the user's own range; it deletes as it always did.
      if (start !== area.selectionEnd) return false;
      const span = referenceAtCaret(text, start, key === "Backspace" ? "back" : "forward");
      if (span === null) return false;
      pendingCaret.current = span.start;
      setText(text.slice(0, span.start) + text.slice(span.end));
      return true;
    },
    [text, setText, textareaRef],
  );

  const clear = useCallback((): void => {
    references.current.clear();
  }, []);

  const insertReference = useCallback(
    (path: string, kind: "file" | "directory", start: number): void => {
      const area = textareaRef.current;
      const value = area?.value ?? text;
      const end = area?.selectionEnd ?? value.length;
      // A folder reference carries its separator so the sentence reads as a
      // folder and the agent can descend; a file reference reads as its name.
      const target =
        kind === "directory"
          ? withTrailingSlash(relativeReference(path, workspacePath))
          : relativeReference(path, workspacePath);
      const taken = takenLabels(text, references.current);
      const label = kind === "directory" ? referenceLabel(target, taken) : fileLabel(target, taken);
      // Picking the same path twice is one reference, not two spellings of it —
      // the same rule a folder drop follows, and the reason a second mention
      // does not mint `lib/api.ts` beside an existing `api.ts`.
      let reused: string | null = null;
      for (const [existingToken, existingTarget] of references.current) {
        if (existingTarget !== target || !existingToken.startsWith(FILE_SIGIL)) continue;
        reused = existingToken;
        break;
      }
      const token = reused ?? fileToken(label);
      const next = fileReferenceInsertion(value, start, end, token);
      references.current.set(token, target);
      pendingCaret.current = next.caret;
      setText(next.text);
    },
    [text, setText, textareaRef, workspacePath],
  );

  const onUnnamedFolder = useCallback((): void => {
    actions.setNotice(t("composer.folderDesktopOnly"));
  }, [t]);

  return { onDroppedFolder, onUnnamedFolder, expand, removeAtCaret, clear, insertReference };
}

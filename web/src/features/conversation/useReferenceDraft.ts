import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { actions, useT } from "../../lib/app-state.ts";
import {
  expandReferences,
  referenceAtCaret,
  referenceInsertion,
  referenceLabelFor,
  referenceSpans,
  relativeReference,
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
}

/**
 * Folder drops for one message input.
 *
 * The drop arrives as an absolute path (the shell's bridge, see `pathForFile`)
 * and leaves as a short label at the caret — `alpha/` rather than the whole
 * `/tmp/pw-probe/alpha/` — which is what makes a draft with three references in
 * it stay readable. The path behind each label is kept here, in the one place
 * that knows both, and put back when the message is sent.
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
export function useReferenceDraft({ text, setText, textareaRef, workspacePath }: {
  text: string;
  setText(value: string): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The workspace the message is about to be sent in; references are relative to it. */
  workspacePath: string | undefined;
}): ReferenceDraft {
  const t = useT();
  /** The caret the next commit owes, once the value it belongs to is in the DOM. */
  const pendingCaret = useRef<number | null>(null);
  /** Label → absolute path, for the references currently spelled in the draft. */
  const references = useRef(new Map<string, string>());

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
      const taken = new Set<string>(references.current.keys());
      for (const span of referenceSpans(text)) taken.add(text.slice(span.start, span.end));
      const label = referenceLabelFor(target, references.current, taken);
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

  const onUnnamedFolder = useCallback((): void => {
    actions.setNotice(t("composer.folderDesktopOnly"));
  }, [t]);

  return { onDroppedFolder, onUnnamedFolder, expand, removeAtCaret, clear };
}

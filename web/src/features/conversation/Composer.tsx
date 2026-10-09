import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { SendIcon, StopIcon } from "../../components/icons.tsx";
import type {
  BusySendBehavior,
  ComposerContext,
  ComposerModel,
  ImageBlock,
  SlashCommand,
} from "../../lib/types.ts";
import { AttachmentInput, AttachmentStrip, AttachButton } from "./AttachmentStrip.tsx";
import { DraftMirror } from "./DraftMirror.tsx";
import { useImageDraft } from "./useImageDraft.ts";
import { useReferenceDraft } from "./useReferenceDraft.ts";
import { ContextMeter } from "./ContextMeter.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { SlashMenu } from "./SlashMenu.tsx";
import { useSlashCompletion } from "./useSlashCompletion.ts";
import styles from "./Composer.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * The session's model, switchable list and context figures, supplied by
 * `useComposerState`. One object rather than six props because every field
 * describes the same thing, and the group is omitted only when there is no
 * session to describe.
 */
export interface ComposerSession {
  model: ComposerModel | null;
  models: ComposerModel[] | null;
  context: ComposerContext | null;
  /** A live fetch is in flight (the cold start that learns the model list). */
  loading: boolean;
  onRequestLive(): void;
  onSelectModel(provider: string, id: string): void;
}

export interface ComposerProps {
  isStreaming: boolean;
  disabled?: boolean;
  /** Slash commands registered for the open project; enables `/` completion. */
  commands?: SlashCommand[];
  /** Default delivery while the agent runs; Cmd/Ctrl+Enter uses the other one. */
  busySendBehavior?: BusySendBehavior;
  /** Model and context controls; omitted when no session can be asked. */
  session?: ComposerSession;
  /** `images` are the pictures going with the message; empty for a text-only turn. */
  onSend(text: string, mode: "prompt" | "steer" | "followUp", images: ImageBlock[]): Promise<boolean>;
  onAbort(): void;
  /** The workspace this message is sent in; a dropped folder is named relative to it. */
  workspacePath?: string | undefined;
}

/** pi delivers a queued message as `followUp`; a steering one as `steer`. */
function deliveryOf(behavior: BusySendBehavior): "steer" | "followUp" {
  return behavior === "queue" ? "followUp" : "steer";
}

/**
 * Input surface for the active session. While the agent is running the message
 * becomes a steering message (delivered after the current tool calls) or a
 * follow-up (delivered once the run settles).
 *
 * Which of the two a plain Enter picks is the "busy send behavior" preference,
 * owned by Settings alone — the composer carries no per-session toggle, so there
 * is one place to look and nothing to reset. Cmd/Ctrl+Enter always takes the
 * other one, which is what keeps the uncommon case reachable mid-run without a
 * second control in the toolbar.
 *
 * Typing `/` opens a completion menu. Skill commands and prompt templates are
 * expanded by pi itself, so a completed command is sent as plain text.
 *
 * Pictures go in three ways — pasted, dropped, or picked with the attach
 * button — and all three end in the same draft strip above the input. The
 * attachments are held as pi's own `ImageBlock` (bare base64), so sending them
 * is not a conversion: the same objects go out over the API and come back from
 * the session file after a reload.
 *
 * A dropped *folder* is not an attachment: it is written into the sentence as
 * its path (`reference-token.ts`), and `DraftMirror` paints that path as a chip
 * under the transparent textarea, since a textarea cannot style part of its own
 * value.
 *
 * To the right of the input sit the session's model picker and context ring.
 * Both describe the session the text is about to be sent into, so they belong
 * to the input rather than to the transcript above it.
 */
export function Composer({
  isStreaming,
  disabled,
  commands = [],
  busySendBehavior = "queue",
  session,
  onSend,
  onAbort,
  workspacePath,
}: ComposerProps) {
  const t = useT();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** The layer painting the draft under the transparent textarea. */
  const mirrorRef = useRef<HTMLDivElement>(null);
  const reference = useReferenceDraft({ text, setText, textareaRef, workspacePath });
  /** The pictures going with the text; see `useImageDraft` for why they are a hook. */
  const draft = useImageDraft(reference);

  const completion = useSlashCompletion({ setText, textareaRef, commands });

  // Layout, not passive. `height: auto` is what lets the box shrink to one line
  // before the new height is measured, and measured after paint that one-line
  // collapse is visible — while a turn streams it also resizes the scrollport
  // twice, so the transcript bounces under the reader on every keystroke. Inside
  // the layout pass the browser only ever sees the final height.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  const submit = async (override?: BusySendBehavior): Promise<void> => {
    const message = text.trim();
    const attachments = draft.images;
    // A picture with no caption is a legitimate message, so emptiness is the
    // question rather than the text alone being empty.
    if ((message.length === 0 && attachments.length === 0) || sending || disabled) return;
    setSending(true);
    // The draft is cleared but not the labels behind it: a failed send puts
    // this very text back, and it has to keep meaning what it meant.
    setText("");
    draft.clear();
    const choice = override ?? busySendBehavior;
    const ok = await onSend(
      reference.expand(message),
      isStreaming ? deliveryOf(choice) : "prompt",
      attachments,
    );
    if (!ok) {
      // The draft as it was, not the trimmed sentence: the trim only decides
      // whether there was anything to send, and putting its result back would
      // drop the glyph slot off a reference that starts the draft.
      setText(text);
      draft.restore(attachments);
    } else {
      reference.clear();
    }
    setSending(false);
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While the command menu is open it owns the arrow keys, Enter/Tab and
    // Escape, so Enter completes a command instead of sending the message.
    if (completion.onKeyDown(event)) return;

    // A reference is one thing to the caret, not a run of characters: one
    // keystroke takes the whole chip (see `referenceAtCaret`).
    if (
      !event.nativeEvent.isComposing &&
      (event.key === "Backspace" || event.key === "Delete") &&
      reference.removeAtCaret(event.key)
    ) {
      event.preventDefault();
      completion.sync();
      return;
    }

    // Never submit while an IME composition is active (Chinese input).
    //
    // Alt is refused for the opposite reason: `⌘⌥↵` is this app's
    // fullscreen-the-sidebar shortcut, and a keystroke that belongs to a command
    // must not also be read as "send". dsh's composer draws the same line, in the
    // same place — its keymap returns early on `altKey` without consuming the
    // event, so the shortcut service still sees it.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      const other = event.metaKey || event.ctrlKey;
      // An idle agent has only one behavior, so the modifier is a no-op there.
      void submit(other ? (busySendBehavior === "queue" ? "steer" : "queue") : undefined);
    }
  };

  return (
    <div className={styles.wrap}>
      <div
        className={styles.composer}
        data-dragging={draft.dragging || undefined}
        {...draft.dragProps}
      >
        {completion.open ? (
          <SlashMenu
            matches={completion.matches}
            highlight={completion.highlight}
            onHighlight={completion.setHighlight}
            onSelect={completion.select}
          />
        ) : null}

        <AttachmentStrip
          images={draft.images}
          refusal={draft.refusal}
          onRemove={draft.remove}
        />

        <div className={styles.inputStack}>
          <DraftMirror text={text} className={styles.inputMirror} mirrorRef={mirrorRef} />
          <textarea
            ref={textareaRef}
            className={styles.input}
            value={text}
            rows={1}
            spellCheck={false}
            disabled={disabled}
            placeholder={
              disabled ? t("composer.chooseOrCreate") : t("composer.placeholder")
            }
            aria-label={t("composer.inputLabel")}
            onChange={(event) => {
              setText(event.target.value);
              completion.sync();
            }}
            onKeyUp={() => completion.sync()}
            onClick={() => completion.sync()}
            onKeyDown={onKeyDown}
            onPaste={draft.onPaste}
            onScroll={(event) => {
              const mirror = mirrorRef.current;
              if (mirror) mirror.scrollTop = event.currentTarget.scrollTop;
            }}
          />
        </div>

        <div className={styles.toolbar}>
          {/*
           * The attach button and its picker, in the toolbar where the other
           * input-level controls live. `accept` is the same list the reader
           * enforces, so the dialog cannot offer something the send path would
           * refuse afterwards.
           */}
          <AttachButton disabled={disabled} onClick={draft.openPicker} />
          <AttachmentInput
            inputRef={draft.fileInputRef}
            onFiles={(files) => void draft.attach(files)}
          />

          <span className={styles.spacer} />

          {session ? (
            <ModelPicker
              model={session.model}
              models={session.models}
              loading={session.loading}
              onRequestModels={session.onRequestLive}
              onSelect={session.onSelectModel}
            />
          ) : null}

          {session ? (
            <ContextMeter context={session.context} onRequestLive={session.onRequestLive} />
          ) : null}

          {/*
           * One button, two jobs: while the agent runs it stops the turn, and
           * the resting state sends. Rendering only one of the two keeps the
           * input from carrying a second disc that is dead when the turn ends.
           * A message typed mid-turn still goes out on Enter.
           */}
          {isStreaming ? (
            <button
              type="button"
              className={styles.stop}
              onClick={onAbort}
              aria-label={t("composer.stop")}
              title={t("composer.stop")}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className={styles.send}
              disabled={disabled || sending || (text.trim().length === 0 && draft.images.length === 0)}
              onClick={() => void submit()}
              aria-label={t("composer.send")}
              title={t("composer.send")}
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

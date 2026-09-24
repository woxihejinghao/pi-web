import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SendIcon, StopIcon } from "../../components/icons.tsx";
import type {
  BusySendBehavior,
  ComposerContext,
  ComposerModel,
  ImageBlock,
  SlashCommand,
} from "../../lib/types.ts";
import { AttachmentInput, AttachmentStrip, AttachButton } from "./AttachmentStrip.tsx";
import { useImageDraft } from "./useImageDraft.ts";
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
 * Which of the two a plain Enter picks is the "busy send behavior" preference;
 * the toggle in the toolbar overrides it for the current session only, and
 * Cmd/Ctrl+Enter always takes the other one. Those two shortcuts exist because
 * the setting decides the *common* case, not every case.
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
}: ComposerProps) {
  const t = useT();
  const [text, setText] = useState("");
  /** The pictures going with the text; see `useImageDraft` for why they are a hook. */
  const draft = useImageDraft();
  const [busyMode, setBusyMode] = useState<BusySendBehavior>(busySendBehavior);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const completion = useSlashCompletion({ setText, textareaRef, commands });

  // Adopt a preference changed in settings, but do not clobber the toolbar
  // toggle the user just flipped in this session.
  const lastPreference = useRef(busySendBehavior);
  useEffect(() => {
    if (lastPreference.current === busySendBehavior) return;
    lastPreference.current = busySendBehavior;
    setBusyMode(busySendBehavior);
  }, [busySendBehavior]);

  useEffect(() => {
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
    setText("");
    draft.clear();
    const choice = override ?? busyMode;
    const ok = await onSend(message, isStreaming ? deliveryOf(choice) : "prompt", attachments);
    if (!ok) {
      setText(message);
      draft.restore(attachments);
    }
    setSending(false);
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While the command menu is open it owns the arrow keys, Enter/Tab and
    // Escape, so Enter completes a command instead of sending the message.
    if (completion.onKeyDown(event)) return;

    // Never submit while an IME composition is active (Chinese input).
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const other = event.metaKey || event.ctrlKey;
      // An idle agent has only one behavior, so the modifier is a no-op there.
      void submit(other ? (busyMode === "queue" ? "steer" : "queue") : undefined);
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
        />

        <div className={styles.toolbar}>
          {isStreaming ? (
            <div className={styles.modes} role="radiogroup" aria-label={t("composer.sendMode")}>
              <button
                type="button"
                role="radio"
                aria-checked={busyMode === "steer"}
                className={busyMode === "steer" ? styles.modeActive : styles.mode}
                onClick={() => setBusyMode("steer")}
                title={t("composer.steerTitle")}
              >{t("composer.steer")}</button>
              <button
                type="button"
                role="radio"
                aria-checked={busyMode === "queue"}
                className={busyMode === "queue" ? styles.modeActive : styles.mode}
                onClick={() => setBusyMode("queue")}
                title={t("composer.followUpTitle")}
              >{t("composer.followUp")}</button>
            </div>
          ) : null}

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

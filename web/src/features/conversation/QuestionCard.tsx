import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";
import { CloseIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, type PendingUiRequest, useT } from "../../lib/app-state.ts";
import { api } from "../../lib/api.ts";
import { Markdown } from "./Markdown.tsx";
import {
  CONFIRM_NO,
  CONFIRM_YES,
  answerPayload,
  canSubmit,
  initialText,
  isTextRequest,
  questionOptions,
  secondsLeft,
} from "./question-model.ts";
import styles from "./QuestionCard.module.css";

/**
 * The card that takes over the composer while a pi extension waits on an
 * answer.
 *
 * dsh renders its `ask_user_question` by replacing the chat composer rather
 * than covering the page with a modal, and that is what makes the wait
 * legible: the question shows up where the reply would have been typed, the
 * conversation above stays readable, and the user answers with the same hands
 * that were about to type. pi's dialog sub-protocol is the counterpart seam —
 * `select`, `confirm`, `input` and `editor` — so the same surface carries all
 * four, with rows for a choice and a field for text.
 *
 * The request is a hard block on that pi process, so the card must never be a
 * dead end: every body has a working submit, and both the header close button
 * and Escape answer `cancelled`.
 */
export interface QuestionCardProps {
  pending: PendingUiRequest;
  /** Shown above the title when the request belongs to a session that is not the open one. */
  sessionLabel?: string;
  /** Jumps to that session; offered only alongside `sessionLabel`. */
  onOpenSession?: () => void;
}

export function QuestionCard({ pending, sessionLabel, onOpenSession }: QuestionCardProps) {
  const t = useT();
  const { request } = pending;
  const options = questionOptions(request);
  const confirm = request.method === "confirm";
  const textField = isTextRequest(request);
  const timeout = typeof request.timeout === "number" && request.timeout > 0 ? request.timeout : null;

  const [choice, setChoice] = useState<string | null>(null);
  const [text, setText] = useState(() => initialText(request));
  const [busy, setBusy] = useState<"answer" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(() =>
    timeout === null ? null : Math.ceil(timeout / 1000),
  );

  const cardRef = useRef<HTMLElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  /**
   * The card owns the keyboard while it is up.
   *
   * It takes focus on mount (`autoFocus` below, and this effect as the
   * backstop), and it takes focus *back* when the browser moves it on its own.
   * That second part is not paranoia: creating a session swaps a provisional
   * path for the real one about a second after the card appears, and that
   * re-render is enough for Chromium to hand focus to the sidebar's "new
   * session" control — where the user's next Enter would start yet another
   * session instead of answering the question.
   *
   * A pointer or key press always wins, though: that is the user choosing to be
   * somewhere else, and the card has no business overruling it.
   */
  useEffect(() => {
    const focusTarget = (): HTMLElement | null =>
      confirm || options.length > 0 ? firstOptionRef.current : fieldRef.current;
    focusTarget()?.focus();

    let userDriven = false;
    const markUserDriven = (): void => {
      userDriven = true;
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (userDriven) return;
      if (cardRef.current?.contains(event.target as Node) === true) return;
      focusTarget()?.focus();
    };
    document.addEventListener("pointerdown", markUserDriven, true);
    document.addEventListener("keydown", markUserDriven, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("pointerdown", markUserDriven, true);
      document.removeEventListener("keydown", markUserDriven, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
    // The request never changes under a mounted card (the parent keys it by
    // dialog id), so the guard is installed once and lives until the answer.
  }, [confirm, options.length]);

  // pi resolves a timed-out dialog on its own and tells nobody, so the client
  // counts the same deadline down and retires the card when it passes. The
  // response is deliberately not sent: by then pi has already moved on, and a
  // late answer would only race the agent's own default.
  useEffect(() => {
    if (timeout === null) return;
    const deadline = Date.now() + timeout;
    const timer = window.setInterval(() => {
      const left = secondsLeft(deadline, Date.now());
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(timer);
        actions.dismissUiRequest(request.id);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [request.id, timeout]);

  const respond = async (payload: Record<string, unknown>): Promise<void> => {
    setBusy("answer");
    setError(null);
    try {
      await api.respondToUiRequest(request.id, payload);
      actions.dismissUiRequest(request.id);
    } catch (err) {
      setBusy(null);
      setError((err as Error).message);
    }
  };

  const cancel = (): void => {
    setBusy("cancel");
    setError(null);
    void api
      .respondToUiRequest(request.id, { cancelled: true })
      .then(() => actions.dismissUiRequest(request.id))
      .catch((err: Error) => {
        setBusy(null);
        setError(err.message);
      });
  };

  const submit = (): void => {
    if (busy !== null || !canSubmit(request, choice, text)) return;
    const payload = answerPayload(request, choice, text);
    if (payload) void respond(payload);
  };

  const title =
    typeof request.title === "string" && request.title.length > 0
      ? request.title
      : confirm
        ? t("question.confirm")
        : textField
          ? t("question.input")
          : t("question.select");
  const detail = typeof request.message === "string" ? request.message : "";
  const placeholder = typeof request.placeholder === "string" ? request.placeholder : t("question.placeholder");
  const disabled = busy !== null;
  // `confirm` is a two-action question rather than a list — pi answers it with a
  // boolean, so the rows are ours and the token is translated back on submit.
  const rows = confirm
    ? [
        { value: CONFIRM_YES, label: t("question.yes"), recommended: false },
        { value: CONFIRM_NO, label: t("question.no"), recommended: false },
      ]
    : options;

  /**
   * Number keys pick a row without moving the mouse; the badge on the left is
   * that shortcut, so it is not decoration. A `confirm` row answers on the spot
   * (that is what its click does), while a `select` row only takes the pick —
   * Enter submits it, matching the row buttons' own behavior below.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // An IME owns Escape while a candidate list is open: that key closes the
    // list, and cancelling the dialog on top of it would lose the answer.
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      cancel();
      return;
    }
    if (textField || busy !== null) return;
    const index = Number(event.key) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) return;
    const row = rows[index];
    if (row === undefined) return;
    event.preventDefault();
    if (confirm) {
      setChoice(row.value);
      void respond(answerPayload(request, row.value, text) ?? {});
      return;
    }
    setChoice(row.value);
    setError(null);
  };

  return (
    <div className={styles.wrap}>
      <section
        ref={cardRef}
        className={clsx(styles.card, minimized && styles.cardMinimized)}
        role="dialog"
        aria-label={title}
        data-question-id={request.id}
        onKeyDown={onKeyDown}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            {sessionLabel ? (
              <div className={styles.eyebrow}>
                <span className={styles.eyebrowText}>{sessionLabel}</span>
                {onOpenSession ? (
                  <button type="button" className={styles.eyebrowAction} onClick={onOpenSession}>{t("question.goTo")}</button>
                ) : null}
              </div>
            ) : null}
            <h2 className={styles.title}>{title}</h2>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.iconButton}
              aria-expanded={!minimized}
              aria-label={minimized ? t("question.expand") : t("question.collapse")}
              title={minimized ? t("question.expand") : t("question.collapse")}
              disabled={disabled}
              onClick={() => setMinimized((current) => !current)}
            >
              <span className={clsx(styles.chevron, minimized && styles.chevronUp)}>
                <Glyph name="chevronDown" size={14} />
              </span>
            </button>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t("common.cancel")}
              title={t("question.cancelTitle")}
              disabled={disabled}
              onClick={cancel}
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        {!minimized ? (
          <>
            <div className={styles.body}>
              {detail.length > 0 ? (
                <div className={styles.detail}>
                  <Markdown text={detail} />
                </div>
              ) : null}

              {!textField ? (
                <div className={styles.options} role="radiogroup" aria-label={title}>
                  {rows.map((option, index) => {
                    const selected = choice === option.value;
                    return (
                      <button
                        type="button"
                        key={option.value}
                        autoFocus={index === 0}
                        ref={index === 0 ? firstOptionRef : undefined}
                        role="radio"
                        aria-checked={selected}
                        className={clsx(styles.option, selected && styles.optionSelected)}
                        disabled={disabled}
                        onClick={() => {
                          if (confirm) {
                            setChoice(option.value);
                            void respond(
                              answerPayload(request, option.value, text) ?? {},
                            );
                            return;
                          }
                          setChoice(option.value);
                          setError(null);
                        }}
                        onKeyDown={(event) => {
                          // Enter on a row picks it (the browser turns the key
                          // into this button's click); once the row is already
                          // the pick, the same key submits — so a one-question
                          // card is two presses rather than a press plus a
                          // reach for the button. `confirm` answers on click,
                          // so it never has a second Enter to spend.
                          if (event.key !== "Enter" || !selected || confirm) return;
                          event.preventDefault();
                          submit();
                        }}
                      >
                        <span className={styles.number}>{index + 1}</span>
                        <span className={styles.optionCopy}>
                          <span className={styles.optionLabel}>{option.label}</span>
                          {option.recommended ? (
                            <span className={styles.badge}>{t("question.recommended")}</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <AnswerField
                  fieldRef={fieldRef}
                  value={text}
                  multiline={request.method === "editor"}
                  placeholder={placeholder}
                  disabled={disabled}
                  autoFocus
                  onChange={(event) => {
                    setText(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                    // Input is single-line in intent, so Enter answers it; the
                    // editor holds text that has its own line breaks and asks
                    // for the modifier instead.
                    const submits = request.method === "editor" ? event.metaKey || event.ctrlKey : !event.shiftKey;
                    if (!submits) return;
                    event.preventDefault();
                    submit();
                  }}
                />
              )}
            </div>

            <footer className={styles.footer}>
              <div className={styles.hint} role="status">
                {remaining === null ? "" : t("question.autoCancel", { seconds: remaining })}
              </div>
              <div className={styles.feedback} role="alert">
                {error}
              </div>
              <div className={styles.footerActions}>
                <button type="button" className={styles.secondary} disabled={disabled} onClick={cancel}>{t("common.cancel")}</button>
                {confirm ? null : (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={disabled || !canSubmit(request, choice, text)}
                    onClick={submit}
                  >
                    {busy === "answer" ? t("common.submitting") : t("common.submit")}
                  </button>
                )}
              </div>
            </footer>
          </>
        ) : null}
      </section>
    </div>
  );
}

/** The free-text answer field, mirror-grown so a long answer never scrolls its own box empty. */
function AnswerField({
  fieldRef,
  value,
  multiline,
  placeholder,
  disabled,
  autoFocus,
  onChange,
  onKeyDown,
}: {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  multiline: boolean;
  placeholder: string;
  disabled: boolean;
  autoFocus?: boolean;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <div className={clsx(styles.field, multiline && styles.fieldMultiline)}>
      <div aria-hidden className={styles.fieldMirror}>{`${value}\n`}</div>
      <textarea
        ref={fieldRef}
        className={styles.fieldInput}
        value={value}
        rows={1}
        disabled={disabled}
        autoFocus={autoFocus}
        spellCheck={false}
        placeholder={placeholder}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { CloseIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { useT } from "../../lib/app-state.ts";
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from "../../lib/types.ts";
import { Markdown } from "./Markdown.tsx";
import { AnswerField } from "./AnswerField.tsx";
import { PlanReviewPanel } from "./PlanReviewPanel.tsx";
import {
  askUserAnswerPayload,
  askUserAnswered,
  firstUnanswered,
  initialAskUserDrafts,
  parseRecommendedLabel,
  secondsLeft,
  toggleAskUserSelection,
  type AskUserDraft,
} from "./question-model.ts";
import {
  clearQuestionDraft,
  readQuestionDraft,
  writeQuestionDraft,
} from "./question-draft-store.ts";
import card from "./QuestionCard.module.css";
import styles from "./QuestionComposer.module.css";

/**
 * What the user decided about one batch.
 *
 * The same three shapes the protocol has: an answer batch, a cancel, and the
 * deadline expiring. They are one union rather than three callbacks because
 * every caller has to handle all three, and the two that are not an answer mean
 * different things to the agent — a cancel was a person, a timeout was nobody.
 */
export type AskUserDecision =
  | { answers: AskUserQuestionAnswerItem[] }
  | { cancelled: true }
  | { timedOut: true };

/**
 * The card that takes over the composer for a batched question.
 *
 * dsh asks several questions in one `ask_user_question` and the user answers
 * them as one batch; that is the whole point of the tool, so this card is the
 * single-question `QuestionCard` scaled to a set: one question at a time with a
 * pager, a draft per question that survives moving around, and one submit at
 * the end. It occupies the same seat and reuses the same styles, because to the
 * user this is the same surface with more to answer.
 *
 * It is deliberately unaware of where its batch came from. A live request hands
 * it a deadline and a `cancelled` path; the same batch re-opened after its
 * deadline (see `pending-questions.ts`) hands it neither and is submitted as a
 * new user message instead. Both are the same interaction over the same
 * questions, so they are the same component.
 */
export interface QuestionComposerProps {
  questions: AskUserQuestionItem[];
  /** Receive the decision. A rejected promise is shown in the card's footer. */
  onSubmit: (decision: AskUserDecision) => Promise<void> | void;
  /** Card title; falls back to the batch size, then a lone question's header. */
  title?: string;
  /** Deadline the user was shown, in ms. `null` (the default) draws no countdown. */
  timeoutMs?: number | null;
  /**
   * Whether the card can be dismissed. A live dialog has a pi process blocked
   * behind it, so closing it answers `cancelled`; a question re-opened after its
   * deadline blocks nothing and is closed by simply putting it away.
   */
  cancellable?: boolean;
  /**
   * Whether the card is drawn inside a strip rather than in the composer seat.
   * The wrapper's page insets go away; the strip already provides them.
   */
  embedded?: boolean;
  /** The dialog id, for the card's DOM identity while it is a live request. */
  requestId?: string;
  /**
   * Where this card's unfinished answer is kept across a reload. Omitted when
   * there is nothing stable to key it by, which just means the card forgets.
   */
  draftKey?: string;
  /**
   * Show this review's plan in the right sidebar, returning whether it landed.
   *
   * The card opens it without being asked (dsh's `PlanReviewOpen` does), and a
   * `false` — no session to address yet — leaves the automatic open pending
   * instead of spending it.
   */
  onOpenPlan?: ((plan: PlanReviewTarget) => boolean) | undefined;
}

/**
 * A plan as the sidebar needs it: the document, the title it is filed under, and
 * the tool call that submitted it when there is one.
 */
export interface PlanReviewTarget {
  /** The `exit_plan_mode` call that submitted the plan; absent for a review
   * that reached the card straight from an extension. */
  callId?: string;
  /** The dialog's own id, which is what names a call-less document in memory. */
  requestId?: string;
  title: string;
  plan: string;
}

const EMPTY_DRAFT: AskUserDraft = { selected: [], custom: "", skipped: false };

export function QuestionComposer({
  questions,
  onSubmit,
  title: titleProp,
  timeoutMs = null,
  cancellable = true,
  embedded = false,
  requestId,
  draftKey,
  onOpenPlan,
}: QuestionComposerProps) {
  const t = useT();
  const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : null;

  // The batch never changes under a mounted card — the parent keys it by the
  // call it belongs to — so the drafts are seeded once and drift only by action.
  // Read once, outside the state initializers, so the restored index and the
  // restored drafts can never come from two different reads.
  const [restored] = useState(() =>
    draftKey === undefined ? null : readQuestionDraft(draftKey, questions.length),
  );
  const [drafts, setDrafts] = useState<AskUserDraft[]>(() => restored?.drafts ?? initialAskUserDrafts(questions));
  const [index, setIndex] = useState(() => restored?.index ?? 0);
  const [busy, setBusy] = useState<"answer" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(() =>
    timeout === null ? null : Math.ceil(timeout / 1000),
  );
  // Whether the user asked to write changes to a plan instead of approving it.
  const [planChanges, setPlanChanges] = useState(false);

  // Leaving the question puts the approval card back in its decision state: the
  // request-changes field belongs to the question it was opened on.
  useEffect(() => {
    setPlanChanges(false);
  }, [index]);

  const cardRef = useRef<HTMLElement>(null);

  const current = questions[index];
  const draft = drafts[index] ?? EMPTY_DRAFT;
  const options = current?.options ?? [];
  const multiSelect = current?.multiSelect === true;
  const disabled = busy !== null;
  const total = questions.length;
  const answered = questions.filter((_question, position) => askUserAnswered(drafts[position])).length;
  // A plan review is the whole card or it is nothing: dsh accepts the tag only
  // on a lone question with at most one alternative, because the verdict is what
  // the model is asking for — a batch of several questions has no single one.
  const intent = total === 1 && current !== undefined && current.intent?.kind === "plan-review"
    ? current.intent
    : null;

  /**
   * The document this review judges, as the sidebar addresses it.
   *
   * `callId` is what makes it reopenable: the plan lives in the transcript's
   * `exit_plan_mode` call and the tab finds it there by replaying one session.
   * A review with no call — an extension asking directly — has only its own
   * text, so the sidebar keeps that in memory under the request's own key, and
   * a reload is what makes it expire (dsh's temporary `plan-review` resource).
   */
  const planTarget: PlanReviewTarget | null =
    intent !== null && current?.detail !== undefined && current.detail.length > 0
      ? {
          ...(intent.callId === undefined ? {} : { callId: intent.callId }),
          ...(requestId === undefined ? {} : { requestId }),
          title: current.header ?? current.question,
          plan: current.detail,
        }
      : null;

  /**
   * Open that document without being asked, once.
   *
   * A plan is read at a column's width, and the review is the moment it matters
   * — dsh opens it from its own effect for the same reason. The ref is dsh's
   * `markOpened` memory: a close is not undone by a re-render. It stays unset
   * while the open did not land, so the first commit that can address a sidebar
   * is the one that opens it.
   */
  const planOpened = useRef(false);
  useEffect(() => {
    if (planTarget === null || onOpenPlan === undefined || planOpened.current) return;
    if (onOpenPlan(planTarget)) planOpened.current = true;
  }, [planTarget, onOpenPlan]);

  const deliver = async (decision: AskUserDecision): Promise<void> => {
    setBusy("cancelled" in decision ? "cancel" : "answer");
    setError(null);
    try {
      await onSubmit(decision);
      // The answer is in; the draft has nothing left to restore.
      if (draftKey !== undefined) clearQuestionDraft(draftKey);
      // Released rather than kept busy: the parent usually unmounts the card on
      // success, and if it does not (a question whose transcript has not
      // re-projected yet) the user should be able to retry instead of staring
      // at a disabled button with nothing said.
      setBusy(null);
    } catch (err) {
      setBusy(null);
      setError((err as Error).message);
    }
  };
  // The countdown effect closes over a decision, so it reads the latest handler
  // through a ref instead of re-subscribing on every render.
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  // The card owns the keyboard while it is up, and takes focus back when the
  // browser moves it on its own — the same reason the single-question card
  // does, and the same escape hatch: a pointer or key press always wins.
  useEffect(() => {
    // A plan review takes the card over entirely and owns its own keyboard.
    // A deferred answer is an optional editor, not a blocking dialog. It must
    // never take focus back from the composer or a newer live question.
    if (intent !== null || embedded) return;
    const focusTarget = (): HTMLElement | null =>
      cardRef.current?.querySelector<HTMLElement>("[data-focus-first]") ?? null;
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
  }, []);

  // Written on every change rather than on a debounce: the payload is one batch
  // of short strings, and waiting would only risk losing the last keystroke to a
  // reload — the exact case this store exists for.
  useEffect(() => {
    if (draftKey === undefined) return;
    writeQuestionDraft(draftKey, { index, drafts });
  }, [draftKey, index, drafts]);

  /**
   * The deadline is reported, not merely observed.
   *
   * A plain dialog that times out is settled by pi and the card just retires.
   * A batch is different: the tool records the outcome, and "nobody answered"
   * has to arrive as itself or the model reads silence as a declined question
   * and decides for the user. pi's own timer is deliberately later than this
   * one, so the report wins the race.
   */
  useEffect(() => {
    if (timeout === null) return;
    const deadline = Date.now() + timeout;
    const timer = window.setInterval(() => {
      const left = secondsLeft(deadline, Date.now());
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(timer);
        void deliverRef.current({ timedOut: true });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [requestId, timeout]);

  const cancel = (): void => {
    void deliver({ cancelled: true });
  };

  const updateDraft = (target: number, next: (value: AskUserDraft) => AskUserDraft): void => {
    setDrafts((current) => current.map((value, position) => (position === target ? next(value) : value)));
    setError(null);
  };

  /** Move on if there is somewhere to go, otherwise try to submit. */
  const advanceOrSubmit = (): void => {
    if (index < total - 1) {
      setIndex(index + 1);
      return;
    }
    submit();
  };

  const submit = (): void => {
    if (busy !== null) return;
    const payload = askUserAnswerPayload(questions, drafts);
    if (payload === null) {
      // A plan review's only text is the change request, so an empty field is
      // that — not an unanswered question of a batch.
      if (intent !== null) {
        setError(t("question.planChangesEmpty"));
        return;
      }
      // A batch is all-or-nothing, so a refused submit sends the user to the
      // question that is missing rather than leaving them to hunt for it.
      const missing = firstUnanswered(questions, drafts);
      if (missing >= 0) {
        setIndex(missing);
        setError(t("question.incomplete", { count: total - answered }));
      }
      return;
    }
    void deliver(payload);
  };

  const pick = (label: string): void => {
    if (current === undefined || disabled) return;
    updateDraft(index, (value) => toggleAskUserSelection(value, label, multiSelect));
    // A single choice is the whole answer, so it moves on the way dsh does. A
    // multi-select stays put: the user is still building the set.
    if (!multiSelect && index < total - 1) setIndex(index + 1);
  };

  const skip = (): void => {
    if (current === undefined || disabled) return;
    updateDraft(index, () => ({ selected: [], custom: "", skipped: true }));
    advanceOrSubmit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // An IME owns Escape while a candidate list is open: that key closes the
    // list, and cancelling the card on top of it would lose the answer.
    if (cancellable && event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      cancel();
      return;
    }
    if (disabled) return;
    // Number keys pick a row, matching the number the row already shows. They
    // must not fire while the free-text field has the caret.
    if (event.target instanceof HTMLTextAreaElement) return;
    const position = Number(event.key) - 1;
    if (!Number.isInteger(position) || position < 0 || position >= options.length) return;
    const option = options[position];
    if (option === undefined) return;
    event.preventDefault();
    pick(option.label);
  };

  /**
   * A submitted plan takes the card over instead of being drawn as a question.
   *
   * dsh's `QuestionComposer` does the same (`review === undefined ? QuestionFlow
   * : PlanReviewPanel`), and the reason is the reason the ask chrome above
   * exists at all: a pager, a skip and a submit are the parts of the card that
   * make sense for a batch of questions. On a plan they are either meaningless
   * or a second way to answer the same verdict — Skip sends the plan back as
   * "keep planning", and Submit refuses outright with nothing selected.
   */
  if (intent !== null && current !== undefined) {
    return (
      <PlanReviewPanel
        question={current}
        intent={intent}
        disabled={disabled}
        requesting={planChanges}
        error={error}
        embedded={embedded}
        cancellable={cancellable}
        {...(planTarget === null || onOpenPlan === undefined
          ? {}
          : {
              onOpenPlan: () => {
                onOpenPlan(planTarget);
              },
            })}
        changes={draft.custom}
        onChange={(text) => updateDraft(index, (value) => ({ ...value, custom: text, skipped: false }))}
        onApprove={() => {
          // One verdict is the whole card, so it is sent on the spot rather than
          // through a footer, because the verdict is what the button is.
          void deliver({ answers: [{ id: current.id, selected: [intent.approve] }] });
        }}
        onRequestChanges={() => {
          setPlanChanges((value) => !value);
          setError(null);
        }}
        onSubmitChanges={submit}
        onCancel={cancel}
      />
    );
  }

  const title = total > 1
    ? t("question.batch", { count: total })
    : titleProp !== undefined && titleProp.length > 0
      ? titleProp
      : questions[0]?.header ?? t("question.composer");
  const fieldPlaceholder = options.length > 0 ? t("question.other") : t("question.placeholder");

  return (
    <div className={clsx(card.wrap, embedded && styles.embeddedWrap)}>
      <section
        ref={cardRef}
        className={clsx(card.card, minimized && card.cardMinimized)}
        role="dialog"
        aria-label={title}
        data-question-id={requestId}
        onKeyDown={onKeyDown}
      >
        <header className={card.header}>
          <div className={card.heading}>
            <h2 className={card.title}>{title}</h2>
          </div>
          <div className={card.headerActions}>
            <span className={styles.progress} role="status">
              {t("question.progress", { index: Math.min(index + 1, total), total, answered })}
            </span>
            <button
              type="button"
              className={card.iconButton}
              aria-expanded={!minimized}
              aria-label={minimized ? t("question.expand") : t("question.collapse")}
              title={minimized ? t("question.expand") : t("question.collapse")}
              disabled={disabled}
              onClick={() => setMinimized((value) => !value)}
            >
              <span className={clsx(card.chevron, minimized && card.chevronUp)}>
                <Glyph name="chevronDown" size={14} />
              </span>
            </button>
            {cancellable ? (
              <button
                type="button"
                className={card.iconButton}
                aria-label={t("common.cancel")}
                title={t("question.cancelTitle")}
                disabled={disabled}
                onClick={cancel}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
        </header>

        {!minimized ? (
          <>
            <div className={card.body}>
              {current === undefined ? (
                // A batch the client cannot read — an older server, or a shape
                // this build does not know. Cancel stays reachable so the pi
                // process is never left blocked on a card with no body.
                <div className={card.detail}>{t("question.unreadable")}</div>
              ) : (
                <>
                  <div className={styles.questionHead}>
                    {current.header ? (
                      <div className={styles.questionHeadTitle}>{current.header}</div>
                    ) : null}
                    <div className={styles.questionText}>{current.question}</div>
                    {multiSelect ? <div className={styles.multiHint}>{t("question.multiHint")}</div> : null}
                  </div>

                  {current.detail ? (
                    <div className={card.detail}>
                      <Markdown text={current.detail} />
                    </div>
                  ) : null}

                  {options.length > 0 ? (
                    <div
                      className={card.options}
                      role={multiSelect ? "group" : "radiogroup"}
                      aria-label={current.question}
                    >
                      {options.map((option, position) => {
                        const { label, recommended } = parseRecommendedLabel(option.label);
                        const selected = draft.selected.includes(option.label);
                        return (
                          <button
                            type="button"
                            key={option.label}
                            data-focus-first={position === 0 ? "" : undefined}
                            role={multiSelect ? "checkbox" : "radio"}
                            aria-checked={selected}
                            className={clsx(card.option, selected && card.optionSelected)}
                            disabled={disabled}
                            onClick={() => pick(option.label)}
                          >
                            {multiSelect ? (
                              <span className={clsx(styles.mark, selected && styles.markChecked)} aria-hidden>
                                {selected ? "✓" : ""}
                              </span>
                            ) : (
                              <span className={card.number}>{position + 1}</span>
                            )}
                            <span className={card.optionCopy}>
                              <span className={card.optionLabel}>{label}</span>
                              {recommended ? <span className={card.badge}>{t("question.recommended")}</span> : null}
                              {option.description ? (
                                <span className={styles.optionDescription}>{option.description}</span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {options.length > 0 ? <div className={styles.otherLabel}>{t("question.other")}</div> : null}
                  <AnswerField
                    data-focus-first={options.length === 0 ? "" : undefined}
                    value={draft.custom}
                    placeholder={fieldPlaceholder}
                    disabled={disabled}
                    onChange={(event) => {
                      const custom = event.target.value;
                      updateDraft(index, (value) => ({ ...value, custom, skipped: false }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                      if (event.shiftKey) return;
                      event.preventDefault();
                      advanceOrSubmit();
                    }}
                  />
                </>
              )}
            </div>

            <footer className={card.footer}>
              <div className={card.hint} role="status">
                {remaining === null ? "" : t("question.autoCancel", { seconds: remaining })}
              </div>
              <div className={card.feedback} role="alert">
                {error}
              </div>
              <div className={styles.navActions}>
                <button type="button" className={card.secondary} disabled={disabled} onClick={skip}>
                  {t("question.skip")}
                </button>
                <button
                  type="button"
                  className={card.secondary}
                  disabled={disabled || index === 0}
                  onClick={() => setIndex((value) => Math.max(0, value - 1))}
                >
                  {t("question.prev")}
                </button>
                {index < total - 1 ? (
                  <button
                    type="button"
                    className={card.secondary}
                    disabled={disabled}
                    onClick={() => setIndex((value) => Math.min(total - 1, value + 1))}
                  >
                    {t("question.next")}
                  </button>
                ) : null}
                <button type="button" className={card.primary} disabled={disabled} onClick={submit}>
                  {busy === "answer" ? t("common.submitting") : t("common.submit")}
                </button>
              </div>
            </footer>
          </>
        ) : null}
      </section>
    </div>
  );
}

import { useEffect, useRef, type KeyboardEvent } from "react";
import clsx from "clsx";
import { useT } from "../../lib/app-state.ts";
import { ChevronIcon } from "../../components/icons.tsx";
import { StateDot } from "../../components/StateDot.tsx";
import type { AskUserQuestionIntent, AskUserQuestionItem } from "../../lib/types.ts";
import { AnswerField } from "./AnswerField.tsx";
import { planDescription, planTitleOf } from "./plan-review-text.ts";
import card from "./QuestionCard.module.css";
import styles from "./PlanReviewPanel.module.css";

/**
 * The card a submitted plan is decided on.
 *
 * dsh's `PlanReviewPanel`, and it takes the composer's seat over completely:
 * `QuestionComposer` hands this the whole card when the request carries a
 * `plan-review` intent, instead of drawing a question with a plan attached. The
 * two are different acts — a question is something to fill in, a plan is
 * something to judge — and every ask control is wrong here in its own way: a
 * pager describes a batch that does not exist, "skip" sends the plan back as
 * "keep planning", and "submit" refuses outright because no option was picked.
 *
 * What is left is the decision and the way into the document: a tinted strip
 * naming the kind of decision, the plan's own first line and paragraph, and the
 * two verdicts. The full plan is one click away in the right sidebar (dsh's
 * `reviewLink`) rather than unfolded in place — a document is read at a
 * column's width, and the review opens it there without being asked.
 *
 * It does not translate the approve label: it is the model's own option, it is
 * what goes back on the wire, and a translated button would send a string the
 * asker never offered.
 */
export interface PlanReviewPanelProps {
  question: AskUserQuestionItem;
  intent: AskUserQuestionIntent;
  disabled: boolean;
  /** Whether the user asked to write changes instead of approving. */
  requesting: boolean;
  /** A live failure to show in the footer, e.g. an empty change request. */
  error?: string | null;
  /** Drawn inside a strip rather than in the composer seat. */
  embedded?: boolean;
  /** Whether Escape dismisses the review; a live dialog has a process behind it. */
  cancellable?: boolean;
  /** Show the plan in the right sidebar. Absent when there is no sidebar to address. */
  onOpenPlan?: (() => void) | undefined;
  /** The change request being written, and where it is kept. */
  changes: string;
  onChange: (text: string) => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  onSubmitChanges: () => void;
  onCancel?: () => void;
}

export function PlanReviewPanel({
  question,
  intent,
  disabled,
  requesting,
  error = null,
  embedded = false,
  cancellable = false,
  onOpenPlan,
  changes,
  onChange,
  onApprove,
  onRequestChanges,
  onSubmitChanges,
  onCancel,
}: PlanReviewPanelProps) {
  const t = useT();
  const detail = question.detail ?? "";
  // The header is the asker's own title and normally the plan's first line
  // (plan mode names the review after the document); reading the document
  // itself is the fallback for an asker that described the request instead.
  const title = question.header?.trim() || planTitleOf(detail) || question.question;
  const description = planDescription(detail);
  const cardRef = useRef<HTMLElement>(null);

  /**
   * The card owns the keyboard while it is up, and takes focus back when the
   * browser moves it on its own — the same rule the question cards follow, and
   * the same escape hatch: a pointer or key press always wins.
   */
  useEffect(() => {
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

  // Opening the change request moves the caret into it: the click said what the
  // next thing to type is.
  useEffect(() => {
    if (!requesting) return;
    cardRef.current?.querySelector<HTMLElement>("[data-focus-first]")?.focus();
  }, [requesting]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // An IME owns Escape while a candidate list is open: that key closes the
    // list, and dismissing the review on top of it would lose the decision.
    if (cancellable && event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onCancel?.();
    }
  };

  return (
    <div className={clsx(card.wrap, embedded && styles.embeddedWrap)}>
      <section
        ref={cardRef}
        className={card.card}
        role="dialog"
        aria-label={question.question}
        aria-busy={disabled}
        data-plan-review={question.id}
        onKeyDown={onKeyDown}
      >
        <div className={styles.strip}>
          <StateDot state={disabled ? "ongoing" : "warning"} />
          <span className={styles.stripLabel}>{t("question.planReview")}</span>
          <div className={styles.stripActions}>
            {onOpenPlan === undefined ? null : (
              <button
                type="button"
                className={styles.open}
                title={t("plan.openInSidebar")}
                aria-label={t("plan.openInSidebar")}
                onClick={onOpenPlan}
              >
                {t("plan.viewFull")}
                <ChevronIcon className={styles.openChevron} width={14} height={14} />
              </button>
            )}
          </div>
        </div>

        <div className={styles.summary}>
          <h3 className={styles.title}>{title}</h3>
          {/* A plan that is only a heading has no summary to repeat. */}
          {description.length === 0 || description === title ? null : (
            <p className={styles.description}>{description}</p>
          )}
        </div>

        {requesting ? (
          <div className={styles.changes}>
            <AnswerField
              data-focus-first=""
              value={changes}
              placeholder={t("question.planChangesPlaceholder")}
              disabled={disabled}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                if (event.shiftKey) return;
                event.preventDefault();
                onSubmitChanges();
              }}
            />
          </div>
        ) : null}

        <div className={styles.footer}>
          <div className={styles.feedback} role="alert">
            {error}
          </div>
          <div className={styles.actions}>
            {requesting ? (
              <button type="button" className={card.primary} disabled={disabled} onClick={onSubmitChanges}>
                {t("question.planSendChanges")}
              </button>
            ) : null}
            <button
              type="button"
              className={card.secondary}
              aria-pressed={requesting}
              disabled={disabled}
              data-focus-first={requesting ? undefined : ""}
              onClick={onRequestChanges}
            >
              {t("question.planRequestChanges")}
            </button>
            <button type="button" className={card.primary} disabled={disabled} onClick={onApprove}>
              {intent.approve}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

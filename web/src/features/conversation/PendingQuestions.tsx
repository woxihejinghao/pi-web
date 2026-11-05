import { useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { useT } from "../../lib/app-state.ts";
import { QuestionComposer } from "./QuestionComposer.tsx";
import { answerMessageText, type PendingQuestion } from "./pending-questions.ts";
import styles from "./TodoPanel.module.css";

/**
 * The questions whose deadline passed and nobody answered, above the composer.
 *
 * A timed-out batch is not over: the agent was told to keep working, and the
 * question stays answerable (see `pending-questions.ts`). It does not get the
 * composer seat, though — nothing is blocked behind it, and taking the input
 * away from a user who has decided to do something else first would be wrong.
 * So it sits next to the plan strip instead: one line that says the questions
 * are still here, and the same card one click away.
 *
 * The strip reuses the plan's own styles on purpose. To the reader these are
 * two kinds of "the session still has something for you", stacked in the same
 * place, and a second visual language would suggest a difference that is not
 * there.
 */
export interface PendingQuestionsProps {
  questions: readonly PendingQuestion[];
  /** A live dialog owns the input seat; keep deferred editors folded meanwhile. */
  suspended?: boolean;
  /** Hand the composed reply back; the caller sends it as a user message. */
  onAnswer: (text: string) => Promise<void> | void;
}

export function PendingQuestions({ questions, suspended = false, onAnswer }: PendingQuestionsProps) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // One at a time, oldest first — the same rule the live card follows. A second
  // waiting batch is counted in the strip and becomes the card once the first
  // one is answered.
  const pending = questions[0];
  if (pending === undefined) return null;

  return (
    <div className={styles.dock}>
      <section className={styles.root} aria-label={t("question.pendingTitle")}>
        <div className={styles.body}>
          <button
            type="button"
            className={styles.header}
            aria-expanded={open && !suspended}
            disabled={suspended}
            onClick={() => setOpen((value) => !value)}
          >
            <span className={styles.lead} aria-hidden>
              <Glyph name="think" />
            </span>
            <span className={styles.title}>{t("question.pendingTitle")}</span>
            <span className={styles.progress}>
              {t("question.pendingCount", { count: questions.length })}
            </span>
            <span className={styles.chevron} aria-hidden>
              {/* The plan strip's outline chevron: both strips share this module,
                  so their disclosure marks are the same mark. */}
              <Glyph name="chevronDownOutline" className={open && !suspended ? undefined : styles.chevronCollapsed} />
            </span>
          </button>
          {open && !suspended ? (
            <QuestionComposer
              // Keyed by the call, so answering one batch and opening the next
              // starts from blank drafts instead of inheriting the last set.
              key={pending.callId}
              questions={pending.questions}
              embedded
              // Keyed by the call, so the draft survives a reload of a question
              // nothing is blocked behind.
              draftKey={pending.callId}
              // Nothing is blocked behind this card, so there is nothing to
              // cancel: closing the strip is the whole refusal, and the question
              // simply stays here.
              cancellable={false}
              onSubmit={(decision) => {
                if (!("answers" in decision)) return undefined;
                // The reply is composed here, where the questions and the
                // translator both are, so the caller only has to send text.
                return onAnswer(
                  answerMessageText(pending.callId, pending.questions, decision.answers, t),
                );
              }}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

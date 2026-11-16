import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { useStoreSelector } from "../../lib/store.ts";
import type { MessageKey } from "../../lib/i18n/index.ts";
import type { ToolCallBlock } from "../../lib/types.ts";
import { DisclosureRow } from "./DisclosureRow.tsx";
import { useDisclosureOpen } from "./use-disclosure-open.ts";
import { QuestionReviewCard } from "./QuestionReviewCard.tsx";
import { ToolCallRow } from "./ToolCallRow.tsx";
import { readSettledQuestion, type QuestionOutcome } from "./pending-questions.ts";
import type { ToolExecution } from "./useConversation.ts";
import styles from "./ToolCallRow.module.css";

/** Outcome → the one word the collapsed row shows. */
const OUTCOME_LABELS: Record<QuestionOutcome, MessageKey> = {
  answered: "question.outcome.answered",
  cancelled: "question.outcome.cancelled",
  "timed-out": "question.outcome.timedOut",
};

/**
 * One `ask_user_question` call as a disclosure row.
 *
 * The collapsed line is the only thing a settled question needs to say — what
 * became of it and how many questions it asked — and the answer itself is one
 * click away, read back as the same card that was answered rather than as the
 * tool result's JSON. Reusing the generic row's styles is deliberate: this sits
 * in the same list as every other tool call, and a second visual language would
 * suggest a difference that is not there.
 *
 * A result this build cannot read falls back to the generic row, which at least
 * shows the raw output; a card with no record to draw would be emptier than the
 * thing it replaced.
 */
export function QuestionRow({
  call,
  execution,
  cwd,
  home,
  defaultOpen = false,
}: {
  call: ToolCallBlock;
  execution: ToolExecution | undefined;
  cwd?: string | undefined;
  home?: string | undefined;
  /** Whether the answer card starts open — the verbose display opens every row. */
  defaultOpen?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useDisclosureOpen(defaultOpen);
  const record = readSettledQuestion(execution?.details);
  // A live question the user put away: the tool call has not recorded a result
  // yet, and this row is the way back to the card — dsh reopens a hidden panel
  // from the same place. Selecting the request object itself (not a fresh
  // object) keeps the subscription from re-rendering on every store write.
  const hidden = useStoreSelector(
    appStore,
    (state) =>
      state.pendingUiRequests.find(
        (item) => state.hiddenUiRequests[item.request.id] === true
          && item.request.callId === call.id,
      ) ?? null,
  );

  if (hidden !== null) {
    const deadline = hidden.request.expiresAt;
    const expired = typeof deadline === "number" && deadline <= Date.now();
    return (
      <div className={styles.root} data-variant="others" data-tool={call.name} data-state="running">
        <DisclosureRow
          rowClassName={styles.row}
          leadingClassName={styles.leading}
          titleClassName={styles.title}
          icon={<Glyph name="think" />}
          title={t("question.rowTitle")}
          open={false}
          expandable
          expandOnRowClick
          // Nothing expands in place: reopening puts the card back in the seat
          // it was closed from, countdown and drafts included.
          onToggle={() => actions.showUiRequest(hidden.request.id)}
          collapsedContent={
            <>
              <span className={styles.sep} aria-hidden />
              <span className={styles.summary}>
                {t(expired ? "question.outcome.timedOut" : "question.waiting")}
              </span>
            </>
          }
        />
      </div>
    );
  }

  if (record === null) {
    return (
      <ToolCallRow
        call={call}
        execution={execution}
        cwd={cwd}
        home={home}
        defaultOpen={defaultOpen}
      />
    );
  }

  const summary = `${t(OUTCOME_LABELS[record.outcome])} · ${t("question.pendingCount", {
    count: record.questions.length,
  })}`;

  return (
    <div className={styles.root} data-variant="others" data-tool={call.name} data-state="ok">
      <DisclosureRow
        rowClassName={styles.row}
        leadingClassName={styles.leading}
        titleClassName={styles.title}
        icon={<Glyph name="think" />}
        title={t("question.rowTitle")}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={
          <>
            <span className={styles.sep} aria-hidden />
            <span className={styles.summary}>{summary}</span>
          </>
        }
      >
        <div className={styles.bodyScroll}>
          <QuestionReviewCard record={record} />
        </div>
      </DisclosureRow>
    </div>
  );
}

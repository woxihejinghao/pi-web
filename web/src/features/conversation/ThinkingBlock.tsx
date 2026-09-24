import { useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { DisclosureRow } from "./DisclosureRow.tsx";
import { firstNonBlankLine, lastNonBlankLine } from "./row-model.ts";
import styles from "./ThinkingBlock.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * One reasoning block as dsh's Think row.
 *
 * The collapsed summary is deliberately line-dependent: while the block is
 * still streaming it tracks the *last* line with content, so the row reads as
 * live output rather than freezing on a sentence written thirty seconds ago.
 * Once settled it snaps back to the first line with content, which is the one
 * that states the intent. Blank lines are skipped either way — a reasoning
 * block routinely opens with one, and "思考 ·" with nothing after the dot looks
 * like a bug.
 *
 * `data-follow-end` drives the streaming case: the text is right-aligned and
 * allowed to overflow to the left, so new words appear at the trailing edge
 * instead of the whole line re-ellipsising on every token.
 */
export function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // pi emits empty reasoning blocks — interrupted thinking, or a turn where the
  // model returned none. An empty "思考 ·" row is pure noise, and the same guard
  // keeps the row from flickering in for a frame at the start of a stream.
  if (text.trim() === "") return null;

  const running = streaming ?? false;
  const summary = (running ? lastNonBlankLine(text) : firstNonBlankLine(text)).replaceAll("**", "");

  return (
    <div
      className={styles.root}
      data-variant="think"
      data-state={running ? "running" : "ok"}
      data-expanded={open || undefined}
    >
      {running ? <span className={styles.visuallyHidden}>{t("common.running")}</span> : null}

      <DisclosureRow
        rowClassName={styles.row}
        leadingClassName={styles.leading}
        titleClassName={styles.title}
        chevronClassName={styles.chevron}
        icon={<Glyph name="think" />}
        title={t("thinking.title")}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={
          <>
            <span className={styles.separator} aria-hidden />
            <span className={styles.summary} data-follow-end={running || undefined}>
              <span className={styles.summaryText}>{summary}</span>
            </span>
          </>
        }
      >
        <div className={styles.thinkBody}>{text}</div>
      </DisclosureRow>
    </div>
  );
}

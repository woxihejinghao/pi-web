import { useState, type ReactNode } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { DisclosureRow } from "./DisclosureRow.tsx";
import styles from "./TurnProcessGroup.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * A finished turn's process rows (thinking + tool calls) collapsed into one row,
 * used by the "compact" transcript display.
 *
 * Adapted from dsh's per-turn "process window". dsh builds that window out of a
 * paginated chunk list, so it also owns load states and an "answer anchor" for
 * deciding where the window sits; here the whole turn is already in memory, so
 * the only behaviour worth keeping is that the group is per finished turn and
 * starts collapsed.
 *
 * It renders through the same `DisclosureRow` every tool and reasoning row uses,
 * which is why it needs no styling of its own for the collapsed state.
 */
export function TurnProcessGroup({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <DisclosureRow
      className={styles.root}
      icon={<Glyph name="sparkle" size={14} />}
      title={t("turn.process")}
      open={open}
      expandable
      expandOnRowClick
      onToggle={() => setOpen((value) => !value)}
      collapsedContent={
        <>
          <span className={styles.sep} aria-hidden />
          <span className={styles.count}>{t("turn.processCount", { count })}</span>
        </>
      }
    >
      {/* Indented to line up with the reasoning body, so expanding the group
          reads as "the rows that were summarised", not a different list. */}
      <div className={styles.body}>{children}</div>
    </DisclosureRow>
  );
}

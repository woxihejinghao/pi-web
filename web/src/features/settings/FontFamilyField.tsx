import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/app-state.ts";
import { commitFontFamily, FONT_FAMILY_MAX_LENGTH } from "../../lib/font-family.ts";
import { SettingsInput } from "./SettingsRow.tsx";
import styles from "./SettingsRow.module.css";
/**
 * One `font-family` list, edited in place.
 *
 * The field owns a draft so typing does not write on every keystroke; blur and
 * Enter commit, Escape restores the stored list. What gets committed is the
 * normalized CSS list (`commitFontFamily`), and a draft that normalizes to the
 * stored value sends nothing.
 *
 * Empty is a real value: it removes the variable and the token sheet's composite
 * rule falls back to the built-in stack. The placeholder says "Default" for the
 * same reason — it is what the field shows when it is holding that empty value.
 */
export function FontFamilyField({
  title,
  description,
  value,
  onCommit,
}: {
  title: string;
  description: string;
  /** The stored, already-normalized list; `""` means the built-in stack. */
  value: string;
  onCommit: (value: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const saved = useRef(value);
  // The server's answer is authoritative: adopt it when it changes (a reload, a
  // rollback, another tab's write reaching this one through a settings refetch).
  useEffect(() => {
    saved.current = value;
    setDraft(value);
  }, [value]);
  const commit = (): void => {
    const next = commitFontFamily(draft, saved.current);
    if (next === null) {
      // A no-op blur, or Escape restoring the saved list: put the field back to
      // the exact stored shape without a request.
      setDraft(saved.current);
      return;
    }
    // Show the normalized list immediately; `onCommit` is optimistic in
    // `updateSettings`, so the request cannot make the field jump.
    setDraft(next);
    onCommit(next);
  };
  return (
    <div className={`${styles.row} ${styles.stacked}`}>
      <div className={styles.rowText}>
        <div className={styles.title}>{title}</div>
        <div className={styles.description}>{description}</div>
      </div>
      <SettingsInput
        value={draft}
        onChange={setDraft}
        onCommit={commit}
        onCancel={() => setDraft(saved.current)}
        label={title}
        placeholder={t("settings.fontFamily.placeholder")}
        maxLength={FONT_FAMILY_MAX_LENGTH}
      />
    </div>
  );
}
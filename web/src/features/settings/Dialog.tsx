import { useEffect } from "react";
import styles from "./Dialog.module.css";

/**
 * The dialog shell. Clicking the mask closes; clicking the panel does not, so
 * a stray click while typing an API key cannot discard it. Escape closes too,
 * but only when a close handler is passed — during a save it is omitted, so a
 * half-written file cannot be abandoned by a keypress.
 */
export function Dialog({
  onClose,
  label,
  children,
}: {
  onClose?: () => void;
  label: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (onClose === undefined) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={styles.mask}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/*
 * The overlay is a floating surface, so it gets a shadow rather than a hairline
 * border — the same rule the rest of this app follows for anything drawn above
 * the page, and the one visual place where dsh's own elevation token (which
 * carries a 0.5px ring) was deliberately dropped.
 */

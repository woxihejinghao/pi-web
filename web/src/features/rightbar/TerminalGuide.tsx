import { useEffect, useRef, useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import { useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { rightbarActions } from "./rightbar-state.ts";
import { terminalActions, terminalStore } from "./terminal-state.ts";
import styles from "./TerminalGuide.module.css";

/**
 * The card an empty pane offers instead of a sentence.
 *
 * dsh puts a "terminal" entry in the guide a blank right sidebar shows; the
 * shell choice hangs off it as a menu, so the common case (open the default
 * shell) is one click and the uncommon one (a different shell) is two. The
 * chosen program is remembered per session by the tab, not by this card.
 */
export function TerminalGuide({
  sessionPath,
  paneId,
  disabled,
  reason,
}: {
  sessionPath: string;
  paneId: string;
  disabled: boolean;
  reason?: string | undefined;
}) {
  const t = useT();
  const state = useStore(terminalStore);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The card is the first thing a blank pane shows, so it asks about the host
  // itself: a machine without node-pty should say so here, before a click.
  useEffect(() => {
    if (terminalStore.get().support === null) void terminalActions.probe().catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await terminalActions.loadShells(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const start = (shellPath?: string): void => {
    setOpen(false);
    rightbarActions.openTerminalTab(sessionPath, paneId, shellPath);
  };

  const shells = state.shells;

  return (
    <div className={styles.guide} ref={rootRef} data-rb-guide="terminal">
      <span className={styles.icon} aria-hidden>
        <Glyph name="terminal" size={18} />
      </span>
      <div className={styles.text}>
        <span className={styles.title}>{t("tab.terminal")}</span>
        <span className={styles.body}>{t("terminal.guideBody")}</span>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={disabled}
          title={disabled ? reason : undefined}
          onClick={() => {
            start();
          }}
        >
          {t("terminal.newTerminal")}
        </button>
        <button
          type="button"
          className={styles.chevron}
          aria-label={t("terminal.shellMenu")}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => {
            setOpen((value) => !value);
            if (!open) void load();
          }}
        >
          <svg width={10} height={10} viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={t("terminal.shellMenu")}>
          <div className={styles.menuLabel}>{t("terminal.shellMenu")}</div>
          {loading ? <div className={styles.note}>{t("terminal.shellsLoading")}</div> : null}
          {error !== null ? (
            <div className={styles.note}>
              {t("terminal.shellsFailed")}
              <button
                type="button"
                className={styles.retry}
                onClick={() => {
                  void load();
                }}
              >
                {t("terminal.retry")}
              </button>
            </div>
          ) : null}
          {!loading && error === null
            ? shells.map((shell) => (
                <button
                  key={shell.path}
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  onClick={() => {
                    start(shell.path);
                  }}
                >
                  <span>{shell.name}</span>
                  {state.defaultShell?.path === shell.path ? (
                    <span className={styles.badge}>{t("terminal.defaultShell")}</span>
                  ) : null}
                </button>
              ))
            : null}
          {!loading && error === null && shells.length === 0 ? (
            <div className={styles.note}>{t("terminal.shellsFailed")}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

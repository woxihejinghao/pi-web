import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { CheckIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { appStore, isDraftSession, useLanguage, useT } from "../../lib/app-state.ts";
import { useStore, useStoreSelector } from "../../lib/store.ts";
import type { MessageKey } from "../../lib/i18n/index.ts";
import { SettingsRow, SettingsSelect } from "../settings/SettingsRow.tsx";
import {
  approvalStore,
  changeApproval,
  changeSessionApproval,
  effectiveApprovalMode,
  refreshApprovals,
  type ApprovalMode,
} from "./approval-store.ts";
import styles from "./ApprovalControl.module.css";

/**
 * Mode names and their one-line explanations, as i18n keys.
 *
 * Maps rather than `approval.${mode}` template literals because the message
 * table is typed: a computed key would need a cast, and a cast is what lets a
 * renamed key go unnoticed until runtime. The order is the menu's order — the
 * least permissive first, the one with no review last.
 */
const MODES: readonly ApprovalMode[] = ["ask", "smart", "off"];

const MODE_NAME: Record<ApprovalMode, MessageKey> = {
  ask: "approval.ask",
  smart: "approval.smart",
  off: "approval.off",
};

const MODE_NOTE: Record<ApprovalMode, MessageKey> = {
  ask: "approval.askNote",
  smart: "approval.smartNote",
  off: "approval.offNote",
};

/**
 * One glyph per mode, dsh's own permission marks.
 *
 * The three presets dsh ships run narrowest to widest — read-only, workspace
 * write, full access — and the approval modes line up with them the same way,
 * which is why the shapes are reused rather than approximated: a shield with a
 * check for per-action confirmations, the shield with a list and pen for the
 * reviewer that may write inside the workspace, and the shield with a bang for
 * the mode that asks nothing.
 */
const MODE_GLYPH: Record<ApprovalMode, ReactNode> = {
  ask: <Glyph name="permissionReadOnly" size={16} />,
  smart: <Glyph name="permissionWorkspaceWrite" size={16} />,
  off: <Glyph name="permissionFullAccess" size={16} />,
};

/** The trigger's glyph while the policy cannot be read: no mode is in effect. */
const UNKNOWN_GLYPH = <Glyph name="sliders" size={16} />;

/**
 * Which actions need a person.
 *
 * Two scopes share one policy file. Settings edits the **default** — the mode a
 * session starts on. The composer edits **this session**: a new session inherits
 * the default, and switching the chip writes an override keyed by the session
 * file, which the gate reads again on its next tool call. A session with no file
 * yet (a draft, where nothing can be overridden) shows and writes the default,
 * which is the mode it will start on.
 *
 * In the composer the control is a chip ported from dsh's `PermissionSelect`:
 * transparent until hovered or open, a 16px mode glyph, and a menu that opens
 * upward over the model card's surface. The settings page keeps the labelled
 * row, because there the control is a setting rather than a piece of the input.
 */
export function ApprovalControl({ settings = false }: { settings?: boolean }) {
  const t = useT();
  const language = useLanguage();
  const state = useStore(approvalStore);
  const config = state.view?.config ?? null;
  const selectedSessionPath = useStoreSelector(appStore, (current) => current.selectedSessionPath);
  // A draft has no file for the gate to key on, so there is nothing to override.
  const sessionKey = selectedSessionPath === null || isDraftSession(selectedSessionPath) ? null : selectedSessionPath;
  const mode = effectiveApprovalMode(config, sessionKey);
  const overridden = sessionKey !== null && config?.sessions?.[sessionKey] !== undefined;

  const [model, setModel] = useState("");
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void refreshApprovals();
    const interval = window.setInterval(() => { if (!approvalStore.get().pending) void refreshApprovals(); }, 5000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => { setModel(config?.classifierModel ?? ""); }, [config?.classifierModel]);
  // The copy follows the interface language. This is a background write, so a
  // policy that cannot be read is never repaired from here — only an explicit
  // mode choice may do that.
  useEffect(() => {
    if (config && config.language !== language && !state.pending) void changeApproval({ language });
  }, [language, config?.language, state.pending]);

  // An outside pointer closes the menu and puts focus back where it came from,
  // so the keyboard user is not dropped at the top of the page.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const anchor = anchorRef.current;
      if (anchor !== null && event.target instanceof Node && anchor.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Opening hands focus to the row in effect — the menu is then answerable with
  // the arrow keys, Enter and Escape without a trip through the tab order.
  useEffect(() => {
    if (!open) return;
    const rows = menuRows();
    const current = rows.find(row => row.getAttribute("aria-checked") === "true");
    (current ?? rows[0] ?? menuRef.current)?.focus();
  }, [open]);

  // A write in flight disables the control; a menu left open over it would be
  // answering for a policy that is already changing.
  useEffect(() => {
    if (state.pending) setOpen(false);
  }, [state.pending]);

  function menuRows(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
  }

  /**
   * Write one mode in the scope this control edits.
   *
   * Every mode but Full access is a single click. Full access asks again —
   * wherever it is chosen, and in both scopes — because "no more questions" is
   * the one setting whose consequence is the absence of all later questions.
   */
  const applyMode = async (next: ApprovalMode): Promise<void> => {
    if (next === mode) return;
    if (next === "off" && !window.confirm(t("approval.confirmOff"))) return;
    if (sessionKey === null) await changeApproval({ mode: next, ...(next === "off" ? { confirmOff: true } : {}) });
    else await changeSessionApproval(sessionKey, next);
  };

  /** Drop this session's override; it follows the default again. */
  const followDefault = async (): Promise<void> => {
    if (sessionKey === null || config === null) return;
    await changeSessionApproval(sessionKey, null);
    triggerRef.current?.focus();
  };

  const selectMode = async (next: ApprovalMode): Promise<void> => {
    setOpen(false);
    triggerRef.current?.focus();
    await applyMode(next);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // Enter and Space are the button's own; only the arrows need teaching.
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpen(true);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    // Tabbing out is not an answer to anything; it just leaves the menu.
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = menuRows();
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : (index + delta + rows.length) % rows.length;
    rows[next]?.focus();
  };

  const currentName = mode === null ? t("approval.unavailable") : t(MODE_NAME[mode]);
  const disabled = state.pending || state.view === null;
  const defaultName = config === null ? t("approval.unavailable") : t(MODE_NAME[config.mode]);

  // The wait is a pill select, whose options are strings; a policy that holds a
  // wait outside the presets keeps its own row rather than rendering as an empty
  // pill.
  const timeout = config?.timeoutSeconds ?? 120;
  const timeoutOptions = [...new Set([30, 120, 300, timeout])]
    .sort((a, b) => a - b)
    .map(seconds => ({ value: String(seconds), label: t("approval.seconds", { seconds }) }));

  // No label of its own: the settings row already names this control, and a
  // second "default permission" beside the value reads as a second setting.
  const control = (
    <SettingsSelect label={t("approval.defaultMode")} value={config?.mode ?? ""} disabled={disabled}
      onChange={kind => {
        if (!kind) return;
        void (async () => {
          if (kind === "off" && !window.confirm(t("approval.confirmOff"))) return;
          await changeApproval({ mode: kind, ...(kind === "off" ? { confirmOff: true } : {}) });
        })();
      }}
      options={[
        ...(!config ? [{ value: "" as const, label: t("approval.unavailable") }] : []),
        { value: "ask" as const, label: t("approval.ask") },
        { value: "smart" as const, label: t("approval.smart") },
        { value: "off" as const, label: t("approval.off") },
      ]} />
  );

  const chip = (
    <span className={styles.anchor} ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        data-off={mode === "off" || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("approval.currentLabel", { name: currentName })}
        title={mode === null ? (state.error ?? t("approval.unavailable")) : t(MODE_NOTE[mode])}
        disabled={disabled}
        onClick={() => { setOpen(!open); }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.triggerIcon} aria-hidden>
          {mode === null ? UNKNOWN_GLYPH : MODE_GLYPH[mode]}
        </span>
        <span className={styles.triggerLabel}>{currentName}</span>
        <Glyph name="chevronDown" size={12} className={clsx(styles.chevron, open && styles.chevronOpen)} />
      </button>

      {open && mode !== null ? (
        <div
          ref={menuRef}
          className={styles.menu}
          role="menu"
          aria-label={t("approval.mode")}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
        >
          {MODES.map(kind => {
            const chosen = kind === mode;
            return (
              <button
                key={kind}
                type="button"
                role="menuitemradio"
                aria-checked={chosen}
                className={styles.option}
                onClick={() => { void selectMode(kind); }}
              >
                <span className={styles.optionIcon} aria-hidden>{MODE_GLYPH[kind]}</span>
                <span className={styles.optionText}>
                  <span className={styles.optionName}>{t(MODE_NAME[kind])}</span>
                  <span className={styles.optionNote}>{t(MODE_NOTE[kind])}</span>
                </span>
                <span className={styles.optionCheck} aria-hidden>
                  {chosen ? <CheckIcon width={14} height={14} /> : null}
                </span>
              </button>
            );
          })}
          {overridden ? (
            <>
              <span className={styles.divider} role="separator" />
              <button
                type="button"
                role="menuitemradio"
                aria-checked={false}
                className={styles.option}
                onClick={() => { setOpen(false); void followDefault(); }}
              >
                <span className={styles.optionIcon} aria-hidden><Glyph name="chevronsUpDown" size={16} /></span>
                <span className={styles.optionText}>
                  <span className={styles.optionName}>{t("approval.followDefault", { name: defaultName })}</span>
                  <span className={styles.optionNote}>{t("approval.followDefaultNote")}</span>
                </span>
                {/* The same check column the three modes reserve, so this row's
                    text ends where theirs does. */}
                <span className={styles.optionCheck} aria-hidden />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );

  if (!settings) {
    return (
      <span className={styles.inline}>
        {chip}
        {state.error ? <span className={styles.warning} role="alert" title={state.error}>{t("approval.unavailable")}</span> : null}
      </span>
    );
  }

  return (
    <div className={styles.settings}>
      {/* The scope, said once before any control: everything below sets the
          default, and the composer is where one session departs from it. */}
      <p className={styles.scope}>{t("approval.scopeNote")}</p>
      <SettingsRow title={t("approval.defaultMode")} description={t("approval.defaultModeNote")}>
        {control}
      </SettingsRow>
      {config?.mode === "off" ? <span className={styles.note} role="status">{t("approval.offWarning")}</span> : null}
      {state.error ? <span className={styles.warning} role="alert" title={state.error}>{t("approval.unavailable")}</span> : null}
      <SettingsRow title={t("approval.model")} description={t("approval.modelNote")}>
        <form className={styles.model} onSubmit={event => { event.preventDefault(); void changeApproval({ classifierModel: model.trim() || null }); }}>
          <input aria-label={t("approval.model")} value={model} placeholder="provider/model" onChange={event => setModel(event.target.value)} />
          <button type="submit" disabled={state.pending}>{t("common.save")}</button>
        </form>
      </SettingsRow>
      <SettingsRow title={t("approval.timeout")} description={t("approval.timeoutNote")}>
        <SettingsSelect label={t("approval.timeout")} value={String(timeout)} disabled={!config || state.pending}
          onChange={value => void changeApproval({ timeoutSeconds: Number(value) })}
          options={timeoutOptions} />
      </SettingsRow>
      <p className={styles.hint}>{t("approval.limit")}</p>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useLanguage, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { SettingsRow, SettingsSelect } from "../settings/SettingsRow.tsx";
import { approvalStore, changeApproval, refreshApprovals, type ApprovalMode } from "./approval-store.ts";
import styles from "./ApprovalControl.module.css";

/** One shared policy, whether changed from the composer or settings. */
export function ApprovalControl({ settings = false }: { settings?: boolean }) {
  const t = useT();
  const language = useLanguage();
  const state = useStore(approvalStore);
  const config = state.view?.config;
  const [model, setModel] = useState("");
  useEffect(() => {
    void refreshApprovals();
    const interval = window.setInterval(() => { if (!approvalStore.get().pending) void refreshApprovals(); }, 5000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => { setModel(config?.classifierModel ?? ""); }, [config?.classifierModel]);
  useEffect(() => {
    if (config && config.language !== language && !state.pending) void changeApproval({ language });
  }, [language, config?.language, state.pending]);
  const selectMode = async (mode: ApprovalMode) => {
    if (mode === "off" && !window.confirm(t("approval.confirmOff"))) return;
    await changeApproval({ mode, language, ...(mode === "off" ? { confirmOff: true } : {}) });
  };
  const control = (
    <label className={styles.control} data-off={config?.mode === "off" || undefined}>
      <span>{t("approval.title")}</span>
      <SettingsSelect label={t("approval.mode")} value={config?.mode ?? ""} disabled={state.pending || state.view === null}
        onChange={mode => { if (mode) void selectMode(mode); }}
        options={[
          ...(!config ? [{ value: "" as const, label: t("approval.unavailable") }] : []),
          { value: "ask" as const, label: t("approval.ask") },
          { value: "smart" as const, label: t("approval.smart") },
          { value: "off" as const, label: t("approval.off") },
        ]} />
    </label>
  );
  return (
    <div className={settings ? styles.settings : styles.inline}>
      {settings ? <SettingsRow title={t("approval.mode")} description={t("approval.description")}>{control}</SettingsRow> : control}
      {config?.mode === "off" ? <span className={styles.warning} role="status">{t("approval.offWarning")}</span> : null}
      {state.error ? <span className={styles.warning} role="alert" title={state.error}>{t("approval.unavailable")}</span> : null}
      {settings ? <>
        <SettingsRow title={t("approval.model")} description={t("approval.modelNote")}>
          <form className={styles.model} onSubmit={event => { event.preventDefault(); void changeApproval({ classifierModel: model.trim() || null }); }}>
            <input aria-label={t("approval.model")} value={model} placeholder="provider/model" onChange={event => setModel(event.target.value)} />
            <button type="submit" disabled={state.pending}>{t("common.save")}</button>
          </form>
        </SettingsRow>
        <SettingsRow title={t("approval.timeout")} description={t("approval.timeoutNote")}>
          <select aria-label={t("approval.timeout")} value={config?.timeoutSeconds ?? 120} disabled={!config || state.pending}
            onChange={event => void changeApproval({ timeoutSeconds: Number(event.currentTarget.value) })}>
            {[30, 120, 300].map(seconds => <option value={seconds} key={seconds}>{t("approval.seconds", { seconds })}</option>)}
          </select>
        </SettingsRow>
        <p>{t("approval.limit")}</p>
      </> : null}
    </div>
  );
}

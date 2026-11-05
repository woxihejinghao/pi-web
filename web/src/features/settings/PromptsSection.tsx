import { useEffect, useState } from "react";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { api } from "../../lib/api.ts";
import { useStore } from "../../lib/store.ts";
import type { PromptDocument, PromptsView } from "../../lib/types.ts";
import styles from "./PromptsSection.module.css";

export function PromptsSection({ className }: { className?: string }) {
  const t = useT();
  const state = useStore(appStore);
  const projectPath = state.projects.find((p) => p.id === state.selectedProjectId)?.path ?? null;
  const [view, setView] = useState<PromptsView | null>(null);
  const [scope, setScope] = useState<PromptDocument["scope"]>("global");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    void api.getPrompts(projectPath).then((next) => {
      setView(next);
      const selected = scope === "global" ? next.global : next.workspace;
      setDraft(selected?.content ?? "");
    }).catch((err: Error) => setError(err.message)).finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [projectPath]);

  const selected = scope === "global" ? view?.global : view?.workspace;
  const chooseScope = (next: PromptDocument["scope"]) => {
    setScope(next);
    setDraft(next === "global" ? view?.global.content ?? "" : view?.workspace?.content ?? "");
  };

  const save = () => {
    if (!selected || saving) return;
    setSaving(true);
    void api.savePrompt({ scope, content: draft, projectPath })
      .then((next) => {
        setView(next);
        setDraft((scope === "global" ? next.global : next.workspace)?.content ?? "");
        actions.setNotice(t("settings.prompts.saved"));
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className={className}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>{t("settings.prompts.eyebrow")}</div>
          <h1 className={styles.heading}>{t("settings.nav.prompts")}</h1>
        </div>
        <button type="button" className={styles.refresh} onClick={load} disabled={loading}>↻ {t("settings.prompts.refresh")}</button>
      </div>
      <p className={styles.lead}>{t("settings.prompts.lead")}</p>
      <div className={styles.tabs} role="tablist" aria-label={t("settings.nav.prompts")}>
        <button type="button" className={scope === "global" ? styles.tabActive : styles.tab} onClick={() => chooseScope("global")}>
          {t("settings.prompts.global")}
        </button>
        <button type="button" className={scope === "workspace" ? styles.tabActive : styles.tab} onClick={() => chooseScope("workspace")} disabled={projectPath === null}>
          {t("settings.prompts.workspace")}
        </button>
      </div>
      {loading ? <div className={styles.status}>{t("settings.prompts.loading")}</div> : error ? <div className={styles.error}>{error}</div> : selected ? (
        <section className={styles.editor}>
          <div className={styles.editorMeta}>
            <div>
              <div className={styles.editorTitle}>{selected.exists ? t("settings.prompts.active") : t("settings.prompts.create")}</div>
              <code>{selected.path}</code>
            </div>
            <span className={selected.active ? styles.badge : styles.badgeMuted}>{selected.active ? t("settings.prompts.loaded") : t("settings.prompts.newFile")}</span>
          </div>
          <textarea className={styles.textarea} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} placeholder={t("settings.prompts.placeholder")} aria-label={t("settings.prompts.editorLabel")} />
          <div className={styles.footer}>
            <span>{t("settings.prompts.restartHint")}</span>
            <button type="button" className={styles.save} onClick={save} disabled={saving}>{saving ? t("settings.prompts.saving") : t("common.save")}</button>
          </div>
        </section>
      ) : <div className={styles.status}>{t("settings.prompts.noWorkspace")}</div>}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { api } from "../../lib/api.ts";
import { useStore } from "../../lib/store.ts";
import type { SkillItem, SkillsView } from "../../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import styles from "./SkillsSection.module.css";

type Filter = "all" | "enabled" | "disabled";

export function SkillsSection({ className }: { className?: string }) {
  const t = useT();
  const state = useStore(appStore);
  const projectPath = state.projects.find((p) => p.id === state.selectedProjectId)?.path ?? null;
  const [view, setView] = useState<SkillsView | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState<"all" | "user" | "project">("all");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<SkillItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generation = useRef(0);
  const load = () => {
    const request = ++generation.current;
    setError(null);
    void api.getSkills(projectPath).then((next) => {
      if (request === generation.current) setView(next);
    }).catch((err: Error) => { if (request === generation.current) setError(err.message); });
  };
  useEffect(() => {
    const request = ++generation.current;
    setView(null);
    setError(null);
    setSelected(null);
    void api.getSkills(projectPath).then((next) => { if (request === generation.current) setView(next); })
      .catch((err: Error) => { if (request === generation.current) setError(err.message); });
    return () => { generation.current++; };
  }, [projectPath]);

  const items = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (view?.skills ?? []).filter((skill) =>
      (scope === "all" || skill.scope === scope) &&
      (filter === "all" || (filter === "enabled" ? skill.enabled : !skill.enabled)) &&
      (!normalized || `${skill.name} ${skill.description}`.toLowerCase().includes(normalized)),
    );
  }, [filter, query, scope, view]);

  const toggle = (skill: SkillItem) => {
    if (busy[skill.path]) return;
    const request = ++generation.current;
    setBusy((current) => ({ ...current, [skill.path]: true }));
    void api.setSkillEnabled({ path: skill.path, projectPath, enabled: !skill.enabled })
      .then((next) => { if (request === generation.current) setView(next); })
      .then(() => actions.setNotice(t(skill.enabled ? "settings.skills.disabledNotice" : "settings.skills.enabledNotice", { name: skill.name })))
      .catch((err: Error) => actions.setNotice(err.message))
      .finally(() => setBusy((current) => ({ ...current, [skill.path]: false })));
  };

  return (
    <div className={className}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>{t("settings.skills.eyebrow")}</div>
          <h1 className={styles.heading}>{t("settings.nav.skills")}</h1>
        </div>
        <button type="button" className={styles.refresh} onClick={load} disabled={view === null && !error}>
          ↻ {t("settings.skills.refresh")}
        </button>
      </div>
      <p className={styles.lead}>{t("settings.skills.lead")}</p>

      <div className={styles.tabs} role="tablist">
        {(["all", "user", "project"] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={scope === value}
            className={clsx(styles.tab, scope === value && styles.tabActive)} onClick={() => setScope(value)}>
            {t(value === "all" ? "settings.skills.all" : value === "user" ? "settings.skills.global" : "settings.skills.workspace")}
            <span>{view?.skills.filter((s) => value === "all" || s.scope === value).length ?? 0}</span>
          </button>
        ))}
      </div>
      <div className={styles.toolbar}>
        <div className={styles.search}><Glyph name="search" size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("settings.skills.search")} /></div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label={t("settings.skills.filter")}>
          <option value="all">{t("settings.skills.allStatus")}</option>
          <option value="enabled">{t("common.enabled")}</option>
          <option value="disabled">{t("common.disabled")}</option>
        </select>
      </div>

      {view?.projectPath && !view.projectTrusted && scope !== "user" ? <p className={styles.notice}>{t("settings.skills.untrusted")}</p> : null}
      {error || view?.error ? <div className={styles.empty}><strong>{t("settings.skills.failed")}</strong><span>{error ?? view?.error}</span><button type="button" onClick={load}>{t("common.retry")}</button></div> : view === null ? <div className={styles.empty}>{t("settings.skills.loading")}</div> : items.length === 0 ? <div className={styles.empty}><Glyph name="skill" size={28} /><span>{t("settings.skills.empty")}</span></div> : (
        <div className={styles.list}>
          {items.map((skill) => <SkillCard key={skill.path} skill={skill} busy={busy[skill.path] === true || (skill.scope === "project" && view.projectTrusted === false)} onToggle={() => toggle(skill)} onDetails={() => setSelected(skill)} t={t} />)}
        </div>
      )}

      {selected ? <Dialog label={selected.name} onClose={() => setSelected(null)} className={styles.modal}>
          <div className={styles.modalHeader}><div><div className={styles.modalKicker}>{t("settings.skills.detail")}</div><h2>{selected.name}</h2></div><button type="button" className={styles.close} onClick={() => setSelected(null)} aria-label={t("common.close")}>×</button></div>
          <p className={styles.modalDescription}>{selected.description}</p>
          <div className={styles.detailPath}><code>{selected.path}</code><button type="button" className={styles.detailButton} onClick={() => {
            void navigator.clipboard.writeText(selected.content)
              .then(() => actions.setNotice(t("common.copied")))
              .catch(() => actions.setNotice(t("common.copyFailed")));
          }}>{t("common.copy")}</button></div>
          <pre className={styles.content}>{selected.content}</pre>
      </Dialog> : null}
    </div>
  );
}

function SkillCard({ skill, busy, onToggle, onDetails, t }: { skill: SkillItem; busy: boolean; onToggle: () => void; onDetails: () => void; t: ReturnType<typeof useT> }) {
  return <article className={styles.card}>
    <div className={styles.cardIcon}><Glyph name="skill" size={20} /></div>
    <div className={styles.cardBody}><div className={styles.cardTitle}>{skill.name}</div><p>{skill.description}</p><div className={styles.meta}><span>{skill.scope === "project" ? t("settings.skills.workspace") : t("settings.skills.global")}</span><code>{skill.path.split("/").slice(-2).join("/")}</code></div></div>
    <div className={styles.cardActions}><span className={clsx(styles.status, skill.enabled ? styles.statusOn : styles.statusOff)}>{skill.enabled ? t("common.enabled") : t("common.disabled")}</span><button type="button" className={styles.detailButton} onClick={onDetails}>{t("settings.skills.view")}</button><button type="button" className={clsx(styles.switch, skill.enabled && styles.switchOn)} aria-pressed={skill.enabled} aria-label={t(skill.enabled ? "settings.skills.disable" : "settings.skills.enable", { name: skill.name })} onClick={onToggle} disabled={busy}><span /></button></div>
  </article>;
}

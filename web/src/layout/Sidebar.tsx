import { useState } from "react";
import clsx from "clsx";
import { Glyph } from "../components/dsh-icons.tsx";
import { PlusIcon, SearchIcon } from "../components/icons.tsx";
import { DirectoryPicker } from "../features/projects/DirectoryPicker.tsx";
import { ProjectTreeItem } from "../features/projects/ProjectTree.tsx";
import { actions, appStore, useT } from "../lib/app-state.ts";
import { buildProjectTree } from "../lib/project-tree.ts";
import { hasAnyUpdate } from "../lib/updates.ts";
import { useStore } from "../lib/store.ts";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const state = useStore(appStore);
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const tree = buildProjectTree(state.projects);
  const currentProject = state.projects.find((project) => project.id === state.selectedProjectId);
  // The user-scope answer, loaded at bootstrap: the badge is about the tool
  // itself, so it does not follow whichever workspace is selected.
  const updateAvailable = hasAnyUpdate(state.updates[""] ?? null);

  return (
    <div className={styles.sidebar}>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden>
          π
        </span>
        <span className={styles.brandName}>pi-web-simple</span>
      </div>

      <div className={styles.primaryAction}>
        <button
          type="button"
          className={styles.newSession}
          disabled={!currentProject}
          title={
            currentProject
              ? t("sidebar.newSessionIn", { title: currentProject.title })
              : t("sidebar.newSessionNoProject")
          }
          onClick={() => actions.enterNewSession()}
        >
          <PlusIcon />
          {t("sidebar.newSession")}
        </button>
      </div>

      <div className={styles.sectionHeader}>
        <span className={styles.sectionLabel}>{t("sidebar.workspaces")}</span>
        <div className={styles.sectionActions}>
          <button
            type="button"
            className={clsx(styles.iconButton, state.searchOpen && styles.iconButtonActive)}
            aria-label={t("sidebar.search")}
            title={t("sidebar.searchPlaceholder")}
            onClick={() => actions.toggleSearch()}
          >
            <SearchIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("sidebar.addWorkspace")}
            title={t("sidebar.addWorkspace")}
            onClick={() => setPickerOpen(true)}
          >
            <Glyph name="projectAdd" size={16} />
          </button>
        </div>
      </div>

      {state.searchOpen ? (
        <div className={styles.searchRow}>
          <input
            className={styles.searchInput}
            autoFocus
            spellCheck={false}
            value={state.sessionQuery}
            placeholder={t("sidebar.searchPlaceholder")}
            aria-label={t("sidebar.searchPlaceholder")}
            onChange={(event) => actions.setSessionQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") actions.toggleSearch();
            }}
          />
        </div>
      ) : null}

      <div className={styles.scroll}>
        {tree.length === 0 ? (
          <p className={styles.emptyList}>{t("sidebar.empty")}</p>
        ) : (
          tree.map((node) => <ProjectTreeItem key={node.project.id} node={node} />)
        )}
      </div>

      {}
      {}
      <div className={styles.footer}>
        <button
          type="button"
          className={styles.settingsTrigger}
          title={
            updateAvailable ? t("sidebar.settingsWithUpdate") : t("sidebar.settings")
          }
          onClick={actions.openSettings}
        >
          <Glyph name="settings" size={16} />
          {t("sidebar.settings")}
          {updateAvailable ? <span className={styles.updateDot} aria-hidden /> : null}
        </button>
      </div>

      <DirectoryPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={async (path) => {
          const project = await actions.addProject(path);
          // Failures surface as a notice; keep the picker open so the user can
          // choose a different directory.
          if (project) setPickerOpen(false);
        }}
      />
    </div>
  );
}

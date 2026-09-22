import { useState } from "react";
import clsx from "clsx";
import { Glyph } from "../components/dsh-icons.tsx";
import { PlusIcon, SearchIcon } from "../components/icons.tsx";
import { DirectoryPicker } from "../features/projects/DirectoryPicker.tsx";
import { ProjectTreeItem } from "../features/projects/ProjectTree.tsx";
import { actions, appStore } from "../lib/app-state.ts";
import { buildProjectTree } from "../lib/project-tree.ts";
import { hasAnyUpdate } from "../lib/updates.ts";
import { useStore } from "../lib/store.ts";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const state = useStore(appStore);
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
              ? `在「${currentProject.title}」中新建会话`
              : "先添加一个工作区"
          }
          onClick={() => actions.enterNewSession()}
        >
          <PlusIcon />
          新会话
        </button>
      </div>

      <div className={styles.sectionHeader}>
        <span className={styles.sectionLabel}>工作区</span>
        <div className={styles.sectionActions}>
          <button
            type="button"
            className={clsx(styles.iconButton, state.searchOpen && styles.iconButtonActive)}
            aria-label="搜索"
            title="搜索工作区和会话"
            onClick={() => actions.toggleSearch()}
          >
            <SearchIcon />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="添加工作区"
            title="添加工作区"
            onClick={() => setPickerOpen(true)}
          >
            <PlusIcon />
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
            placeholder="搜索工作区和会话"
            aria-label="搜索工作区和会话"
            onChange={(event) => actions.setSessionQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") actions.toggleSearch();
            }}
          />
        </div>
      ) : null}

      <div className={styles.scroll}>
        {tree.length === 0 ? (
          <p className={styles.emptyList}>还没有工作区。点击 + 选择一个本地目录。</p>
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
          title={updateAvailable ? "设置 · 有可用更新" : "设置"}
          onClick={actions.openSettings}
        >
          <Glyph name="settings" size={16} />
          设置
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

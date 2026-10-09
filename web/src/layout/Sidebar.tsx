import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Glyph } from "../components/dsh-icons.tsx";
import { DirectoryPicker } from "../features/projects/DirectoryPicker.tsx";
import { FlatSessionList } from "../features/projects/FlatSessionList.tsx";
import { ProjectTreeItem } from "../features/projects/ProjectTree.tsx";
import { ViewOptionsMenu } from "../features/projects/ViewOptionsMenu.tsx";
import { anchorBelow, type MenuAnchor } from "../features/projects/SidebarMenu.tsx";
import { useSidebarDrag } from "../features/projects/use-sidebar-drag.ts";
import { actions, appStore, useT } from "../lib/app-state.ts";
import { PI_MARK_URL } from "../lib/brand.ts";
import { buildProjectTree } from "../lib/project-tree.ts";
import { hasAnyUpdate } from "../lib/updates.ts";
import { useStore } from "../lib/store.ts";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const state = useStore(appStore);
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [viewMenuAt, setViewMenuAt] = useState<MenuAnchor | null>(null);
  const viewMenuButtonRef = useRef<HTMLButtonElement>(null);
  const groupBy = state.sidebarView.groupBy;
  // The grouping decides whether the tree nests, which is dsh's
  // `nestWorkspaces` switch; the rows themselves are the same either way.
  const tree = useMemo(
    () => buildProjectTree(state.projects, { nest: groupBy === "workspace-tree" }),
    [state.projects, groupBy],
  );
  // One drag surface for the whole column: a workspace can be dropped on a
  // header that belongs to a different tree node than the one it started in.
  const drag = useSidebarDrag(tree);
  const closeViewMenu = useCallback(() => setViewMenuAt(null), []);
  const currentProject = state.projects.find((project) => project.id === state.selectedProjectId);
  // The user-scope answer, loaded at bootstrap: the badge is about the tool
  // itself, so it does not follow whichever workspace is selected.
  const updateAvailable = hasAnyUpdate(state.updates[""] ?? null);

  const searchRootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // dsh grants the field focus every time it expands — including from the
  // collapsed icon's click, which is what makes that icon a real way in rather
  // than just a way to reveal the field.
  useEffect(() => {
    if (state.searchOpen) searchInputRef.current?.focus({ preventScroll: true });
  }, [state.searchOpen]);

  // A click outside blurs the field always, and closes it only when it is
  // empty: a query in force has to stay on screen, because a collapsed field
  // would leave the list filtered by something the user can neither see nor
  // clear. This is dsh's listener, `searchRootRef` guard and all.
  useEffect(() => {
    if (!state.searchOpen) return;
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || searchRootRef.current?.contains(event.target) === true) {
        return;
      }
      searchInputRef.current?.blur();
      if (state.sessionQuery.trim().length > 0) return;
      actions.closeSearch();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [state.searchOpen, state.sessionQuery]);

  return (
    <div className={styles.sidebar}>
      {/* macOS only (the rule hides it elsewhere): an empty strip above the
          brand that reserves the traffic lights' band and, through its
          `data-window-drag` mark, is the column's window-drag surface. See
          the `.topStrip` rule in Sidebar.module.css. */}
      <div className={styles.topStrip} data-window-drag aria-hidden />

      <div className={styles.brand} data-window-drag>
        <img className={styles.brandMark} src={PI_MARK_URL} alt="" draggable={false} />
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
          <Glyph name="newChatOutline" size={18} />
          {t("sidebar.newSession")}
        </button>
      </div>

      <div className={styles.sectionHeader}>
        {/* dsh's section header carries the search inline: expanding it
            collapses this label and the trailing actions and takes their room,
            so the field spans the row instead of opening a second one under
            it. */}
        <span
          className={clsx(styles.sectionLabel, state.searchOpen && styles.sectionLabelHidden)}
        >
          {t("sidebar.workspaces")}
        </span>
        <div className={clsx(styles.searchSlot, state.searchOpen && styles.searchSlotExpanded)}>
          <div
            ref={searchRootRef}
            className={clsx(styles.search, state.searchOpen && styles.searchExpanded)}
            onClick={() => {
              actions.openSearch();
              searchInputRef.current?.focus({ preventScroll: true });
            }}
          >
            <button
              type="button"
              className={styles.searchButton}
              aria-label={t("sidebar.search")}
              title={t("sidebar.search")}
              aria-expanded={state.searchOpen}
              onClick={() => actions.openSearch()}
            >
              <Glyph name="searchOutline" size={state.searchOpen ? 11 : 14} />
            </button>
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              type="text"
              spellCheck={false}
              value={state.sessionQuery}
              placeholder={t("sidebar.searchPlaceholder")}
              aria-label={t("sidebar.searchPlaceholder")}
              // No tab stop while collapsed: the icon is the field's one door.
              tabIndex={state.searchOpen ? 0 : -1}
              onChange={(event) => actions.setSessionQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") actions.closeSearch();
              }}
            />
            {state.searchOpen ? (
              <button
                type="button"
                className={styles.clearButton}
                aria-label={t("sidebar.clearSearch")}
                onClick={(event) => {
                  // The container's own click would re-open what this closes.
                  event.stopPropagation();
                  actions.closeSearch();
                }}
              >
                <Glyph name="closeFill" size={14} />
              </button>
            ) : null}
          </div>
        </div>
        <div
          className={clsx(styles.sectionActions, state.searchOpen && styles.sectionActionsHidden)}
        >
          <button
            type="button"
            ref={viewMenuButtonRef}
            className={styles.iconButton}
            aria-label={t("sidebar.viewOptions")}
            aria-haspopup="menu"
            aria-expanded={viewMenuAt !== null}
            title={t("sidebar.viewOptions")}
            onClick={() => {
              if (viewMenuAt !== null) {
                setViewMenuAt(null);
                return;
              }
              const anchor = anchorBelow(viewMenuButtonRef.current);
              if (anchor !== null) setViewMenuAt(anchor);
            }}
          >
            <Glyph name="sliders" size={16} />
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

      <div className={styles.scroll}>
        {state.projects.length === 0 ? (
          <p className={styles.emptyList}>{t("sidebar.empty")}</p>
        ) : groupBy === "flat" ? (
          <FlatSessionList drag={drag} />
        ) : (
          tree.map((node) => <ProjectTreeItem key={node.project.id} node={node} drag={drag} />)
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

      {viewMenuAt === null ? null : (
        <ViewOptionsMenu
          anchor={viewMenuAt}
          triggerRef={viewMenuButtonRef}
          onClose={closeViewMenu}
        />
      )}

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

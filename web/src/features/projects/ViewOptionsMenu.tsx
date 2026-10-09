import type { RefObject } from "react";
import clsx from "clsx";
import { Glyph, type GlyphName } from "../../components/dsh-icons.tsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import type { MessageKey } from "../../lib/i18n/index.ts";
import type { SessionGroupBy, SessionOrderBy } from "../../lib/sidebar-view.ts";
import { useStore } from "../../lib/store.ts";
import styles from "../../layout/Sidebar.module.css";
import { SidebarMenu, type MenuAnchor } from "./SidebarMenu.tsx";

interface GroupOption {
  id: SessionGroupBy;
  label: MessageKey;
  glyph: GlyphName;
}

interface OrderOption {
  id: SessionOrderBy;
  label: MessageKey;
  glyph: GlyphName;
}

/**
 * dsh's three groupings, in its order: sibling workspace sections, the nested
 * tree, then one list. The glyphs are the ones it puts beside each.
 */
const GROUP_OPTIONS: readonly GroupOption[] = [
  { id: "workspace", label: "sidebar.groupByWorkspace", glyph: "folderClose" },
  { id: "workspace-tree", label: "sidebar.groupByWorkspaceTree", glyph: "workspaceTree" },
  { id: "flat", label: "sidebar.groupByFlat", glyph: "flatList" },
];

const ORDER_OPTIONS: readonly OrderOption[] = [
  { id: "manual", label: "sidebar.orderByManual", glyph: "chevronsUpDown" },
  { id: "updated", label: "sidebar.orderByUpdated", glyph: "clock" },
];

/** One selectable row: glyph, label, and the trailing check the chosen one carries. */
function OptionRow({
  glyph,
  label,
  selected,
  onSelect,
}: {
  glyph: GlyphName;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={clsx(styles.projectMenuItem, styles.menuItemDense)}
      onClick={onSelect}
    >
      <span className={styles.menuItemIcon}>
        <Glyph name={glyph} size={14} />
      </span>
      <span className={styles.menuItemLabel}>{label}</span>
      {/* The check trails the label, so the selected row still reads as a row
          and the group's options stay left-aligned with each other. */}
      {selected ? <Glyph name="check" size={14} className={styles.menuCheck} /> : null}
    </button>
  );
}

/**
 * The sidebar's grouping and ordering, folded behind one trigger.
 *
 * dsh's `ViewOptionsMenu` (`ui-workspace/rows/WorkspaceBrowser.tsx`), minus its
 * archived-session group — this shell has no archive set, only the per-session
 * hide that removes a row from the list entirely. The two labelled groups and
 * their separation are carried over as they are.
 *
 * Selection is a radio: one grouping and one order at a time, and the menu
 * closes on pick the way dsh's does.
 */
export function ViewOptionsMenu({
  anchor,
  triggerRef,
  onClose,
}: {
  anchor: MenuAnchor;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const view = useStore(appStore).sidebarView;

  return (
    <SidebarMenu
      anchor={anchor}
      triggerRef={triggerRef}
      onClose={onClose}
      ariaLabel={t("sidebar.viewOptions")}
      className={styles.viewMenu}
    >
      <div className={styles.menuLabel} role="presentation">
        {t("sidebar.groupBy")}
      </div>
      {GROUP_OPTIONS.map((option) => (
        <OptionRow
          key={option.id}
          glyph={option.glyph}
          label={t(option.label)}
          selected={view.groupBy === option.id}
          onSelect={() => {
            onClose();
            actions.setGroupBy(option.id);
          }}
        />
      ))}

      <div className={styles.menuSeparator} role="separator" />

      <div className={styles.menuLabel} role="presentation">
        {t("sidebar.orderBy")}
      </div>
      {ORDER_OPTIONS.map((option) => (
        <OptionRow
          key={option.id}
          glyph={option.glyph}
          label={t(option.label)}
          selected={view.orderBy === option.id}
          onSelect={() => {
            onClose();
            actions.setOrderBy(option.id);
          }}
        />
      ))}
    </SidebarMenu>
  );
}

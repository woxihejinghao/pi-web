import { useState } from "react";
import clsx from "clsx";
import { Glyph, type GlyphName } from "../../components/dsh-icons.tsx";
import { actions } from "../../lib/app-state.ts";
import { GeneralSection } from "./GeneralSection.tsx";
import { ModelsSection } from "./ModelsSection.tsx";
import styles from "./SettingsPage.module.css";

type SectionId = "general" | "models";

/**
 * The nav rail. dsh's settings shell drives this from a slot registry that each
 * feature package registers into; here the two sections are the only ones that
 * exist, so the list is a literal. It is still a rail rather than a heading
 * because more sections (plugins, agent presets) are the obvious next additions
 * and a heading would have to be redone for them.
 *
 * Labels are dsh's, verbatim.
 */
const SECTIONS: readonly { id: SectionId; label: string; glyph: GlyphName }[] = [
  { id: "general", label: "通用设置", glyph: "settings" },
  { id: "models", label: "模型", glyph: "database" },
];

export function SettingsPage() {
  const [section, setSection] = useState<SectionId>("general");

  return (
    <div className={styles.page}>
      <nav className={styles.nav} aria-label="设置">
        <button type="button" className={styles.back} onClick={actions.closeSettings}>
          <Glyph name="chevronDown" size={14} className={styles.backArrow} />
          返回应用
        </button>
        <div className={styles.navList}>
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={clsx(
                styles.navCell,
                entry.id === section && styles.navCellActive,
              )}
              aria-current={entry.id === section ? "true" : undefined}
              onClick={() => setSection(entry.id)}
            >
              <Glyph name={entry.glyph} size={16} className={styles.navIcon} />
              <span className={styles.navLabel}>{entry.label}</span>
            </button>
          ))}
        </div>
      </nav>

      <div className={styles.content}>
        <div className={styles.inner}>
          {section === "general" ? (
            <GeneralSection className={styles.section} />
          ) : (
            <ModelsSection className={styles.section} />
          )}
        </div>
      </div>
    </div>
  );
}

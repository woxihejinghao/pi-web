import { useState } from "react";
import clsx from "clsx";
import { Glyph, type GlyphName } from "../../components/dsh-icons.tsx";
import { actions } from "../../lib/app-state.ts";
import { GeneralSection } from "./GeneralSection.tsx";
import { McpSection } from "./McpSection.tsx";
import { ModelsSection } from "./ModelsSection.tsx";
import { PluginsSection } from "./PluginsSection.tsx";
import styles from "./SettingsPage.module.css";
import { useT } from "../../lib/app-state.ts";
import type { Translate } from "../../lib/i18n/index.ts";

type SectionId = "general" | "models" | "plugins" | "mcp";

/**
 * The nav rail. dsh's settings shell drives this from a slot registry that each
 * feature package registers into; here the sections are a literal. It is still
 * a rail rather than a heading because more sections (agent presets) remain the
 * obvious next additions and a heading would have to be redone for them.
 *
 * Labels are dsh's, verbatim — including 插件 for the plugins section, which dsh
 * lists between 模型 and Agent 预设.
 */
/** The nav rail, built from `t` so the labels follow the language setting. */
function navSections(
  t: Translate,
): readonly { id: SectionId; label: string; glyph: GlyphName }[] {
  return [
    { id: "general", label: t("settings.nav.general"), glyph: "settings" },
    { id: "models", label: t("settings.nav.models"), glyph: "database" },
    { id: "plugins", label: t("settings.nav.plugins"), glyph: "plugin" },
  // dsh puts MCP beside 技能 inside its extension panel; here it is its own
    // section, because this page's navigation is flat and MCP is not a plugin.
    { id: "mcp", label: "MCP", glyph: "mcp" },
  ];
}

export function SettingsPage() {
  const t = useT();
  const [section, setSection] = useState<SectionId>("general");

  return (
    <div className={styles.page}>
      <nav className={styles.nav} aria-label={t("settings.nav.label")}>
        <button type="button" className={styles.back} onClick={actions.closeSettings}>
          <Glyph name="chevronDown" size={14} className={styles.backArrow} />
          {t("settings.nav.back")}
        </button>
        <div className={styles.navList}>
          {navSections(t).map((entry) => (
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
            <GeneralSection
              className={styles.section}
              onOpenPlugins={() => setSection("plugins")}
            />
          ) : section === "models" ? (
            <ModelsSection className={styles.section} />
          ) : section === "plugins" ? (
            <PluginsSection className={styles.section} />
          ) : (
            <McpSection className={styles.section} />
          )}
        </div>
      </div>
    </div>
  );
}

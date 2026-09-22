import { useState } from "react";
import clsx from "clsx";
import { Glyph, type GlyphName } from "../../components/dsh-icons.tsx";
import { actions } from "../../lib/app-state.ts";
import { GeneralSection } from "./GeneralSection.tsx";
import { McpSection } from "./McpSection.tsx";
import { ModelsSection } from "./ModelsSection.tsx";
import { PluginsSection } from "./PluginsSection.tsx";
import styles from "./SettingsPage.module.css";

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
const SECTIONS: readonly { id: SectionId; label: string; glyph: GlyphName }[] = [
  { id: "general", label: "通用设置", glyph: "settings" },
  { id: "models", label: "模型", glyph: "database" },
  { id: "plugins", label: "插件", glyph: "plugin" },
  // dsh puts MCP beside 技能 inside its extension panel; here it is its own
  // section, because this page's navigation is flat and MCP is not a plugin.
  { id: "mcp", label: "MCP", glyph: "mcp" },
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

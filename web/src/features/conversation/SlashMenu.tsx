import { Fragment, useEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import type { SlashCommand } from "../../lib/types.ts";
import { sourceLabels } from "./slash.ts";
import styles from "./SlashMenu.module.css";
import { useT } from "../../lib/app-state.ts";

export interface SlashMenuProps {
  matches: SlashCommand[];
  highlight: number;
  onHighlight(index: number): void;
  onSelect(command: SlashCommand): void;
}

interface Section {
  label: string;
  items: { command: SlashCommand; index: number }[];
}

/**
 * Candidate list for an in-progress `/command`, rendered above the composer.
 *
 * Commands are grouped under a heading per kind (扩展 / 模板 / 技能) rather than
 * tagged one by one — the flat `matches` order already puts equal matches
 * together, so the keyboard can walk a single index while the eye reads
 * sections.
 */
export function SlashMenu({ matches, highlight, onHighlight, onSelect }: SlashMenuProps) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    const out: Section[] = [];
    matches.forEach((command, index) => {
      const label = sourceLabels(t)[command.source];
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push({ command, index });
      else out.push({ label, items: [{ command, index }] });
    });
    return out;
  }, [matches]);

  // Keyboard navigation must not scroll the highlighted row out of view.
  useEffect(() => {
    viewportRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    <div className={styles.menu} role="listbox" aria-label={t("slash.commands")}>
      <div className={styles.viewport} ref={viewportRef}>
        {sections.map((section) => (
          <Fragment key={section.label}>
            <div className={styles.sectionTitle}>{section.label}</div>
            {section.items.map(({ command, index }) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === highlight}
                data-active={index === highlight}
                className={clsx(styles.item, index === highlight && styles.itemActive)}
                title={command.description ?? command.name}
                onMouseEnter={() => onHighlight(index)}
                // mousedown, not click: by click time the textarea has already
                // blurred and the caret position is gone.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(command);
                }}
              >
                <span className={styles.name}>{command.name}</span>
                {command.description ? (
                  <span className={styles.description}>{command.description}</span>
                ) : null}
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

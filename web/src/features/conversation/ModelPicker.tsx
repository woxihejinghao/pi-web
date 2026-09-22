import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { CheckIcon } from "../../components/icons.tsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import type { ComposerModel } from "../../lib/types.ts";
import styles from "./ModelPicker.module.css";

export interface ModelPickerProps {
  /** The model the session is on; null when it has not chosen one yet. */
  model: ComposerModel | null;
  /** null means "not known" — only a running pi can enumerate the choices. */
  models: ComposerModel[] | null;
  /** A live fetch is in flight (the cold start that learns the list). */
  loading: boolean;
  /** The menu was opened without a list; fetch one from a live pi. */
  onRequestModels(): void;
  onSelect(provider: string, id: string): void;
}

interface Item {
  model: ComposerModel;
  index: number;
}

interface Group {
  provider: string;
  items: Item[];
}

/**
 * The model name and its dropdown, sitting left of the context ring.
 *
 * The list can only come from a running pi (`get_available_models` is the
 * runtime's resolved view), so opening the menu on a session that was read from
 * disk pays one cold start — deliberately, at the moment the user asked to
 * switch, rather than on every session switch.
 *
 * Grouped by provider because that is how the models are configured and how the
 * settings page lists them; within a group the order is pi's, which is the order
 * `models.json` declares.
 */
export function ModelPicker({
  model,
  models,
  loading,
  onRequestModels,
  onSelect,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** True once the user moved the highlight themselves; the model list landing
   * later must not yank the selection away from them. */
  const navigatedRef = useRef(false);

  const flat = useMemo(() => models ?? [], [models]);
  const groups = useMemo(() => groupByProvider(flat), [flat]);

  // Close on an outside pointer, and put focus back where it came from so the
  // keyboard user is not dropped at the top of the page.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Keyboard navigation needs the highlighted row in view; the list can be
  // longer than its 320px window.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${String(highlight)}"]`)?.scrollIntoView({
      block: "nearest",
    });
  }, [open, highlight]);

  // Arrow keys only reach the list if it has focus, so opening it takes focus —
  // and marks the current model, so Enter re-selects it rather than whatever
  // happens to be first.
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  // The list usually arrives *after* the menu opens (a live fetch), so the
  // current model is marked once it lands — unless the user has already started
  // navigating, in which case moving the highlight would be a bug.
  useEffect(() => {
    if (!open) return;
    if (navigatedRef.current || flat.length === 0) return;
    const index = flat.findIndex((entry) => isCurrent(entry, model));
    if (index >= 0) setHighlight(index);
  }, [open, flat, model]);

  const openMenu = (): void => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    navigatedRef.current = false;
    setHighlight(Math.max(0, flat.findIndex((entry) => isCurrent(entry, model))));
    if (models === null) onRequestModels();
  };

  const choose = (entry: ComposerModel): void => {
    setOpen(false);
    buttonRef.current?.focus();
    if (isCurrent(entry, model)) return;
    onSelect(entry.provider, entry.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (flat.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      navigatedRef.current = true;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) => (current + delta + flat.length) % flat.length);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = flat[highlight];
      if (entry) choose(entry);
    }
  };

  const label = model === null ? "选择模型" : (model.name ?? model.id);

  return (
    <span className={styles.anchor} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`模型：${label}`}
        title={model === null ? "选择模型" : `${model.provider}/${model.id}`}
        onClick={openMenu}
      >
        <span className={styles.triggerLabel}>{label}</span>
        <Glyph name="chevronDown" size={12} />
      </button>

      {open ? (
        <div
          ref={listRef}
          className={styles.menu}
          role="listbox"
          aria-label="模型"
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <div className={styles.viewport}>
            {models === null ? (
              <div className={styles.empty}>{loading ? "正在载入模型列表…" : "模型列表不可用"}</div>
            ) : flat.length === 0 ? (
              <div className={styles.empty}>没有可用的模型。在设置 → 模型中添加。</div>
            ) : (
              groups.map((group) => (
                <Fragment key={group.provider}>
                  <div className={styles.groupTitle}>{group.provider}</div>
                  {group.items.map(({ model: entry, index }) => (
                    <button
                      key={`${entry.provider}/${entry.id}`}
                      type="button"
                      role="option"
                      aria-selected={index === highlight}
                      data-index={index}
                      className={clsx(styles.item, index === highlight && styles.itemActive)}
                      title={`${entry.provider}/${entry.id}`}
                      onMouseEnter={() => {
                        navigatedRef.current = true;
                        setHighlight(index);
                      }}
                      onClick={() => choose(entry)}
                    >
                      <span className={styles.itemName}>{entry.name ?? entry.id}</span>
                      <span className={styles.itemMeta}>
                        {entry.contextWindow > 0 ? `${formatWindow(entry.contextWindow)}` : null}
                        {isCurrent(entry, model) ? <CheckIcon width={14} height={14} /> : null}
                      </span>
                    </button>
                  ))}
                </Fragment>
              ))
            )}
          </div>
        </div>
      ) : null}
    </span>
  );
}

function isCurrent(entry: ComposerModel, model: ComposerModel | null): boolean {
  return model !== null && entry.provider === model.provider && entry.id === model.id;
}

function groupByProvider(models: ComposerModel[]): Group[] {
  const groups: Group[] = [];
  models.forEach((model, index) => {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.provider === model.provider) {
      last.items.push({ model, index });
    } else {
      groups.push({ provider: model.provider, items: [{ model, index }] });
    }
  });
  return groups;
}

/** Context windows are big and round; `1M` reads better than `1000000`. */
function formatWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) return `${String(Math.round(contextWindow / 100_000) / 10)}M`;
  if (contextWindow >= 1000) return `${String(Math.round(contextWindow / 1000))}K`;
  return String(contextWindow);
}

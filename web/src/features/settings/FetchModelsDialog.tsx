import { useMemo, useState } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import type { ProviderModelEntry } from "../../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import styles from "./FetchModelsDialog.module.css";

/**
 * Pick which of a provider's models to add to its catalog.
 *
 * Ported from dsh's fetch dialog, including the copy. Two behaviours are worth
 * noting because they are choices rather than consequences:
 *
 * Models already in the catalog are shown but not selectable. They are still on
 * screen so the list matches what the provider actually serves — a model the
 * user is looking for but cannot see reads as a failed fetch — and they are
 * unchecked because re-adding one would rewrite its entry, dropping any
 * hand-edited `contextWindow` or `cost` that was set on it.
 *
 * Select-all acts on the *filtered* rows rather than the whole list. With a
 * search typed, "全选" meaning "everything, including what you filtered out"
 * is a surprise the user discovers after saving.
 */
export function FetchModelsDialog({
  models,
  existing,
  onAdopt,
  onClose,
}: {
  models: ProviderModelEntry[];
  existing: string[];
  onAdopt: (selected: ProviderModelEntry[]) => void;
  onClose: () => void;
}) {
  const already = useMemo(() => new Set(existing), [existing]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return models;
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(needle) ||
        (model.name ?? "").toLowerCase().includes(needle),
    );
  }, [models, query]);

  const selectableIds = filtered.filter((m) => !already.has(m.id)).map((m) => m.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const adopt = (): void => {
    onAdopt(models.filter((model) => selected.has(model.id)));
  };

  return (
    <Dialog onClose={onClose} label="选择要添加的模型">
      <h2 className={styles.title}>选择要添加的模型</h2>
      <p className={styles.description}>以下是模型提供方的可用模型，勾选要添加的模型。</p>

      <div className={styles.searchWrap}>
        <Glyph name="search" size={14} className={styles.searchIcon} />
        <input
          className={styles.search}
          value={query}
          aria-label="搜索模型"
          placeholder="搜索模型"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className={styles.toolbar}>
        <span className={styles.count}>
          {selected.size} / {models.length}
        </span>
        <button
          type="button"
          className={styles.linkButton}
          disabled={selectableIds.length === 0}
          onClick={() =>
            setSelected((current) => {
              const next = new Set(current);
              // Acts on the visible rows: see the note above.
              if (allSelected) for (const id of selectableIds) next.delete(id);
              else for (const id of selectableIds) next.add(id);
              return next;
            })
          }
        >
          {allSelected ? "取消全选" : "全选"}
        </button>
      </div>

      <div className={styles.list}>
        {filtered.length === 0 ? (
          <p className={styles.empty}>没有匹配的模型。</p>
        ) : (
          filtered.map((model) => {
            const present = already.has(model.id);
            return (
              <label
                key={model.id}
                className={present ? `${styles.item} ${styles.itemPresent}` : styles.item}
              >
                <input
                  type="checkbox"
                  checked={present || selected.has(model.id)}
                  disabled={present}
                  onChange={() => toggle(model.id)}
                />
                <span className={styles.itemId}>{model.id}</span>
                {model.name !== undefined && model.name !== model.id && (
                  <span className={styles.itemName}>{model.name}</span>
                )}
                {present && <span className={styles.itemTag}>已在目录中</span>}
              </label>
            );
          })
        )}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.ghostButton} onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={selected.size === 0}
          onClick={adopt}
        >
          添加所选
        </button>
      </div>
    </Dialog>
  );
}

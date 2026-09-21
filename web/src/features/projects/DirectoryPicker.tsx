import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { ArrowUpIcon, CloseIcon, FolderIcon } from "../../components/icons.tsx";
import { api } from "../../lib/api.ts";
import type { DirListing, StartLocation } from "../../lib/types.ts";
import styles from "./DirectoryPicker.module.css";

export interface DirectoryPickerProps {
  open: boolean;
  onClose(): void;
  /** Called with an absolute path. The caller decides whether to close. */
  onSelect(path: string): void | Promise<void>;
}

/**
 * Directory picker backed by the local server.
 *
 * The browser cannot hand back an absolute path — `webkitdirectory` yields
 * relative paths and the File System Access API deliberately hides the real
 * location — so the folder listing comes from the same machine over `/api/fs`.
 */
export function DirectoryPicker({ open, onClose, onSelect }: DirectoryPickerProps) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [locations, setLocations] = useState<StartLocation[]>([]);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const load = useCallback(async (path?: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.listDirectories(path);
      setListing(next);
      setAddress(next.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setListing(null);
    setError(null);
    setChoosing(false);
    void load();
    void api.startLocations().then(setLocations).catch(() => setLocations([]));
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const onAddressKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void load(address);
  };

  const choose = async (): Promise<void> => {
    if (!listing) return;
    setChoosing(true);
    try {
      await onSelect(listing.path);
    } finally {
      setChoosing(false);
    }
  };

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="选择项目目录"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>选择项目目录</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </header>

        {locations.length > 0 ? (
          <div className={styles.locations}>
            {locations.map((location) => (
              <button
                key={location.path}
                type="button"
                className={styles.location}
                title={location.path}
                onClick={() => void load(location.path)}
              >
                {location.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className={styles.addressRow}>
          <input
            className={styles.address}
            value={address}
            spellCheck={false}
            aria-label="当前路径"
            placeholder="/absolute/path"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={onAddressKeyDown}
          />
          <button
            type="button"
            className={styles.go}
            onClick={() => void load(address)}
            disabled={busy}
          >
            跳转
          </button>
        </div>

        <div className={styles.list} role="listbox" aria-label="子目录">
          {listing?.parent ? (
            <button
              type="button"
              className={styles.entry}
              onClick={() => void load(listing.parent ?? undefined)}
            >
              <span className={clsx(styles.glyph, styles.glyphMuted)}>
                <ArrowUpIcon />
              </span>
              <span className={styles.entryName}>上级目录</span>
            </button>
          ) : null}

          {busy && !listing ? <p className={styles.hint}>载入中…</p> : null}
          {error ? <p className={styles.error}>{error}</p> : null}

          {listing && !error && listing.entries.length === 0 ? (
            <p className={styles.hint}>这个目录下没有子目录。</p>
          ) : null}

          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-selected={false}
              className={styles.entry}
              title={entry.path}
              onClick={() => void load(entry.path)}
            >
              <span className={styles.glyph}>
                <FolderIcon />
              </span>
              <span
                className={clsx(
                  styles.entryName,
                  entry.name.startsWith(".") && styles.entryNameDim,
                )}
              >
                {entry.name}
              </span>
            </button>
          ))}
        </div>

        <footer className={styles.footer}>
          <span className={styles.summary} title={listing?.path}>
            {listing ? listing.path : "—"}
          </span>
          <div className={styles.footerActions}>
            <button type="button" className={styles.secondary} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={!listing || choosing || busy}
              onClick={() => void choose()}
            >
              {choosing ? "添加中…" : "选择此目录"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

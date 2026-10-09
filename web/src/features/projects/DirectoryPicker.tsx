import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import clsx from "clsx";
import { ArrowUpIcon, CloseIcon, FolderIcon } from "../../components/icons.tsx";
import { api } from "../../lib/api.ts";
import { pathForFile } from "../../lib/desktop.ts";
import type { DirListing, StartLocation } from "../../lib/types.ts";
import { droppedFolder } from "./drop-path.ts";
import {
  draftDirectory,
  matchingEntries,
  pathSeparator,
  readDraft,
  type ScannedDirectory,
} from "./path-draft.ts";
import styles from "./DirectoryPicker.module.css";
import { useT } from "../../lib/app-state.ts";

/**
 * How long a typed directory part rests before the listing follows it.
 *
 * The address bar is a path draft the way dsh's editor is: typing deeper
 * descends and erasing a segment walks back up *under* the text, not after it.
 * The window absorbs the keystrokes that walk through intermediate parts —
 * every character of `/usr/lo` past the separator would otherwise be its own
 * scan — while staying short enough that a pause reads as "the list moved with
 * me".
 */
const DRAFT_FOLLOW_MS = 250;

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
 *
 * A folder dragged onto the dialog goes the other way: the shell's preload
 * bridge can name it (`pathForFile`), and the path lands in the address bar and
 * is opened in one step. In a plain browser there is still no path to fill in,
 * so a folder that is already in the current listing is entered by name — the
 * same gesture doing the closest thing it can mean.
 *
 * The address bar reads as a path draft (see `path-draft.ts`): its last segment
 * prefix-narrows the level the text names, and the listing follows the text's
 * directory part after a short rest, so typing a path and walking the list are
 * one gesture rather than two.
 */
export function DirectoryPicker({ open, onClose, onSelect }: DirectoryPickerProps) {
  const t = useT();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [locations, setLocations] = useState<StartLocation[]>([]);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  /** A folder is being held over the dialog; the drop target lights up. */
  const [dropping, setDropping] = useState(false);
  /** The last draft-following scan, so the text that produced a level is read as its own. */
  const scanned = useRef<ScannedDirectory | null>(null);
  /** Stale listing responses are dropped: a newer scan has already been asked for. */
  const requestSeq = useRef(0);

  const load = useCallback(async (path?: string, syncAddress = true): Promise<void> => {
    const seq = ++requestSeq.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.listDirectories(path);
      if (seq !== requestSeq.current) return;
      const requested = path?.trim();
      // Only a draft-following scan needs this bookkeeping, and it is what makes
      // `~` or a relative part narrow the level it actually landed on.
      if (!syncAddress && requested) {
        const directory = draftDirectory(requested, pathSeparator(next.path));
        scanned.current = directory === null ? null : { directory, landed: next.path };
      }
      setListing(next);
      if (syncAddress) setAddress(next.path);
    } catch (err) {
      if (seq === requestSeq.current) setError((err as Error).message);
    } finally {
      if (seq === requestSeq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setListing(null);
    setError(null);
    setChoosing(false);
    setDropping(false);
    scanned.current = null;
    requestSeq.current += 1;
    void load();
    void api.startLocations().then(setLocations).catch(() => setLocations([]));
  }, [open, load]);

  // The listing follows the draft's directory part once typing rests. A level
  // the text already answers is left alone — it is either the level on screen
  // or the one a scan just landed, and re-asking would move the view twice for
  // one keystroke.
  useEffect(() => {
    if (!open || !listing) return;
    const { directory, tail } = readDraft(listing, address, scanned.current);
    if (directory === null || tail !== null) return;
    const timer = window.setTimeout(() => { void load(directory, false); }, DRAFT_FOLLOW_MS);
    return () => { window.clearTimeout(timer); };
  }, [open, listing, address, load]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  // What the address bar means right now: the tail that narrows the level on
  // screen. Outside the level the text names, the rows hold still until the
  // scan lands — narrowing a stale level would move the view twice.
  const { tail } = listing ? readDraft(listing, address, scanned.current) : { tail: null };
  const rows = listing ? matchingEntries(listing.entries, tail) : [];

  const onAddressKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void load(address);
  };

  const openDropped = async (data: DataTransfer): Promise<void> => {
    const folder = droppedFolder(data);
    if (!folder) return;
    const file = data.files[folder.index];
    const path = file ? pathForFile(file) : null;
    if (path) {
      setAddress(path);
      await load(path);
      return;
    }
    // No shell, so no path: entering a folder the drop itself names is the one
    // reading of the gesture a browser can still honour.
    const match = listing?.entries.find((entry) => entry.name === folder.name);
    if (match) {
      setAddress(match.path);
      await load(match.path);
      return;
    }
    setError(t("picker.dropNoPath"));
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    // Text and links dragged over the dialog are not this feature's business.
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    // Crossing onto a child fires `dragleave` here too; `relatedTarget` is what
    // tells that apart from actually leaving the dialog.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropping(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    // A file or folder dropped anywhere in the page would otherwise make the
    // browser open it, which reads as the dialog losing its place.
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDropping(false);
    void openDropped(event.dataTransfer);
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
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={onClose}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={clsx(styles.dialog, dropping && styles.dialogDropping)}
        role="dialog"
        aria-modal="true"
        aria-label={t("picker.title")}
        onClick={(event) => event.stopPropagation()}
      >
        {dropping ? (
          <div className={styles.dropOverlay} aria-hidden>
            <span className={styles.dropHint}>{t("picker.dropHint")}</span>
          </div>
        ) : null}
        <header className={styles.header}>
          <h2 className={styles.title}>{t("picker.title")}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label={t("settings.autoCompaction.off")}>
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
            aria-label={t("picker.currentPath")}
            placeholder="/absolute/path"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={onAddressKeyDown}
          />
          <button
            type="button"
            className={styles.go}
            onClick={() => void load(address)}
            disabled={busy}
          >{t("picker.go")}</button>
        </div>

        <div className={styles.list} role="listbox" aria-label={t("picker.subdirs")}>
          {listing?.parent ? (
            <button
              type="button"
              className={styles.entry}
              onClick={() => void load(listing.parent ?? undefined)}
            >
              <span className={clsx(styles.glyph, styles.glyphMuted)}>
                <ArrowUpIcon />
              </span>
              <span className={styles.entryName}>{t("picker.parent")}</span>
            </button>
          ) : null}

          {busy && !listing ? <p className={styles.hint}>{t("picker.loading")}</p> : null}
          {error ? <p className={styles.error}>{error}</p> : null}

          {listing && !error && listing.entries.length === 0 ? (
            <p className={styles.hint}>{t("picker.empty")}</p>
          ) : null}

          {rows.map((entry) => (
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
            <button type="button" className={styles.secondary} onClick={onClose}>{t("common.cancel")}</button>
            <button
              type="button"
              className={styles.primary}
              disabled={!listing || choosing || busy}
              onClick={() => void choose()}
            >
              {choosing ? t("picker.adding") : t("picker.choose")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

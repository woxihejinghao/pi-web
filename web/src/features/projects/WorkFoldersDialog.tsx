import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../lib/api.ts";
import { useT } from "../../lib/app-state.ts";
import { DirectoryPicker } from "./DirectoryPicker.tsx";
import styles from "./DirectoryPicker.module.css";
import folderStyles from "./WorkFoldersDialog.module.css";

/** Explicit association only: picking/unlinking never moves or deletes files. */
export function WorkFoldersDialog({ open, sessionPath, onClose }: {
  open: boolean; sessionPath: string; onClose(): void;
}) {
  const t = useT();
  const [folders, setFolders] = useState<string[]>([]);
  const [root, setRoot] = useState("~/pi/workspace");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    setPicking(false);
    void api.getWorkFolders(sessionPath).then((view) => {
      if (!cancelled) { setFolders(view.workFolders); setRoot(view.root); }
    }).catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [open, sessionPath]);
  useEffect(() => {
    if (!open || picking || busy) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, picking, busy, onClose]);
  if (!open) return null;
  const save = async (paths: string[]): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const view = await api.setWorkFolders(sessionPath, paths);
      setFolders(view.workFolders);
      return true;
    } catch (err) { setError((err as Error).message); return false; }
    finally { setBusy(false); }
  };
  if (picking) return createPortal(<DirectoryPicker open initialPath={root} onClose={() => setPicking(false)} onSelect={async (path) => {
    if (!window.confirm(t("session.workFolders.associateConfirm", { path }))) return;
    await save([...folders, path]);
    setPicking(false);
  }} />, document.body);
  return createPortal(
    <div className={styles.backdrop} onClick={() => { if (!busy) onClose(); }}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={t("session.workFolders.title")} onClick={(event) => event.stopPropagation()}>
        <header className={styles.header}>
          <h2 className={styles.title}>{t("session.workFolders.title")}</h2>
          <button type="button" disabled={busy} onClick={onClose} className={styles.secondary}>{t("common.close")}</button>
        </header>
        <p className={folderStyles.help}>{t("session.workFolders.description")}</p>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <ul className={folderStyles.list}>
          {folders.map((path) => <li key={path} className={folderStyles.row}>
            <span className={folderStyles.path}>{path}</span>
            <button type="button" className={styles.secondary} disabled={busy} aria-label={t("session.workFolders.unlinkLabel", { path })}
              onClick={() => void save(folders.filter((folder) => folder !== path))}>{t("session.workFolders.unlink")}</button>
          </li>)}
        </ul>
        {!folders.length && !busy ? <p className={folderStyles.help}>{t("session.workFolders.empty")}</p> : null}
        <button type="button" className={styles.primary} disabled={busy} onClick={() => setPicking(true)}>{t("session.workFolders.add")}</button>
      </section>
    </div>,
    document.body,
  );
}

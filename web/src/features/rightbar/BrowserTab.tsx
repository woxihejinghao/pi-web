import { useEffect, useState, type FormEvent } from "react";
import clsx from "clsx";
import { RefreshIcon } from "../../components/icons.tsx";
import { ExternalIcon, BackIcon, ForwardIcon } from "./rightbar-icons.tsx";
import { normalizeUrl, rightbarActions, type RightbarTab } from "./rightbar-state.ts";
import pane from "./Pane.module.css";
import styles from "./BrowserTab.module.css";

/**
 * A sandboxed page beside the conversation — a local dev server, most of the
 * time.
 *
 * The carrier is an iframe with application-managed history, as in dsh's Web
 * client: two entries of it are ours (the address bar and the toolbar's
 * back/forward), and the page inside is not given access to this app. Sites
 * that refuse framing simply do not render — the external-browser action is the
 * way out of that, not a proxy.
 */
export function BrowserTab({ sessionPath, tab }: { sessionPath: string; tab: RightbarTab }) {
  const [draft, setDraft] = useState(tab.target);
  const [error, setError] = useState<string | null>(null);
  const [sandboxed, setSandboxed] = useState(true);
  // Remounting the frame is the only reload a cross-origin page permits.
  const [frameKey, setFrameKey] = useState(0);

  // Adopt an address that arrived from somewhere else: a link activation, or a
  // back/forward step.
  useEffect(() => {
    setDraft(tab.target);
    setError(null);
  }, [tab.target]);

  const history = tab.history ?? [];
  const index = tab.historyIndex ?? -1;
  const canBack = index > 0;
  const canForward = index >= 0 && index < history.length - 1;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const url = normalizeUrl(draft);
    if (url === null) {
      setError("请输入 http(s) 网址，例如 localhost:5173");
      return;
    }
    setError(null);
    rightbarActions.navigateBrowser(sessionPath, tab.id, url);
  };

  return (
    <div className={pane.pane}>
      <div className={pane.header}>
        <button
          type="button"
          className={pane.action}
          disabled={!canBack}
          title="后退"
          aria-label="后退"
          onClick={() => rightbarActions.stepBrowserHistory(sessionPath, tab.id, -1)}
        >
          <BackIcon width={14} height={14} />
        </button>
        <button
          type="button"
          className={pane.action}
          disabled={!canForward}
          title="前进"
          aria-label="前进"
          onClick={() => rightbarActions.stepBrowserHistory(sessionPath, tab.id, 1)}
        >
          <ForwardIcon width={14} height={14} />
        </button>
        <button
          type="button"
          className={pane.action}
          disabled={tab.target.length === 0}
          title="重新载入"
          aria-label="重新载入页面"
          onClick={() => setFrameKey((value) => value + 1)}
        >
          <RefreshIcon width={14} height={14} />
        </button>
      </div>

      <form className={styles.addressRow} onSubmit={submit}>
        <input
          className={clsx(styles.address, error !== null && styles.addressInvalid)}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder="输入网址，例如 localhost:5173"
          aria-label="网址"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className={styles.go} disabled={draft.trim().length === 0}>
          打开
        </button>
        <button
          type="button"
          className={pane.action}
          disabled={tab.target.length === 0}
          title="在系统浏览器中打开"
          aria-label="在系统浏览器中打开"
          onClick={() => {
            // `noopener` keeps the opened page from reaching back into this app
            // through `window.opener`.
            window.open(tab.target, "_blank", "noopener,noreferrer");
          }}
        >
          <ExternalIcon width={14} height={14} />
        </button>
      </form>

      {error !== null ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.frameWrap}>
        {tab.target.length === 0 ? (
          <div className={styles.empty}>
            输入网址打开网页，例如 <code>localhost:5173</code>。
          </div>
        ) : (
          <iframe
            key={frameKey}
            className={styles.frame}
            src={tab.target}
            title={tab.title}
            // Same sandbox dsh uses: scripts and forms run, popups escape, and
            // the page gets no download or top-navigation flag. Turning it off
            // is temporary and per view, for a site that refuses to run inside
            // a sandbox at all.
            sandbox={
              sandboxed
                ? "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                : undefined
            }
            referrerPolicy="no-referrer"
          />
        )}
      </div>

      <div className={styles.statusBar}>
        <button
          type="button"
          className={clsx(styles.sandboxToggle, !sandboxed && styles.sandboxOff)}
          aria-pressed={!sandboxed}
          title={sandboxed ? "关闭沙箱（仅本次）" : "重新启用沙箱"}
          onClick={() => setSandboxed((value) => !value)}
        >
          {sandboxed ? "已启用沙箱" : "沙箱已关闭"}
        </button>
        <span className={styles.hint}>部分站点禁止被嵌入，可改用系统浏览器打开。</span>
      </div>
    </div>
  );
}

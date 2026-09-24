import { useEffect, useState } from "react";
import clsx from "clsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import {
  extensionUpdateCount,
  extensionUpdateStatus,
  piVersionStatus,
} from "../../lib/updates.ts";
import { SettingsGroup, SettingsRow } from "./SettingsRow.tsx";
import styles from "./UpdateSection.module.css";

/**
 * The update notices, at the bottom of 通用设置.
 *
 * Two rows, because they are two different facts with two different remedies.
 * **pi itself** is an npm dependency of this server: a newer release moves with
 * the lockfile and takes a server restart, so the row reports the version and
 * offers its command to copy rather than a button that would have to half-do
 * the job. **Packages** move through pi's own manager, which the plugins page
 * already does per row — so this row counts them and points there.
 *
 * Neither check is run from the browser: the server owns both, and its short
 * cache means visiting the page does not spawn a check per package. The 检查更新
 * button is the explicit "ask upstream again".
 */
export function UpdateSection({
  projectPath,
  onOpenPlugins,
}: {
  projectPath: string | null;
  onOpenPlugins?: () => void;
}) {
  const t = useT();
  const state = useStore(appStore);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  // Same slot the plugins page writes, so both pages agree and neither refetches
  // on switch. Keyed by workspace: the user-scope answer lives under "".
  const view = state.updates[projectPath ?? ""] ?? null;
  const info = view?.pi ?? null;
  const count = extensionUpdateCount(view);

  useEffect(() => {
    if (view === null) void actions.loadUpdates(projectPath);
  }, [projectPath, view]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const check = (): void => {
    setChecking(true);
    void actions.loadUpdates(projectPath, { force: true }).finally(() => setChecking(false));
  };

  const copyCommand = (): void => {
    const command = info?.updateCommand ?? "";
    if (command.length === 0) return;
    // The clipboard API rejects on a non-secure origin; the shell is served
    // over plain http on localhost, which browsers do treat as secure, but the
    // rejection is still handled so a failure is not a silent no-op.
    void navigator.clipboard
      .writeText(command)
      .then(() => setCopied(true))
      .catch(() => actions.setNotice(command));
  };

  return (
    <SettingsGroup title="关于">
      <SettingsRow
        title="pi 版本"
        description={`这个 Web UI 通过 npm 依赖接入的 pi 内核（${info?.packageName ?? "@earendil-works/pi-coding-agent"}）`}
      >
        <div className={styles.control}>
          <span className={styles.version}>{info?.current ?? "—"}</span>
          <span
            className={clsx(
              styles.status,
              info !== null && info.available && styles.statusNew,
              info !== null && info.error !== null && styles.statusError,
            )}
          >
            {piVersionStatus(info, t)}
          </span>
          {info !== null && info.available ? (
            <button
              type="button"
              className={styles.action}
              title={info.updateCommand}
              onClick={copyCommand}
            >
              {copied ? "已复制" : "复制更新命令"}
            </button>
          ) : null}
          <button type="button" className={styles.ghost} disabled={checking} onClick={check}>
            {checking ? "检查中…" : "检查更新"}
          </button>
        </div>
      </SettingsRow>

      <SettingsRow title="插件更新" description="已安装 pi 包与上游版本的比较">
        <div className={styles.control}>
          <span className={clsx(styles.status, count > 0 && styles.statusNew)}>
            {extensionUpdateStatus(view, t)}
          </span>
          {count > 0 && onOpenPlugins !== undefined ? (
            <button type="button" className={styles.ghost} onClick={onOpenPlugins}>
              去插件页
            </button>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}

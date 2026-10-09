import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { RefreshIcon } from "../../components/icons.tsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import type { McpProbeResult, McpServerView, McpView } from "../../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import { McpServerEditor } from "./McpServerEditor.tsx";
import {
  scopeOptions,
  stateOptions,
  filterServers,
  scopeLabel,
  type ScopeFilter,
  type StateFilter,
} from "./mcp-model.ts";
import styles from "./McpSection.module.css";

/**
 * The MCP section, ported from dsh's MCP panel — same header (restart, add),
 * same card (name, scope/transport/state tags, command line, and the four row
 * actions), same wording for the actions.
 *
 * What differs is where the state comes from. dsh owns its MCP registry and has
 * a `profile` to scope it to; pi reads two `mcp.json` files and "disable" is a
 * *workspace* entry rather than a global switch (see `mcp.ts`). So the profile
 * picker becomes the workspace scope filter, and the page reports the files it
 * read instead of hiding them.
 *
 * Two things dsh's panel has are deliberately absent:
 *
 * - **No per-server enable/disable outside a workspace.** pi's own `/mcp`
 *   writes `.pi/mcp.json` in the current project; there is no user-level off.
 *   The control is disabled, with the reason, when no workspace is selected
 *   rather than pretending to be global.
 * - **No tool list per server.** A running pi session knows it, but that is
 *   per-process state this page cannot read; 检查 reports the count for the
 *   definition it just connected to, which is the honest version of the same
 *   information.
 */

type ProbeState = McpProbeResult | "running";

export function McpSection({ className }: { className?: string }) {
  const t = useT();
  const state = useStore(appStore);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [editing, setEditing] = useState<{ server: McpServerView | null } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<McpServerView | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const projectPath =
    state.projects.find((project) => project.id === state.selectedProjectId)?.path ?? null;
  const view = state.mcp;

  useEffect(() => {
    // The inventory depends on the workspace: disabling and the project layer
    // are both per-workspace, so switching has to re-resolve. Check results go
    // with it — a same-named server in another workspace is another definition.
    if (view !== null && view.projectPath === projectPath) return;
    setProbes({});
    void actions.loadMcp(projectPath);
  }, [projectPath, view]);

  const visible = useMemo(
    () => filterServers(view, scopeFilter, stateFilter),
    [view, scopeFilter, stateFilter],
  );

  const markBusy = (name: string, value: boolean): void => {
    setBusy((previous) => {
      const next = { ...previous };
      if (value) next[name] = true;
      else delete next[name];
      return next;
    });
  };

  const refresh = (): void => {
    setRefreshing(true);
    void actions.loadMcp(projectPath).finally(() => setRefreshing(false));
  };

  const restart = (): void => {
    setRestarting(true);
    void actions.restartMcp().finally(() => setRestarting(false));
  };

  const check = (server: McpServerView): void => {
    setProbes((previous) => ({ ...previous, [server.name]: "running" }));
    void actions
      .checkMcpServer(projectPath, server.name)
      .then((result) => setProbes((previous) => ({ ...previous, [server.name]: result })))
      .catch((err: Error) =>
        setProbes((previous) => ({
          ...previous,
          [server.name]: { ok: false, message: err.message, durationMs: 0 },
        })),
      );
  };

  const toggle = (server: McpServerView, enabled: boolean): void => {
    markBusy(server.name, true);
    void actions
      .setMcpServerEnabled(projectPath, server.name, enabled)
      .finally(() => markBusy(server.name, false));
  };

  const canToggle = projectPath !== null;

  return (
    <div className={className}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <Glyph name="mcp" size={16} className={styles.titleIcon} />
          <h1 className={styles.heading}>{t("settings.mcp.title")}</h1>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.textButton}
            disabled={restarting || view === null}
            onClick={restart}
          >
            {restarting ? t("settings.mcp.restarting") : t("settings.mcp.restart")}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={view === null}
            onClick={() => setEditing({ server: null })}
          >{t("settings.mcp.add")}</button>
        </div>
      </div>

      <p className={styles.lead}>{t("settings.mcp.lead")}</p>

      {view === null ? (
        <div className={styles.placeholder}>{t("settings.mcp.loading")}</div>
      ) : view.error !== null ? (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>{t("settings.mcp.unreadable")}</p>
          <p className={styles.noticeBody}>{view.error}</p>
          <button type="button" className={styles.textButton} onClick={refresh}>{t("common.retry")}</button>
        </div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <select
              className={styles.select}
              aria-label={t("settings.mcp.scopeLabel")}
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value as ScopeFilter)}
            >
              {scopeOptions(t).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              aria-label={t("settings.mcp.statusLabel")}
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value as StateFilter)}
            >
              {stateOptions(t).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t("common.refresh")}
              title={t("settings.mcp.refreshTitle")}
              disabled={refreshing}
              onClick={refresh}
            >
              <RefreshIcon className={clsx(refreshing && styles.spinning)} />
            </button>
          </div>

          {view.servers.length === 0 ? (
            <div className={styles.placeholder}>{t("settings.mcp.empty")}</div>
          ) : visible.length === 0 ? (
            <div className={styles.placeholder}>{t("settings.mcp.noMatch")}</div>
          ) : (
            <div className={styles.cards}>
              {visible.map((server) => (
                <McpCard
                  key={server.name}
                  server={server}
                  probe={probes[server.name]}
                  busy={busy[server.name] === true}
                  canToggle={canToggle}
                  onCheck={() => check(server)}
                  onToggle={() => toggle(server, !server.enabled)}
                  onEdit={() => setEditing({ server })}
                  onDelete={() => setConfirmingDelete(server)}
                />
              ))}
            </div>
          )}

          <McpPaths view={view} />

          {view.errors.length > 0 ? (
            <div className={styles.notice}>
              <p className={styles.noticeTitle}>{t("settings.mcp.errorsTitle")}</p>
              {view.errors.map((message) => (
                <p key={message} className={styles.noticeDetail}>
                  {message}
                </p>
              ))}
            </div>
          ) : null}
        </>
      )}

      {editing !== null ? (
        <McpServerEditor
          server={editing.server}
          projectPath={projectPath}
          onClose={() => {
            setEditing(null);
            // An edited definition invalidates whatever the last check said.
            setProbes({});
          }}
        />
      ) : null}

      {confirmingDelete !== null ? (
        <McpDeleteDialog
          server={confirmingDelete}
          projectPath={projectPath}
          onClose={() => {
            setConfirmingDelete(null);
            setProbes({});
          }}
        />
      ) : null}
    </div>
  );
}

function McpCard({
  server,
  probe,
  busy,
  canToggle,
  onCheck,
  onToggle,
  onEdit,
  onDelete,
}: {
  server: McpServerView;
  probe: ProbeState | undefined;
  busy: boolean;
  canToggle: boolean;
  onCheck: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const checked = probe !== undefined && probe !== "running" ? probe : null;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{server.name}</span>
        <span className={styles.cardTags}>
          <span className={styles.tag}>{scopeLabel(server, t)}</span>
          <span className={styles.tag}>{server.transport}</span>
          <span className={clsx(styles.tag, server.enabled ? styles.tagOn : styles.tagOff)}>
            {server.enabled ? t("settings.mcp.enabled") : t("common.disabled")}
          </span>
          {server.envKeys.length + server.headerKeys.length > 0 ? (
            <span className={styles.tag} title={t("settings.mcp.keysStoredTitle", { keys: [...server.envKeys, ...server.headerKeys].join(t("notice.kindsSeparator")) })}>
              {t("settings.mcp.keysStored", { count: server.envKeys.length + server.headerKeys.length })}
            </span>
          ) : null}
        </span>
      </div>

      <div className={styles.cardDetail}>{server.detail}</div>

      {checked !== null ? (
        <div className={clsx(styles.cardProbe, checked.ok ? styles.probeOk : styles.probeFail)}>
          {checked.message}
        </div>
      ) : null}

      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.cardButton}
          disabled={probe === "running"}
          onClick={onCheck}
        >
          {probe === "running" ? t("settings.updates.checking") : t("settings.mcp.check")}
        </button>
        <button
          type="button"
          className={styles.cardButton}
          disabled={!canToggle || busy}
          title={canToggle ? undefined : t("settings.mcp.disableTitle")}
          onClick={onToggle}
        >
          {server.enabled ? t("common.disable") : t("common.enable")}
        </button>
        <button type="button" className={styles.cardButton} onClick={onEdit}>
          {t("tool.edit")}
        </button>
        <button type="button" className={styles.cardDanger} onClick={onDelete}>
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}

/**
 * The files this section reads and writes.
 *
 * dsh's panel does not show them because it owns its registry; here the config
 * lives in two `mcp.json` files, and a row that says t("common.disable") is really
 * writing one of them. Naming them is the difference between a button and a
 * guess.
 */
function McpPaths({ view }: { view: McpView }) {
  const t = useT();
  return (
    <div className={styles.paths}>
      <div className={styles.pathsTitle}>{t("settings.mcp.configFiles")}</div>
      <dl className={styles.pathsList}>
        <PathRow label={t("settings.mcp.pathGlobal")} value={view.paths.global} />
        {view.paths.project.length > 0 ? (
          <PathRow label={t("settings.mcp.pathProject")} value={view.paths.project} />
        ) : null}
      </dl>
    </div>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  const t = useT();
  return (
    <div className={styles.pathRow}>
      <dt className={styles.pathLabel}>{label}</dt>
      <dd className={styles.pathValue} title={value}>
        {value}
      </dd>
    </div>
  );
}

function McpDeleteDialog({
  server,
  projectPath,
  onClose,
}: {
  server: McpServerView;
  projectPath: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    setBusy(true);
    setError(null);
    void actions
      .deleteMcpServer(projectPath, server.name)
      .then(() => onClose())
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <Dialog onClose={busy ? undefined : onClose} label={t("settings.mcp.removeTitle", { name: server.name })}>
      <h2 className={styles.dialogTitle}>{t("settings.mcp.removeTitle", { name: server.name })}</h2>
      <p className={styles.dialogCopy}>
        {/*
          Deleting is a file edit, so the dialog says which file. When a server
          is defined in several layers, removing the top one re-exposes the one
          under it — worth saying before the click, not after.
        */}
        {t("settings.mcp.removeBody", {
          extra:
            server.sourcePath.length > 0
              ? t("settings.mcp.removeBodySource", { path: server.sourcePath })
              : "",
        })}
      </p>
      {error !== null ? <p className={styles.dialogError}>{error}</p> : null}
      <div className={styles.dialogActions}>
        <button type="button" className={styles.ghostButton} onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
        <button type="button" className={styles.dangerButtonSolid} onClick={remove} disabled={busy}>
          {busy ? t("settings.mcp.removing", { name: server.name }) : t("common.delete")}
        </button>
      </div>
    </Dialog>
  );
}

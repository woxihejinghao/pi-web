import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { RefreshIcon } from "../../components/icons.tsx";
import { actions, appStore } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import type { McpProbeResult, McpServerView, McpView } from "../../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import { McpServerEditor } from "./McpServerEditor.tsx";
import {
  SCOPE_OPTIONS,
  STATE_OPTIONS,
  filterServers,
  scopeLabel,
  type ScopeFilter,
  type StateFilter,
} from "./mcp-model.ts";
import styles from "./McpSection.module.css";

/**
 * The MCP section, ported from dsh's MCP panel — same header (restart, import,
 * add), same card (name, scope/transport/state tags, command line, and the four
 * row actions), same wording for the actions.
 *
 * What differs is where the state comes from. dsh owns its MCP registry and has
 * a `profile` to scope it to; pi has neither — MCP comes from the
 * `pi-mcp-adapter` extension, its config is a set of JSON files, and "disable"
 * is a *workspace* override rather than a global switch (see `mcp.ts`). So the
 * profile picker becomes the workspace scope filter, and the page reports the
 * files it read instead of hiding them.
 *
 * Two things dsh's panel has are deliberately absent:
 *
 * - **No per-server enable/disable outside a workspace.** pi's own `/mcp
 *   disable` writes `.pi/mcp.json` in the current project; there is no
 *   user-level off. The control is disabled, with the reason, when no workspace
 *   is selected rather than pretending to be global.
 * - **No tool list per server.** A running pi session knows it, but that is
 *   per-process state this page cannot read; 检查 reports the count for the
 *   definition it just connected to, which is the honest version of the same
 *   information.
 */

type ProbeState = McpProbeResult | "running";

/** What the install button runs under the hood, for people who use the CLI. */
const INSTALL_COMMAND = "pi install npm:pi-mcp-adapter";

export function McpSection({ className }: { className?: string }) {
  const state = useStore(appStore);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [editing, setEditing] = useState<{ server: McpServerView | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<McpServerView | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

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

  const install = (): void => {
    setInstalling(true);
    setInstallError(null);
    void actions
      .installMcpAdapter(projectPath)
      .catch((err: Error) => setInstallError(err.message))
      .finally(() => setInstalling(false));
  };

  const copyInstallCommand = (): void => {
    void navigator.clipboard
      .writeText(INSTALL_COMMAND)
      .then(() => actions.setNotice(`已复制 ${INSTALL_COMMAND}`))
      .catch(() => actions.setNotice(INSTALL_COMMAND));
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
          <h1 className={styles.heading}>MCP 服务器</h1>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.textButton}
            disabled={restarting || view === null || !view.available}
            onClick={restart}
          >
            {restarting ? "重启中…" : "重启"}
          </button>
          <button
            type="button"
            className={styles.textButton}
            disabled={view === null || view.importable.length === 0}
            title={
              view !== null && view.importable.length === 0
                ? "没有检测到可导入的其他 Agent 配置"
                : undefined
            }
            onClick={() => setImporting(true)}
          >
            从其他 Agent 导入
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={view === null || !view.available}
            onClick={() => setEditing({ server: null })}
          >
            添加服务器
          </button>
        </div>
      </div>

      <p className={styles.lead}>
        管理 pi 的 MCP 服务器。新增、修改或删除后需要重启，下一次发消息时生效。
      </p>

      {view === null ? (
        <div className={styles.placeholder}>正在读取 MCP 配置…</div>
      ) : !view.available ? (
        // The extension is missing, which is a different state from "no servers
        // configured" — so it gets an explanation and a way out of it, not an
        // empty list. Installing is the same operation `pi install` performs.
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>需要先安装 pi-mcp-adapter</p>
          <p className={styles.noticeBody}>
            pi 本身不带 MCP 支持，这一节的能力来自 pi-mcp-adapter 扩展。装好之后这一页会自动可用，不用重启本服务。
          </p>
          {view.unavailableReason !== null ? (
            <p className={styles.noticeDetail}>{view.unavailableReason}</p>
          ) : null}
          <div className={styles.noticeActions}>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={installing}
              onClick={install}
            >
              {installing ? "安装中…（可能要一分钟）" : "安装 pi-mcp-adapter"}
            </button>
            <button
              type="button"
              className={styles.textButton}
              disabled={installing}
              onClick={copyInstallCommand}
            >
              复制安装命令
            </button>
            <button
              type="button"
              className={styles.textButton}
              disabled={installing}
              onClick={refresh}
            >
              重新检查
            </button>
          </div>
          <p className={styles.noticeCommand}>{INSTALL_COMMAND}</p>
          {installError !== null ? (
            <p className={styles.noticeError}>{installError}</p>
          ) : null}
        </div>
      ) : view.error !== null ? (
        <div className={styles.notice}>
          <p className={styles.noticeTitle}>暂时无法读取 MCP 配置。</p>
          <p className={styles.noticeBody}>{view.error}</p>
          <button type="button" className={styles.textButton} onClick={refresh}>
            重试
          </button>
        </div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <select
              className={styles.select}
              aria-label="作用域"
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value as ScopeFilter)}
            >
              {SCOPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              aria-label="状态"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value as StateFilter)}
            >
              {STATE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.iconButton}
              aria-label="刷新"
              title="重新读取配置文件"
              disabled={refreshing}
              onClick={refresh}
            >
              <RefreshIcon className={clsx(refreshing && styles.spinning)} />
            </button>
          </div>

          {view.servers.length === 0 ? (
            <div className={styles.placeholder}>
              还没有 MCP 服务器。用「添加服务器」新建一个，或者从其他 Agent 导入。
            </div>
          ) : visible.length === 0 ? (
            <div className={styles.placeholder}>没有匹配的服务器。</div>
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

      {importing && view !== null ? (
        <McpImportDialog
          view={view}
          projectPath={projectPath}
          onClose={() => setImporting(false)}
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
  const checked = probe !== undefined && probe !== "running" ? probe : null;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardName}>{server.name}</span>
        <span className={styles.cardTags}>
          <span className={styles.tag}>{scopeLabel(server)}</span>
          <span className={styles.tag}>{server.transport}</span>
          <span className={clsx(styles.tag, server.enabled ? styles.tagOn : styles.tagOff)}>
            {server.enabled ? "启用中" : "已停用"}
          </span>
          {server.envKeys.length + server.headerKeys.length > 0 ? (
            <span className={styles.tag} title={`已存储密钥：${[...server.envKeys, ...server.headerKeys].join("、")}`}>
              已存密钥 {server.envKeys.length + server.headerKeys.length}
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
          {probe === "running" ? "检查中…" : "检查"}
        </button>
        <button
          type="button"
          className={styles.cardButton}
          disabled={!canToggle || busy}
          title={canToggle ? undefined : "停用是工作区级的覆盖，请先选择一个工作区"}
          onClick={onToggle}
        >
          {server.enabled ? "停用" : "启用"}
        </button>
        <button
          type="button"
          className={styles.cardButton}
          disabled={server.hostImport}
          title={
            server.hostImport
              ? `定义在 ${server.importKind} 的配置文件里，请在那里编辑`
              : undefined
          }
          onClick={onEdit}
        >
          编辑
        </button>
        <button
          type="button"
          className={styles.cardDanger}
          disabled={server.hostImport}
          title={
            server.hostImport
              ? `定义在 ${server.importKind} 的配置文件里，这里只能停用`
              : undefined
          }
          onClick={onDelete}
        >
          删除
        </button>
      </div>
    </div>
  );
}

/**
 * The files this section reads and writes.
 *
 * dsh's panel does not show them because it owns its registry; here the config
 * lives in files that other tools read too, and a row that says "停用" is really
 * writing one of them. Naming them is the difference between a button and a
 * guess.
 */
function McpPaths({ view }: { view: McpView }) {
  return (
    <div className={styles.paths}>
      <div className={styles.pathsTitle}>配置文件</div>
      <dl className={styles.pathsList}>
        <PathRow label="全局添加" value={view.paths.global} />
        <PathRow label="工作区添加" value={view.paths.project} />
        <PathRow label="启用/停用" value={view.paths.projectPi} />
        {view.imports.length > 0 ? (
          <PathRow
            label="已导入"
            value={view.imports.map((entry) => `${entry.kind}（${entry.serverCount} 个）`).join("、")}
          />
        ) : null}
      </dl>
    </div>
  );
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.pathRow}>
      <dt className={styles.pathLabel}>{label}</dt>
      <dd className={styles.pathValue} title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Import another agent's MCP config.
 *
 * The list is what the adapter detected on this machine (`~/.cursor/mcp.json`,
 * `~/.claude.json`, `~/.codex/config.toml`, …); importing adds those kinds to
 * Pi's `imports` array, and the servers show up on the next read. Those files
 * stay owned by their tools — the page only ever reads them.
 */
function McpImportDialog({
  view,
  projectPath,
  onClose,
}: {
  view: McpView;
  projectPath: string | null;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kinds = Object.keys(selected);

  const run = (): void => {
    setBusy(true);
    setError(null);
    void actions
      .importMcpConfigs(projectPath, kinds)
      .then(() => onClose())
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <Dialog onClose={busy ? undefined : onClose} label="从其他 Agent 导入">
      <h2 className={styles.dialogTitle}>从其他 Agent 导入</h2>
      <p className={styles.dialogCopy}>
        勾选要引入的配置。这些文件仍由各自的工具维护，这里只读取它们。
      </p>
      <div className={styles.importList}>
        {view.importable.map((candidate) => (
          <label key={candidate.kind} className={styles.importRow}>
            <input
              type="checkbox"
              checked={selected[candidate.kind] === true}
              onChange={(event) =>
                setSelected((previous) => {
                  const next = { ...previous };
                  if (event.target.checked) next[candidate.kind] = true;
                  else delete next[candidate.kind];
                  return next;
                })
              }
            />
            <span className={styles.importKind}>{candidate.kind}</span>
            <span className={styles.importPath} title={candidate.path}>
              {candidate.path}
            </span>
          </label>
        ))}
      </div>
      {error !== null ? <p className={styles.dialogError}>{error}</p> : null}
      <div className={styles.dialogActions}>
        <button type="button" className={styles.ghostButton} onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy || kinds.length === 0}
          onClick={run}
        >
          {busy ? "导入中…" : "导入"}
        </button>
      </div>
    </Dialog>
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
    <Dialog onClose={busy ? undefined : onClose} label={`删除 ${server.name}`}>
      <h2 className={styles.dialogTitle}>删除 {server.name}？</h2>
      <p className={styles.dialogCopy}>
        {/*
          Deleting is a file edit, so the dialog says which file. When a server
          is defined in several layers, removing the top one re-exposes the one
          under it — worth saying before the click, not after.
        */}
        {`会从定义它的配置文件里移除这条记录${
          server.sourcePath.length > 0 ? `（${server.sourcePath}）` : ""
        }。如果更低优先级的文件里还有同名定义，那个定义会重新生效。`}
      </p>
      {error !== null ? <p className={styles.dialogError}>{error}</p> : null}
      <div className={styles.dialogActions}>
        <button type="button" className={styles.ghostButton} onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="button" className={styles.dangerButtonSolid} onClick={remove} disabled={busy}>
          {busy ? `正在删除 ${server.name}…` : "删除"}
        </button>
      </div>
    </Dialog>
  );
}

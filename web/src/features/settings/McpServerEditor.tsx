import { useState } from "react";
import clsx from "clsx";
import { actions } from "../../lib/app-state.ts";
import type { McpSecretRow, McpServerView } from "../../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import styles from "./McpServerEditor.module.css";

/**
 * The add/edit form for one MCP server.
 *
 * Two rules come from how pi's config is stored rather than from taste:
 *
 * - **Secret values are write-only.** The page never receives them, so an
 *   environment or header row shows its key with an empty value box; leaving the
 *   box empty keeps whatever is stored, and clearing a row removes the key. That
 *   is why rows are pre-filled with keys but never with values.
 * - **The save target is a choice.** A global server goes into the shared
 *   user-global config; a workspace one goes into the project's `.mcp.json`.
 *   Both paths are shown under the picker, because "global" here means "every
 *   MCP host that reads that file", not just pi.
 */

const TRANSPORTS = [
  { value: "stdio", label: "stdio", hint: "本地进程，通过 stdin/stdout 通信" },
  { value: "http", label: "http", hint: "Streamable HTTP 远程端点" },
  { value: "sse", label: "sse", hint: "旧版 SSE 远程端点" },
] as const;

type Transport = (typeof TRANSPORTS)[number]["value"];

export function McpServerEditor({
  server,
  projectPath,
  onClose,
}: {
  server: McpServerView | null;
  projectPath: string | null;
  onClose: () => void;
}) {
  const editing = server !== null;
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<Transport>(
    server?.transport === "http" || server?.transport === "sse" ? server.transport : "stdio",
  );
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState(server?.args ?? "");
  const [cwd, setCwd] = useState(server?.cwd ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [envRows, setEnvRows] = useState<McpSecretRow[]>(() =>
    (server?.envKeys ?? []).map((key) => ({ key, value: "" })),
  );
  const [headerRows, setHeaderRows] = useState<McpSecretRow[]>(() =>
    (server?.headerKeys ?? []).map((key) => ({ key, value: "" })),
  );
  const [scope, setScope] = useState<"global" | "project">(
    // Editing defaults to where the row already lives; a new server defaults to
    // the workspace, which is the narrower of the two.
    server === null ? "project" : server.sourceKind === "project" ? "project" : "global",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canUseProject = projectPath !== null;

  const save = (): void => {
    setBusy(true);
    setError(null);
    void actions
      .saveMcpServer({
        projectPath,
        scope: canUseProject ? scope : "global",
        originalName: server?.name ?? null,
        draft: {
          name,
          transport,
          command,
          args,
          cwd,
          url,
          env: envRows,
          headers: transport === "stdio" ? [] : headerRows,
        },
      })
      .then(() => onClose())
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <Dialog onClose={busy ? undefined : onClose} label={editing ? `编辑 ${server.name}` : "添加服务器"}>
      <h2 className={styles.title}>{editing ? `编辑 ${server.name}` : "添加服务器"}</h2>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>名称</span>
        <input
          className={styles.input}
          value={name}
          autoFocus
          placeholder="figma"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>传输</span>
        <div className={styles.pills}>
          {TRANSPORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={clsx(styles.pill, option.value === transport && styles.pillActive)}
              aria-pressed={option.value === transport}
              title={option.hint}
              onClick={() => setTransport(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {transport === "stdio" ? (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>命令</span>
            <input
              className={styles.input}
              value={command}
              placeholder="npx"
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>参数</span>
            <input
              className={styles.input}
              value={args}
              placeholder="-y figma-developer-mcp --stdio"
              onChange={(event) => setArgs(event.target.value)}
            />
            <span className={styles.fieldHint}>按空格分隔。不改动这一行就不会重排已存参数。</span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>工作目录</span>
            <input
              className={styles.input}
              value={cwd}
              placeholder="留空表示继承 pi 的目录"
              onChange={(event) => setCwd(event.target.value)}
            />
          </label>
        </>
      ) : (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>URL</span>
          <input
            className={styles.input}
            value={url}
            placeholder="https://mcp.example.com/mcp"
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
      )}

      <RowEditor
        label="环境变量"
        keyPlaceholder="FIGMA_API_KEY"
        rows={envRows}
        onChange={setEnvRows}
        hint="值留空表示保持已存值；删除整行则移除该变量。"
      />

      {transport === "stdio" ? null : (
        <RowEditor
          label="请求头"
          keyPlaceholder="Authorization"
          rows={headerRows}
          onChange={setHeaderRows}
          hint="值留空表示保持已存值；删除整行则移除该请求头。"
        />
      )}

      <div className={styles.field}>
        <span className={styles.fieldLabel}>写入位置</span>
        <div className={styles.pills}>
          <button
            type="button"
            className={clsx(styles.pill, scope === "global" && styles.pillActive)}
            aria-pressed={scope === "global"}
            onClick={() => setScope("global")}
          >
            全局
          </button>
          <button
            type="button"
            className={clsx(styles.pill, scope === "project" && styles.pillActive)}
            aria-pressed={scope === "project"}
            disabled={!canUseProject}
            title={canUseProject ? undefined : "请先选择一个工作区"}
            onClick={() => setScope("project")}
          >
            当前工作区
          </button>
        </div>
        <span className={styles.fieldHint}>
          {canUseProject ? `工作区写入 ${projectPath}/.mcp.json。` : "还没有选中工作区，只能写入全局。"}
        </span>
      </div>

      {error !== null ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="button" className={styles.primary} onClick={save} disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * A list of secret rows. Keys are visible, values never are — a stored value is
 * represented by the row existing at all, and typing into the box replaces it.
 */
function RowEditor({
  label,
  keyPlaceholder,
  rows,
  onChange,
  hint,
}: {
  label: string;
  keyPlaceholder: string;
  rows: McpSecretRow[];
  onChange: (rows: McpSecretRow[]) => void;
  hint: string;
}) {
  const update = (index: number, patch: Partial<McpSecretRow>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {rows.map((row, index) => (
        <div key={index} className={styles.rowEdit}>
          <input
            className={styles.input}
            value={row.key}
            placeholder={keyPlaceholder}
            aria-label={`${label}名称`}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <input
            className={styles.input}
            value={row.value}
            placeholder="值（留空保留）"
            aria-label={`${label}值`}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className={styles.rowRemove}
            aria-label={`删除这一行`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.rowAdd}
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        + 添加一行
      </button>
      <span className={styles.fieldHint}>{hint}</span>
    </div>
  );
}

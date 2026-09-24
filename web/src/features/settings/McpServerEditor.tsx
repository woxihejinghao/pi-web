import { useState } from "react";
import clsx from "clsx";
import { actions, useT } from "../../lib/app-state.ts";
import type { Translate } from "../../lib/i18n/index.ts";
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

/** The three transports, with the hint that explains each. */
function transportOptions(
  t: Translate,
): readonly { value: Transport; label: string; hint: string }[] {
  return [
    { value: "stdio", label: "stdio", hint: t("settings.mcpTransport.stdioHint") },
    { value: "http", label: "http", hint: t("settings.mcpTransport.httpHint") },
    { value: "sse", label: "sse", hint: t("settings.mcpTransport.sseHint") },
  ];
}

type Transport = "stdio" | "http" | "sse";

export function McpServerEditor({
  server,
  projectPath,
  onClose,
}: {
  server: McpServerView | null;
  projectPath: string | null;
  onClose: () => void;
}) {
  const t = useT();
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
    <Dialog onClose={busy ? undefined : onClose} label={editing ? t("settings.mcpEditor.editTitle", { name: server.name }) : t("settings.mcp.add")}>
      <h2 className={styles.title}>{editing ? t("settings.mcpEditor.editTitle", { name: server.name }) : t("settings.mcp.add")}</h2>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t("settings.mcpEditor.name")}</span>
        <input
          className={styles.input}
          value={name}
          autoFocus
          placeholder="figma"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("settings.mcpEditor.transport")}</span>
        <div className={styles.pills}>
          {transportOptions(t).map((option) => (
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
            <span className={styles.fieldLabel}>{t("slash.commands")}</span>
            <input
              className={styles.input}
              value={command}
              placeholder="npx"
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.mcpEditor.args")}</span>
            <input
              className={styles.input}
              value={args}
              placeholder="-y figma-developer-mcp --stdio"
              onChange={(event) => setArgs(event.target.value)}
            />
            <span className={styles.fieldHint}>{t("settings.mcpEditor.argsHint")}</span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t("settings.mcpEditor.cwd")}</span>
            <input
              className={styles.input}
              value={cwd}
              placeholder={t("settings.mcpEditor.cwdPlaceholder")}
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
        label={t("settings.mcpEditor.env")}
        keyPlaceholder="FIGMA_API_KEY"
        rows={envRows}
        onChange={setEnvRows}
        hint={t("settings.mcpEditor.envHint")}
      />

      {transport === "stdio" ? null : (
        <RowEditor
          label={t("settings.mcpEditor.headers")}
          keyPlaceholder="Authorization"
          rows={headerRows}
          onChange={setHeaderRows}
          hint={t("settings.mcpEditor.headersHint")}
        />
      )}

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t("settings.mcpEditor.writeTo")}</span>
        <div className={styles.pills}>
          <button
            type="button"
            className={clsx(styles.pill, scope === "global" && styles.pillActive)}
            aria-pressed={scope === "global"}
            onClick={() => setScope("global")}
          >{t("settings.mcpScope.user")}</button>
          <button
            type="button"
            className={clsx(styles.pill, scope === "project" && styles.pillActive)}
            aria-pressed={scope === "project"}
            disabled={!canUseProject}
            title={canUseProject ? undefined : t("settings.mcpEditor.projectTitle")}
            onClick={() => setScope("project")}
          >{t("settings.mcpScope.project")}</button>
        </div>
        <span className={styles.fieldHint}>
          {canUseProject ? t("settings.mcpEditor.projectNote", { path: `${projectPath}/.mcp.json` }) : t("settings.mcpEditor.noProject")}
        </span>
      </div>

      {error !== null ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.actions}>
        <button type="button" className={styles.ghost} onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
        <button type="button" className={styles.primary} onClick={save} disabled={busy}>
          {busy ? t("settings.provider.saving") : t("common.save")}
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
  const t = useT();
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
            aria-label={t("settings.mcpEditor.rowNameLabel", { label })}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <input
            className={styles.input}
            value={row.value}
            placeholder={t("settings.mcpEditor.rowValuePlaceholder")}
            aria-label={t("settings.mcpEditor.rowValueLabel", { label })}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className={styles.rowRemove}
            aria-label={t("settings.mcpEditor.removeRow")}
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
      >{t("settings.mcpEditor.addRow")}</button>
      <span className={styles.fieldHint}>{hint}</span>
    </div>
  );
}

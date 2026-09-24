import type { McpServerView, McpView } from "../../lib/types.ts";
import type { Translate } from "../../lib/i18n/index.ts";

/**
 * Pure model for the MCP section: the two filters and the tag text. Kept out of
 * the component so the filtering contract can be tested without rendering a
 * page that talks to the server.
 */

export function scopeOptions(
  t: Translate,
): readonly { value: ScopeFilter; label: string }[] {
  return [
    { value: "all", label: t("settings.mcpScope.all") },
    { value: "user", label: t("settings.mcpScope.user") },
    { value: "project", label: t("settings.mcpScope.project") },
  ];
}

export function stateOptions(
  t: Translate,
): readonly { value: StateFilter; label: string }[] {
  return [
    { value: "all", label: t("settings.mcpStatus.all") },
    { value: "enabled", label: t("settings.mcpStatus.enabled") },
    { value: "disabled", label: t("settings.mcpStatus.disabled") },
  ];
}

export type ScopeFilter = "all" | "user" | "project";
export type StateFilter = "all" | "enabled" | "disabled";

/**
 * What the row says about where the definition came from.
 *
 * An imported server gets its origin agent's name: "全局" would be wrong for a
 * definition that lives in `~/.cursor/mcp.json` and is only *read* through Pi's
 * import list.
 */
export function scopeLabel(server: McpServerView, t: Translate): string {
  if (server.hostImport) return t("settings.mcpOrigin.from", { kind: server.importKind ?? "" });
  return server.sourceKind === "project"
    ? t("settings.mcpScope.project")
    : t("settings.mcpScope.user");
}

/** Apply both filters. An empty inventory filters to an empty list. */
export function filterServers(
  view: McpView | null,
  scope: ScopeFilter,
  state: StateFilter,
): McpServerView[] {
  if (view === null) return [];
  return view.servers.filter((server) => {
    if (scope !== "all" && server.sourceKind !== scope) return false;
    if (state === "enabled" && !server.enabled) return false;
    if (state === "disabled" && server.enabled) return false;
    return true;
  });
}

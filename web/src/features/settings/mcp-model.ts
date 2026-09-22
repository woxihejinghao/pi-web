import type { McpServerView, McpView } from "../../lib/types.ts";

/**
 * Pure model for the MCP section: the two filters and the tag text. Kept out of
 * the component so the filtering contract can be tested without rendering a
 * page that talks to the server.
 */

export const SCOPE_OPTIONS = [
  { value: "all", label: "全部作用域" },
  { value: "user", label: "全局" },
  { value: "project", label: "当前工作区" },
] as const;

export const STATE_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "enabled", label: "已启用" },
  { value: "disabled", label: "已停用" },
] as const;

export type ScopeFilter = (typeof SCOPE_OPTIONS)[number]["value"];
export type StateFilter = (typeof STATE_OPTIONS)[number]["value"];

/**
 * What the row says about where the definition came from.
 *
 * An imported server gets its origin agent's name: "全局" would be wrong for a
 * definition that lives in `~/.cursor/mcp.json` and is only *read* through Pi's
 * import list.
 */
export function scopeLabel(server: McpServerView): string {
  if (server.hostImport) return `来自 ${server.importKind}`;
  return server.sourceKind === "project" ? "当前工作区" : "全局";
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

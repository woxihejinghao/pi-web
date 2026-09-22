import type { ExtensionItem, ExtensionsView } from "../../lib/types.ts";

/**
 * Pure model for the plugins section: which group an extension belongs to and
 * whether the current query keeps it. Kept out of the component so the search
 * contract (what a query is matched against) can be tested on its own — the
 * component only decides how to draw the result.
 */

export type PluginScope = "user" | "project";

/**
 * The two groups, both open by default.
 *
 * dsh folds its global list away because the preset list is the answer most
 * users want there. Here the global list is the one that always exists — a
 * workspace may have no `.pi` at all — so folding it would hide the page's main
 * content for no reason. Subtitles are dsh's, adapted from "会话/预设" to pi's
 * workspace scope.
 */
export const GROUP_META: Record<PluginScope, { title: string; subtitle: string }> = {
  user: { title: "全局插件", subtitle: "系统与所有工作区共用" },
  project: { title: "工作区插件", subtitle: "只在这个工作区加载" },
};

/** What contributed an entry, in the terms the row can act on. */
export function extensionSourceLabel(item: ExtensionItem): string {
  if (item.origin === "package") return "pi 包";
  if (item.source === "auto") return "自动发现";
  if (item.source === "local") return "本地路径";
  return item.source;
}

/**
 * Split the inventory into its two scopes and apply the search.
 *
 * Matching covers the path and the source as well as the label: the label for a
 * package entry is its package name, and someone looking for the file they
 * dropped into `extensions/` is more likely to type part of the path. An empty
 * query keeps everything, which is what makes the count next to each group
 * heading mean "how many live here" rather than "how many matched" when nothing
 * is being searched for.
 */
export function groupExtensions(
  view: ExtensionsView | null,
  query: string,
): Record<PluginScope, ExtensionItem[]> {
  const groups: Record<PluginScope, ExtensionItem[]> = { user: [], project: [] };
  if (view === null) return groups;

  const needle = query.trim().toLowerCase();
  for (const item of view.extensions) {
    if (needle.length > 0) {
      const haystack = `${item.name} ${item.path} ${item.source}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    groups[item.scope].push(item);
  }
  return groups;
}

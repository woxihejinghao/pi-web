/**
 * UI copy, one table per language.
 *
 * Chinese is the source table: it is the wording the app shipped with, so
 * `zhCN` doubles as the list of keys. Every other table is typed as
 * `Record<MessageKey, string>`, which turns a missing translation into a
 * compile error rather than an English sentence sitting in a Chinese screen.
 *
 * Keys are `area.thing`, never sentences. The same English word can need two
 * different Chinese ones ("Open" the file vs "Open" a project), and a table
 * keyed by source text would quietly couple those two places together.
 *
 * Placeholders are `{name}` and are filled by `translator()` in `index.ts`.
 */
export const zhCN = {
  // --- settings · general ---------------------------------------------------
  "settings.appearance.title": "外观",
  "settings.appearance.light": "浅色",
  "settings.appearance.dark": "深色",
  "settings.appearance.system": "跟随系统",
  "settings.language.title": "语言",
  "settings.language.description": "界面语言；跟随系统时按浏览器语言决定",
  "settings.language.system": "跟随系统",
  "settings.language.zh": "简体中文",
  "settings.language.en": "English",
  "settings.fontSize.title": "字号大小",
  "settings.fontSize.description": "仅影响会话内容的字号",
  "settings.fontSize.decrease": "减小字号",
  "settings.fontSize.increase": "增大字号",
  "settings.transcript.title": "对话显示",
  "settings.transcript.description": "控制已完成轮次的过程内容",
  "settings.transcript.normal": "标准",
  "settings.transcript.compact": "紧凑",
  "settings.busySend.title": "繁忙时的发送行为",
  "settings.busySend.description":
    "智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为",
  "settings.busySend.queue": "排队发送",
  "settings.busySend.steer": "插话发送",
  "settings.autoCompaction.title": "自动压缩",
  "settings.autoCompaction.description": "上下文接近上限时自动压缩较早的对话",
  "settings.autoCompaction.on": "开启",
  "settings.autoCompaction.off": "关闭",

  // --- sidebar --------------------------------------------------------------
  "sidebar.newSession": "新会话",
  "sidebar.newSessionIn": "在「{title}」中新建会话",
  "sidebar.newSessionNoProject": "先添加一个工作区",
  "sidebar.workspaces": "工作区",
  "sidebar.search": "搜索",
  "sidebar.searchPlaceholder": "搜索工作区和会话",
  "sidebar.addWorkspace": "添加工作区",
  "sidebar.empty": "还没有工作区。点击 + 选择一个本地目录。",
  "sidebar.settings": "设置",
  "sidebar.settingsWithUpdate": "设置 · 有可用更新",
} as const;

export type MessageKey = keyof typeof zhCN;

export type UiLanguage = "zh-CN" | "en";

export const en: Record<MessageKey, string> = {
  "settings.appearance.title": "Appearance",
  "settings.appearance.light": "Light",
  "settings.appearance.dark": "Dark",
  "settings.appearance.system": "System",
  "settings.language.title": "Language",
  "settings.language.description": "Interface language; System follows the browser",
  "settings.language.system": "Follow system",
  "settings.language.zh": "简体中文",
  "settings.language.en": "English",
  "settings.fontSize.title": "Font size",
  "settings.fontSize.description": "Affects conversation content only",
  "settings.fontSize.decrease": "Decrease font size",
  "settings.fontSize.increase": "Increase font size",
  "settings.transcript.title": "Transcript display",
  "settings.transcript.description": "How finished turns present their process rows",
  "settings.transcript.normal": "Normal",
  "settings.transcript.compact": "Compact",
  "settings.busySend.title": "Send while busy",
  "settings.busySend.description":
    "What Enter and the send button do while the agent runs; Cmd/Ctrl+Enter uses the other one",
  "settings.busySend.queue": "Queue",
  "settings.busySend.steer": "Steer",
  "settings.autoCompaction.title": "Auto-compaction",
  "settings.autoCompaction.description":
    "Compact earlier conversation automatically as the context fills up",
  "settings.autoCompaction.on": "On",
  "settings.autoCompaction.off": "Off",

  "sidebar.newSession": "New session",
  "sidebar.newSessionIn": "New session in “{title}”",
  "sidebar.newSessionNoProject": "Add a workspace first",
  "sidebar.workspaces": "Workspaces",
  "sidebar.search": "Search",
  "sidebar.searchPlaceholder": "Search workspaces and sessions",
  "sidebar.addWorkspace": "Add workspace",
  "sidebar.empty": "No workspaces yet. Click + to pick a local directory.",
  "sidebar.settings": "Settings",
  "sidebar.settingsWithUpdate": "Settings · update available",
};

export const MESSAGES: Record<UiLanguage, Record<MessageKey, string>> = {
  "zh-CN": zhCN,
  en,
};

# 更新日志

本文件记录 pi-web-simple 的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-24

首次公开发布。一个本地 Web UI，套在 pi 之上：`npx pi-web-simple` 启动单个进程，同时提供前端与 API。

### 新增

- **项目管理**：一个本地目录 = 一个项目，项目下挂该目录的会话。内置服务端目录选择器（逐级进入、地址栏可粘贴路径、主目录/桌面/文稿/下载/根目录快捷入口）。
- **会话**：每个活跃会话对应一个 `pi --mode rpc` 子进程，活跃数上限可配，空闲自动回收（含预热进程）。
- **对话**：SSE 流式输出、Markdown 渲染、shiki 代码高亮、图片输入、消息操作行、会话 fork 与话题树。
- **模型选择**：新建会话时可选模型；模型配置沿用 pi 自己的配置文件，不另建一份状态。
- **右侧栏**：文件树、文件预览、变更面板、内嵌浏览器。
- **变更面板**：分「已暂存 / 未暂存」两份 diff、hunk 级折叠、分支列表与上游 ahead/behind、提交历史，以及写操作（暂存/取消暂存/全部暂存、提交、推送、还原、切分支）。
- **每轮改动文件卡片**：每轮对话末尾列出该轮实际改动的文件。
- **设置页**：通用、模型、插件、MCP 四节。
- **扩展生态接入**：
  - 插件清单由 pi 自己的资源解析器（`DefaultPackageManager` / `SettingsManager`）计算，与终端看到的一致。
  - MCP 一节动态加载 `pi-mcp-adapter/config` 的公开入口，并支持真实握手检查（stdio `initialize` + `tools/list`）。
  - 扩展的 UI 请求（`ctx.ui.confirm/select/input/editor`）**替换输入框**而非弹模态。
  - 任务清单面板依赖 `@juicesharp/rpiv-todo`，未安装时显示一次性的安装提示。
  - 更新检查与提示。
- **仅监听 `127.0.0.1`**，默认不对外暴露。

### 说明

- 需要 Node.js `>= 22.19.0`。
- pi 的 `todo` 工具与 MCP 能力分别由 `@juicesharp/rpiv-todo` 和 `pi-mcp-adapter` 扩展提供，本项目不内置；缺少时界面给出安装入口而非静默空白。

[0.1.0]: https://github.com/woxihejinghao/pi-web/releases/tag/v0.1.0

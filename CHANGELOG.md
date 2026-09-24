# 更新日志

本文件记录 pi-web-simple 的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-09-24

### 变更

- **README 拆成中英两份**：[README.md](./README.md) 为英文（npm 与 [pi.dev 画廊](https://pi.dev/packages/pi-web-simple) 展示的就是这一份），[README.zh-CN.md](./README.zh-CN.md) 为中文，两份顶部一键互切。切换链接用 GitHub 绝对地址而不是相对路径，因为相对链接在 npm 页面上会 404。
- **`files` 补上 `README.zh-CN.md`**：npm 只默认带 `README.md`，不加这一项包里就没有中文版，切换链接会指向一个不存在的文件。
- [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [设计说明](./docs/design-notes.md) 里指向 README 的链接改指中文版（英文版里没有中文锚点）。

## [0.2.0] - 2026-09-24

### 新增

- **包本身成了 pi 包**：加上 `pi-package` 关键词与 `pi.extensions` 清单，`pi install npm:pi-web-simple` 就能装进 pi 会话，同时包会被 [pi.dev/packages](https://pi.dev/packages) 画廊自动收录（那里没有提交入口，只按关键词索引 npm）。
- **`/web` 命令**：`/web [端口] [--no-open]` 启动界面（默认沿用 5319，自动开浏览器）、`/web status` 看状态、`/web stop` 关闭。子进程由 pi 管理，`session_shutdown` 时一并结束，不留孤儿进程；端口被占用之类的启动失败会带上服务端最后几行日志报回 pi 界面。

### 工程

- **`scripts/verify-dist.mjs` 多两道发布闸门**：`extensions/index.js` 是否随包发出，以及 `package.json` 是否还带着 `pi-package` 关键词。后者是又一种静默失败——少了它 `npm publish` 照样成功，只是画廊永远不收录。

## [0.1.1] - 2026-09-24

### 改进

- **代码高亮移植了 dsh 的流式增量 tokenizer**：用 `codeToTokensBase` 接上一次的 `grammarState` 按行续接，冻结最后一个换行之前的全部内容（连同它们的 HTML），每个新 delta 只重新 tokenize 正在写的那一行。200 行 typescript（约 9 KB）实测：全量一次 101ms，续接后重算最后一行 0.6ms。2 万字符上限只剩在「必须从头 tokenize」的路径上，流式增长的长块不再受它限制。
- **语法预热扩展到按需加载的语言**：JS 引擎的 pattern 用到才编译，没预热过的 grammar 第一次 tokenize 出来的 token 比之后每一次都粗，同一块代码第二次绘制时颜色会变；现在动态 `import()` 落地后、在通知重渲染之前先跑一遍样本。

### 移除

- **`docs/PLAN.md`**：实现阶段的计划文档，文件结构、步骤与验证清单都已完成，其中的临时路径（`/tmp/dsh-probe`）与「待创建」目录树也已经和仓库对不上。设计取舍仍由 [设计说明](./docs/design-notes.md) 承载，原文在 git 历史里（`git show HEAD:docs/PLAN.md`）。
- [设计说明](./docs/design-notes.md) 里重复出现两遍的 diff 解析段落（「diff 的文本理解」与「补丁的文本理解」内容一致）删去后者。

### 修复

- **对话流式输出时的闪烁与跳动**：
  - 代码块不再在「纯文本 → 高亮」之间闪一下：首帧可见性改用 `useLayoutEffect` 同步量取，两种状态共用同一个容器。
  - 一轮消息提交时不再整块重挂载：流式中的内容直接渲染在它即将落进的那一轮里，代码块不会重新上色、思考行不会自己折回。
  - 跟随滚动改到绘制之前，并关掉浏览器滚动锚定；代码块预留横向滚动条位置，不再因横条出现/消失而整体下移。
  - 每个 token 一次的视图发布按动画帧合并；`Markdown` 按文本记忆化、高亮结果按「语法 + 源码」缓存，流式期间不再重解析/重高亮整个转录。
- **长行不再卡死页面**：单行超过 2 000 字符的内容直接不参与分词（`tokenizeMaxLineLength`）。一行两万字符实测要 52 秒，整页在这期间没有响应——那是 JS 正则引擎的非线性成本，原生 Oniguruma 不会这样。

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

[0.1.1]: https://github.com/woxihejinghao/pi-web/releases/tag/v0.1.1
[0.1.0]: https://github.com/woxihejinghao/pi-web/releases/tag/v0.1.0

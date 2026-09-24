# pi-web-simple

A local web UI for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent — one local directory = one project, each project holding that directory's sessions. The agent core is pi itself, attached over `pi --mode rpc` subprocesses. The project management model and visual language follow [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

```sh
npx pi-web-simple    # serves the UI + API on http://127.0.0.1:5319
```

Requires Node.js `>= 22.19.0`. Binds to `127.0.0.1` only.

**Highlights** — server-side directory picker · multi-session, one idle-recycled pi process per session · SSE streaming chat with Markdown + shiki highlighting · image input · session fork and topic tree · model picker · right sidebar (file tree, preview, git changes, embedded browser) · full git panel (stage, commit, push, restore, switch branch) · model / plugin / MCP settings.

> 以下为中文文档。English contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

---

一个基于 [pi](https://github.com/earendil-works/pi-coding-agent) 的本地项目管理 / 对话 Web UI。

项目管理模型与界面风格参考 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：**一个本地目录 = 一个项目**，项目下挂该目录的会话。agent 内核是 pi 本身，通过 `pi --mode rpc` 子进程接入。

```
浏览器 (React + Vite)
   │  POST /api/*            上行命令
   │  GET  /api/events (SSE) 下行事件
   ▼
Node 服务端 (单进程)
   ├─ 项目记录   ~/.pi-web-simple/store.json
   ├─ 界面偏好   同一份 store.json（外观 / 字号 / 对话显示 / 发送行为）
   ├─ 模型提供方 ~/.pi/agent/models.json + auth.json（pi 没有对应 RPC）
   ├─ 会话列表   从 pi 自己的存储实时派生
   └─ 进程注册表 每个会话一个 pi RPC 子进程（懒启动 + 空闲回收）
   ▼
node <pi>/dist/cli.js --mode rpc --session <file>   (cwd = 项目目录)
```

## 快速开始

需要 Node.js `>= 22.19`。

```sh
npx pi-web-simple
```

一个进程同时提供前端和 API，监听 <http://127.0.0.1:5319> 并自动打开浏览器——地址和下面的开发模式一致，所以不必记两个端口。不想要自动打开就设 `PI_WEB_SIMPLE_OPEN=0`。

首次使用：点击左侧栏的 **+**，在弹出的目录选择器里逐级进入目标目录（顶部快捷位置可直达主目录 / 桌面 / 文稿 / 下载 / 根目录，地址栏也可直接粘贴路径），点 **选择此目录** 添加项目；再点项目下的 **+** 新建会话开始对话。

### 从源码开发

```sh
pnpm install
pnpm dev
```

开发模式分成两个进程，改代码即时生效：

- 前端 dev server：`127.0.0.1:5319`（Vite，`/api` 反向代理到后端）
- 后端 API：`127.0.0.1:4319`

浏览器里打开的仍然是 5319，所以两种模式在地址栏没有区别。

其他命令：

```sh
pnpm build       # 构建前端 + 编译后端到 server/build
pnpm start       # 用构建产物启动（等价于 npx，端口 5319）
pnpm typecheck   # 前后端类型检查
pnpm test        # 前后端测试（vitest）
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PI_WEB_SIMPLE_HOME` | `~/.pi-web-simple` | 项目记录（`store.json`）的存放目录 |
| `PI_WEB_SIMPLE_PORT` | 开发 `4319`、发布版 `5319` | 监听端口。开发模式下这是**后端 API** 端口（Vite 反代的目标）；发布版 CLI 里这是**唯一**端口，前端和 API 都在上面 |
| `PI_WEB_SIMPLE_STATIC_DIR` | 自动探测 `web/dist` | 前端构建产物的位置。非空值即启用静态托管，空串强制只跑 API |
| `PI_WEB_SIMPLE_OPEN` | 发布版 `1` | 设为 `1` 时启动后打开浏览器；开发模式默认不开，免得抢走编辑器焦点 |
| `PI_WEB_SIMPLE_SESSION_DIR` | pi 的默认目录 | 覆盖会话存储根目录；同时作用于会话查找与派生的 pi 子进程（`--session-dir`） |
| `PI_WEB_SIMPLE_IDLE_MS` | `600000` | 会话空闲多久后回收其 pi 进程（预热进程同样适用） |
| `PI_WEB_SIMPLE_MAX_SESSIONS` | `8` | 同时存活的 pi 进程上限 |

开发模式下前端 dev server 的代理目标端口读取 `PI_WEB_SIMPLE_PORT`，两处要保持一致。

## 网络与隐私

这个工具按**单机单人、无鉴权**设计，服务端只绑定 `127.0.0.1`。上一条的 `Host`/`Origin` 校验只挡浏览器发起的跨源请求，**不是认证边界**——别把它暴露到公网，也别用反向代理把外部流量转进来。报告安全问题见 [SECURITY.md](./SECURITY.md)。

它会发起这些对外请求、并带有这些副作用；除版本检查外全部由你显式触发：

| 时机 | 目标 | 说明 |
|---|---|---|
| 启动时 | `https://pi.dev/api/latest-version` | 与 pi CLI 启动时轮询的同一个端点，只做版本比较（见 [更新提示为什么分两条路，而且都不代劳](./docs/design-notes.md#更新提示为什么分两条路而且都不代劳)） |
| 点「获取可用模型」 | 你配置的 provider 地址 | 用 `GET <baseUrl>/models` 拉取模型列表 |
| 点 MCP 的「检查」 | MCP 配置里的命令或地址 | **会真的启动那个 stdio 命令**或请求那个 URL，超时 15 秒 |
| 与模型对话 | 你配置的 provider | 会话内容按 pi 的正常行为发给模型 |

除此之外，服务端不联网、不埋点、不上报。它读到的东西都留在本机：会话正文只有 pi 一份（`~/.pi/agent/`，或 `PI_WEB_SIMPLE_SESSION_DIR` 指定的目录），项目记录与 UI 偏好在 `~/.pi-web-simple/store.json`，模型的 API 密钥由 pi 自己管理（页面只写不读，见 [模型配置为什么在改文件](./docs/design-notes.md#模型配置为什么在改文件)）。目录浏览（`/api/fs/*`）会枚举**服务端所在机器**的目录，但只列子目录名、不读文件内容。

## 已知限制

- 只在浏览器本地单机单人使用，没有账号体系；兜底的 Host/Origin 校验只挡浏览器发起的跨源请求，**不要把它暴露到公网**。
- 目录选择器浏览的是**服务端所在机器**的文件系统（本工具里就是本机）。
- 只有右侧**文件树、预览、变更面板与内嵌浏览器**，没有终端（轮次导轨是浮在对话流旁的一条窄轨，不算第三栏）。
- 变更面板**不跟文件监听联动**，要手动刷新（或点完写操作后自然重读）；不做提交详情、任意两个 revision 的对比、建分支/合并/rebase，也没有并排（side-by-side）diff 视图。
- 工具调用以「参数 + 折叠输出」的通用卡片呈现，没有针对 edit 的 diff 高亮。
- **每轮末尾的改动文件卡片只认 `write`/`edit`，也不显示行数**：`bash` 改的文件不在卡里，± 数字也不给（转录里没有权威依据，见 [每轮末尾的改动文件卡片](./docs/design-notes.md#每轮末尾的改动文件卡片)）。dsh 的同一张卡靠轮次边界的工作区快照做到这两件事，这里没有快照。
- **任务清单面板只显示最近完成的 3 条**完成项（其余折成 `+N 项已完成`），展开后的高度上限是 180px——长清单要靠滚动。转录里那次调用的展开体显示完整快照（不裁），但也有 260px 的滚动上限。
- **话题树只能看，不能把叶子移过去**：pi 没有移动 leaf 的 RPC，只有 `fork`（且仅限用户消息）。树里能分叉的节点有标记，点它走的就是分叉。
- **fork 创建的是新会话**，不是把当前会话截断；原会话一个 entry 都不会丢（已实测）。分叉后会自动切到新会话。
- 助手消息下的「赞/踩」**没有做**：pi 没有对应字段，也没有 RPC，做了也写不进任何会被读的地方。
- 「用时」是墙上时间（含工具执行），不是模型生成时间——pi 没有暴露后者。
- compaction 的可视化还没接。
- **新会话页可以选模型，但没有上下文环**：hero 上的 picker 选的是「这个即将创建的会话第一轮用哪个模型」，随首条消息交给 `POST /api/sessions`（服务端用 pi 的 `set_model` 应用它）；上下文环要的是会话的用量，没有会话就没有可显示的东西，所以 hero 上不画。
- **上下文环的数字依赖 `models.json` 里写了 `contextWindow`**：pi 内置 provider 的默认窗口不在依赖树里拿不到，所以没写这个字段的模型只显示空环（面板写「未知」），而不是去猜一个窗口。
- **上下文环在每轮结束后刷新**，不在流式过程中逐 token 更新——这个数字本来就只在模型回复完成后才有（它来自最后一条回复的 usage）。因此环不会因为一次超长回复而提前预警。
- **模型切换会启动会话进程**（如果它还没驻留）：切模型是 pi 的会话级状态，没有进程就没有对象可切。实测一次 1.7s。
- 设置页有「通用设置」「模型」「插件」和「MCP」四节；Agent 预设还没有。
- **任务清单需要 `@juicesharp/rpiv-todo` 扩展**：pi 的 `todo` 工具由这个包提供，没装时任务面板的位置显示一条安装提示，可以关掉（关掉后入口在设置 → 插件）。装完之后那一轮会话的下一条消息才加载得到它。
- **MCP 一节需要 `pi-mcp-adapter` 扩展**：pi 本身没有 MCP，所以没装那个包时这一节显示安装提示，并提供一键安装（等同 `pi install npm:pi-mcp-adapter`）。安装会跑真实的 npm 下载，可能要一分钟；加载失败不入缓存，装完刷新即可。
- **MCP 的「停用」是工作区级别的**，与 pi 自己的 `/mcp disable` 一致：没有用户级开关，没选工作区时那个按钮是禁用的。启用/停用写 `<工作区>/.pi/mcp.json`。
- **MCP 的「删除」只对可写的配置文件生效**（全局共享、`.agents`、Pi 两层 override、项目 `.mcp.json`）。来自 cursor / claude-code / codex 等别的工具的定义只能停用，因为那个文件不归 pi 也不归这一页。
- **MCP 的「检查」会真的启动配置里那个命令**（stdio）或请求那个地址（http/sse），超时 15 秒；HTTP 只做 `initialize`，不报工具数；socket（rmcp-mux）传输不支持检查。
- 模型一节不列举未配置的内置 provider（pi 需要显式的模型列表，列出来也没有可填的东西），但可以**向提供方询问它有哪些模型**。这需要 provider 有一个 API 地址：内置 provider 的默认地址不归我们管，新建的 known provider 又还没保存，所以这两种情况下要先填上地址。dsh 的限制完全一样（`fetchNeedsBaseUrl: "请先填写 API 地址，再获取。"`）。
- 模型写入只对真实 pi 做过**读**的验证；写入用临时栈验证过（包括中途发现并修掉的字段丢失），但用户全局 `~/.pi/agent/*.json` 的写入每次都会先备份再原子替换。
- 模型状态点只反映两个配置文件，**环境变量提供的密钥看不到**（`@earendil-works/pi-ai` 不在依赖树里，拿不到它的 `findEnvKeys`）。措辞已经收敛成「配置文件里没有 API 密钥」，不会断言成「未配置」使环境变量用户去做多余操作。
- 没有「权限」和「语言」两项：前者在 pi 侧没有对应概念（`trust` 管的是项目动态配置的信任，不是工具执行级别），后者在单语言项目里只有一个选项。
- 设置页的下拉用原生 `<select>`：外壳是自绘的，展开的菜单是系统的。换取的是键盘、读屏、首字跳转全部由平台提供，不必重新发明一遍。
- 代码高亮走的是 dsh 的静态路径（`codeToHtml` + `css-variables` 主题），但没有移植它的流式增量 tokenizer：代码块每变化一次就全量重新高亮，因此超过 2 万字符的栅栏直接显示为纯文本（dsh 无此上限）。
- **图片以 base64 原样进会话文件**：`data` 不落盘到别处，所以一张 5MB 的截图会把那条消息撑大 6.7MB 左右，而这个会话之后的每次磁盘读取都要带上它（`buildSessionContext()` 不裁剪内容块，只按 compaction 走树）。上限是 8 张/条、5MB/张，但没有对整条消息的总量再设一道闸。
- **图片只认 `png/jpeg/gif/webp`**，`svg` 会被明确拒绝（它是文档而不是图片）；也不做压缩与缩放，发出去的就是粘贴进来的那份字节。
- `web/src/features/dev/TokenPreview.tsx` 是设计系统的自检页，不在路由里；需要时把 `App.tsx` 临时指向它即可。

## 文档

| 文档 | 内容 |
|---|---|
| [设计说明](./docs/design-notes.md) | 项目结构、与 pi CLI 的进程模型，以及每处设计取舍的理由 |
| [贡献指南](./CONTRIBUTING.md) | 环境要求、提交前检查、提交信息与 PR 约定 |
| [更新日志](./CHANGELOG.md) | 各版本的变更记录 |
| [安全策略](./SECURITY.md) | 漏洞报告方式与适用范围 |
| [第三方声明](./THIRD_PARTY_NOTICES.md) | 移植与依赖的来源清单 |

## 许可证

MIT，见 [LICENSE](./LICENSE)。

界面与部分服务端逻辑移植、改编自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，Copyright (c) 2026 DeepSeek）与 [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)（MIT）。逐字节复制的范围与来源清单见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)——该文件随源码分发，请勿移除。

本项目是非官方项目，与 pi（Earendil Works）和 DeepSeek 均无隶属关系；π 名称与标识归各自所有者。

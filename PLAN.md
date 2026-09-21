# pi-web-simple — 基于 pi 的项目管理 Web UI

## Context

用户想要一个「类 deepseek-harness 的项目管理」，但：

- **内核是 pi**（`@earendil-works/pi-coding-agent`，本机 v0.86.1），不是 dsh 自己的 agent loop。
- **UI 与项目管理风格直接照搬 deepseek-harness**（dsh）的 Web UI。
- 目录名 `pi-web-simple` 定调：**不做** dsh 的 Cordis「一切都是插件」架构，用普通分层，只保留「能力可替换」的精神。

已与用户确认的决策：

| # | 决策 | 结论 |
|---|---|---|
| 1 | 「项目管理」语义 | = dsh 的 **Workspace** 模型：一个本地目录 = 一个项目，项目下挂该目录的会话 |
| 2 | 项目数据存储 | **自建 DB**（不复用 pi 目录扫描作为唯一真源） |
| 3 | pi 接入 | **RPC 子进程**（`pi --mode rpc`），非进程内 SDK |
| 4 | 与 CLI 并存 | **允许** Web 与终端 `pi` 同时打开同一会话 |
| 5 | 形态 | 只做 **Web**（浏览器访问 localhost），不做 Electron/移动端 |
| 6 | 部署 | **单机单人**，无鉴权 |
| 7 | 第一版范围 | **项目 + 会话列表**、**对话流** |
| 8 | 前端栈 | **照搬 dsh**：React + Vite + CSS Modules + clsx，无 Tailwind、无组件库 |
| 9 | 架构 | 不要 Cordis，普通分层 |

## 调研结论（决定实现方式的事实）

### dsh 的 Workspace 模型（要复刻的语义）

来源：`/tmp/dsh-probe/docs/subsystems/workspace.md`、`packages/client/ui-workspace/README.md`

- `Workspace = { id(uuid), path(realpath 规范化), title, createdAt, updatedAt, sessionIds(有序) }`。
- 路径唯一性 = **规范化路径字符串相等**（`fs.realpath` 解掉软链/`..`/尾斜杠）。
- 会话归属校验：`SessionHeader.cwd` 规范化后必须等于 workspace 的 `path`。
- **删除项目不删目录、不删会话历史**，会话回落为 Ungrouped。
- 侧栏浏览能力：分组/扁平列表、添加/重命名/重排、搜索、fork、archive、Workspace Tree 嵌套。

### dsh 的 UI 设计系统（要照搬的视觉规范）

来源：`/tmp/dsh-probe/docs/web-styling.md`、`packages/client/ui-theme/src/styles/`

- **令牌分两层**：静态色阶 `--dsw-static-<color>-<step>` + 语义别名 `--dsw-alias-*`（共 **83 个**，如 `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-border-l1/l2/l3`、`--dsw-alias-button-primary-fill`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-link`）。**功能组件只消费语义别名，不写字面颜色。**
- 字体栈：`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', ...`；代码字体 `SF Mono / JetBrains Mono / Fira Code / Consolas`。
- 动效：`cubic-bezier(0.4, 0, 0.2, 1)`，0.1 / 0.2 / 0.3s 三档。
- 圆角：`corner-shape: superellipse(1.5)` 超椭圆（`@supports` 内生效）；全圆元素（50%/100%/pill）须显式配 `corner-shape: round`。
- **中性实心边框一律 0.5px**（Chromium 渲染为 1 物理像素）；浮层不用边框，改用阴影。
- 浮层阴影（`gradient-shadow-text.css`，第一层就是 0.5px 描边）：
  ```css
  --dsw-elevation-stroke: 0 0 0 0.5px var(--dsw-elevation-stroke-color);
  --dsw-elevation-panel: var(--dsw-elevation-stroke), 0 3px 8px rgba(0,0,0,.03), 0 0 16px rgba(0,0,0,.02);
  --dsw-elevation-prominent: var(--dsw-elevation-stroke), 0 3px 8px rgba(0,0,0,.04), 0 0 20px rgba(0,0,0,.05);
  --dsw-elevation-soft: var(--dsw-elevation-stroke), 0 4px 16px rgba(0,0,0,.03), 0 0 24px rgba(0,0,0,.03);
  ```
  **禁止**把 `--dsw-alias-border-*` 边框和 elevation 阴影配在一起。
- 其他：滚动条、shiki 代码高亮、渐变/shadow-text 都有现成 token 表。
- 视觉基调（截图 `docs/user/guide/providers-models-page.png`）：浅灰底 + 白卡片 + 大圆角 + 黑实心主按钮 / 白底描边次按钮。

### pi 的复用点（**已确认全部可公开导入**）

`@earendil-works/pi-coding-agent` 的 `package.json#exports` 只有 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`，但 `dist/index.d.ts` 已 re-export 我们需要的一切：

| 复用物 | 来源 | 用途 |
|---|---|---|
| `RpcClient` | `dist/modes/rpc/rpc-client` → index 导出 | 官方 typed RPC 客户端，含 `prompt/steer/followUp/abort/getMessages/getState/setModel/compact/fork/switchSession/waitForIdle/onEvent` |
| `SessionManager.list(cwd, sessionDir?, onProgress?, signal?)` | `dist/core/session-manager` | 列出某目录的会话，返回 `SessionInfo[]` |
| `SessionInfo` | 同上 | `{ path, id, cwd, name?, parentSessionPath?, created, modified, messageCount, firstMessage, allMessagesText }` — 会话列表所需数据全有，`allMessagesText` 还能直接做搜索 |
| `SessionHeader` | 同上 | `{ type:"session", version?, id, timestamp, cwd, parentSession? }` — 项目归属依据 |
| `getPackageDir()` | `dist/config` | 解析包内绝对路径（见下方「坑」） |
| `RpcSessionState` | index 导出 | `{ model, thinkingLevel, isStreaming, sessionFile?, sessionId, sessionName?, messageCount, ... }` |

**RPC 协议要点**（`docs/rpc.md`，1618 行，命令/事件清单已核对）：

- 帧格式：严格 **JSONL，仅以 `\n` 为分隔**（`\r\n` 需剥离尾部 `\r`）。官方明确警告 **Node `readline` 不合规**（它会额外在 `U+2028/U+2029` 断行，而这两个字符在 JSON 字符串内是合法的）。
- 命令：`prompt` / `steer` / `follow_up` / `abort` / `clear_queue` / `new_session` / `get_state` / `get_messages` / `set_model` / `set_thinking_level` / `compact` / `bash` / `switch_session` / `fork` / `clone` / `get_entries` / `get_tree` / `get_session_stats` / `set_session_name` / `get_commands` …
- 事件：`agent_start` / `agent_end` / `agent_settled`（真正空闲）/ `turn_start|end` / `message_start|update|end` / `tool_execution_start|update|end` / `bash_execution_update` / `queue_update` / `compaction_*` / `auto_retry_*` / `extension_error`。
- 流式：`message_update` 携带 `assistantMessageEvent`，delta 类型为 `text_start|text_delta|text_end` / `thinking_start|delta|end` / `toolcall_start|delta|end`；**没有累积快照**，客户端需按 `contentIndex` 自行拼装，以 `message_end.message` 为权威。
- 审批：**pi 没有内置的工具审批弹窗**。只有扩展通过 `ctx.ui.confirm/select/input/editor` 发起，在 RPC 下变成 `extension_ui_request`（stdout）+ `extension_ui_response`（stdin）的阻塞子协议；`notify/setStatus/setWidget/setTitle/set_editor_text` 是 fire-and-forget。

**关键坑（必须处理）**：`RpcClient.start()` 内部是
```js
spawn("node", [cliPath, "--mode", "rpc", ...args], { cwd: options.cwd })
```
其中 `cliPath` 默认值是**相对路径 `"dist/cli.js"`**，而 `cwd` 是项目目录 —— 直接默认构造必然 spawn 失败。所以必须显式传 `cliPath: path.join(getPackageDir(), "dist/cli.js")`。`--session <path>` 等参数通过 `options.args` 追加。

## Approach

三层，无插件框架：

```
浏览器 (React + Vite + CSS Modules)
   │  POST /api/*            上行命令
   │  GET  /api/events (SSE)  下行事件
   ▼
Node 服务端 (单进程)
   ├─ projects.ts    workspace CRUD（realpath 规范化 + 唯一性）
   ├─ store.ts       项目持久化（JSON 原子写）
   ├─ sessions.ts    会话列表 = SessionManager.list(project.path)
   ├─ registry.ts    会话进程注册表：sessionId → RpcClient（懒启动 + 空闲驱逐）
   ├─ bus.ts         事件总线 → SSE 广播
   └─ watch.ts       session jsonl 文件监听（CLI 并存场景）
   ▼
pi RPC 子进程池： node <pkgDir>/dist/cli.js --mode rpc --session <file>   (cwd = project.path)
```

### 数据模型（决策 2 的落地）

DB 只存**项目记录**，会话列表**从 pi 实时派生**——这是让「Web 与 CLI 并存」（决策 4）成立的前提：

```jsonc
// ~/.pi-web-simple/store.json   （原子写：写 tmp → rename）
{
  "version": 1,
  "projects": [
    {
      "id": "uuid",
      "path": "/abs/realpath",      // 规范化后的绝对路径
      "title": "pi-web-simple",      // 默认取末段
      "order": 0,
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601"
    }
  ],
  "sessionOverrides": {              // 可选，仅存 UI 偏好
    "<sessionPath>": { "name": "...", "hidden": true }
  }
}
```

- 项目列表来自 `store.json`；会话列表来自 `SessionManager.list(project.path)`，按 `modified` 倒序（等价 dsh 的 **Last updated** 模式）。
- 手动排序 / 隐藏这类偏好写 `sessionOverrides`，**不改 pi 的 jsonl**，因此永远不与 CLI 分叉。
- 删除项目只删记录，**不删目录、不删会话**（对齐 dsh 语义）。

### 会话生命周期与并发规则

- 打开会话 → `registry.acquire(sessionPath, cwd)`：若已有存活 `RpcClient` 复用，否则 spawn。
- 首次 acquire 后立刻 `getMessages()` 作为历史快照返回给前端，随后只推增量事件（避免前端从零重放）。
- 空闲 **10 分钟**自动 `stop()`（LRU，上限如 8 个活跃进程）。
- **同会话单写者**：Web 侧保证每个 session 文件最多一个 `RpcClient`。若开 Web 时终端已有 `pi` 在写同一文件 → 文件监听检测到外部追加 → 推 `session_external_changed` 事件 → 前端展示「外部已更新」条幅，点击后重启该会话的 RpcClient 并重新拉取 `getMessages()`。这是决策 4 的取舍（不静默合并，避免 leaf 互相覆盖）。

### 视觉与交互（照搬 dsh）

- 从 `/tmp/dsh-probe/packages/client/ui-theme/src/styles/` 移植整套 token：`design-platform.css`（static 色阶 + 83 个 alias）、`base.css`（字体/缓动）、`corner-shape.css`（超椭圆）、`scrollbar.css`、`shiki.css`。**保留 `--dsw-*` 前缀不改名**，便于后续与 dsh 对照。
- 三栏布局对齐 dsh：左侧栏（项目 + 会话）、中间对话、右侧留空占位（第一版不实现右栏）。
- 对话流渲染优先级：用户消息 → assistant 文本（Markdown + shiki 高亮）→ thinking（默认折叠）→ 工具调用（折叠卡片）。工具卡片第一版做**简版**：工具名 + 关键参数 + 折叠的分节输出，不做 diff 高亮。

## Files to modify

全新项目，以下为待创建结构：

```
pi-web-simple/
├── package.json                 # pnpm workspaces: server, web
├── PLAN.md
├── server/
│   ├── package.json
│   └── src/
│       ├── index.ts             # HTTP 入口（原生 node:http）+ 静态资源
│       ├── store.ts             # JSON 持久化（原子写）
│       ├── projects.ts          # workspace CRUD + realpath 规范化/唯一性
│       ├── sessions.ts          # SessionManager.list 封装 + override 合并
│       ├── registry.ts          # RpcClient 池：懒启动 / 空闲驱逐 / 单写者
│       ├── bus.ts               # 事件总线 → SSE
│       ├── watch.ts             # session 文件外部变更检测
│       └── routes.ts            # REST + SSE 路由
└── web/
    ├── package.json
    ├── vite.config.ts           # /api → server 代理
    ├── index.html
    └── src/
        ├── main.tsx
        ├── theme/               # 移植自 dsh ui-theme 的 token（design-platform / base / corner-shape / scrollbar / shiki）
        ├── lib/api.ts           # fetch 封装
        ├── lib/sse.ts           # 事件流客户端
        ├── lib/store.ts         # React-free observable（对标 dsh 的 store 包）
        ├── layout/AppLayout.tsx + .module.css
        ├── features/projects/   # 项目列表 + 添加/重命名/删除/排序
        ├── features/sessions/   # 会话列表
        └── features/conversation/
            ├── Conversation.tsx
            ├── MessageList.tsx  # 按 contentIndex 拼装流式消息
            ├── ThinkingBlock.tsx
            ├── ToolCallCard.tsx
            └── Composer.tsx
```

## Reuse

| 要复用的东西 | 位置 |
|---|---|
| `RpcClient`、`SessionManager`、`SessionInfo`、`getPackageDir`、`RpcSessionState` | `@earendil-works/pi-coding-agent` 主入口（已确认导出） |
| dsh 全部设计令牌与基础样式 | `/tmp/dsh-probe/packages/client/ui-theme/src/styles/*.css` |
| dsh 侧面栏/对话的视觉规格与交互约定 | `/tmp/dsh-probe/packages/client/ui-workspace/README.md`、`packages/client/ui-chat/`、`docs/web-styling.md` |
| dsh 的 Workspace 语义与校验规则 | `/tmp/dsh-probe/docs/subsystems/workspace.md` |

> 注意：`/tmp/dsh-probe` 是本次调研的临时 clone（`--depth 1`）。实现阶段应把需要的 CSS 直接复制进 `web/src/theme/`，**不要**把 dsh 作为依赖引入。

## Steps

- [x] **S1 工程骨架**：pnpm workspace（`server` + `web`），TS 配置，`web` Vite 起 React + CSS Modules，`server` 用 `tsx` 直跑。
- [x] **S2 移植主题**：从 dsh clone 复制 5 个 token 样式表到 `web/src/theme/`，装配 `corner-shape` 与 elevation，做一个 token 预览页自检。
- [x] **S3 项目数据层**：`store.ts`（原子写）+ `projects.ts`（`fs.realpath` 规范化、路径唯一性、创建/重命名/删除/排序）。
- [x] **S4 会话列表**：`sessions.ts` 用 `SessionManager.list(project.path)` 派生，合并 `sessionOverrides`，按 `modified` 排序。
- [x] **S5 RPC 桥接**：`registry.ts` 包 `RpcClient`（**显式传 `cliPath`**，`cwd = project.path`，`args = ['--session', file]`），实现 acquire/release/idle 驱逐与单写者约束。
- [x] **S6 传输层**：`bus.ts` + SSE 端点；上行 REST（`POST /api/sessions/:id/prompt|steer|abort`、`POST /api/projects` 等）。
- [x] **S7 外部变更检测**：`watch.ts` 监听 jsonl `mtime`，区分本进程写入与外部写入，推 `session_external_changed`。
- [x] **S8 前端骨架**：三栏 `AppLayout`，左侧栏接项目/会话列表。
- [x] **S9 对话流**：SSE 接入 + `message_update` 按 `contentIndex` 增量拼装 + Markdown/shiki 渲染 + thinking 折叠 + 工具卡片 + Composer（含 streaming 时的 steer/follow-up 行为选择）。
- [x] **S10 兜底**：`extension_ui_request` 的 `notify` 展示；`confirm/select/input/editor` 做最小可用弹窗（避免扩展阻塞死锁）。
- [x] **S11 文档**：README 写清启动方式与「与 CLI 并存」的行为边界。

## Verification

**端到端手工验证**

1. `pnpm dev` → 浏览器打开，左侧栏空白，点「添加项目」选一个真实目录 → 项目出现，标题为目录末段。
2. 在该项目下新建会话 → 发 prompt → 观察流式 text_delta 逐步渲染、thinking 出现并可折叠、若模型调工具则出现工具卡片。
3. **CLI 并存验证（决策 4 的关键）**：终端执行 `pi --session <该会话的 jsonl 路径>` 追加一轮对话 → Web 端应出现「外部已更新」条幅；点击刷新后能看到 CLI 那轮内容，且 Web 不会再往该会话写（直到重启 RpcClient）。
4. 重启 Web 进程 → 项目列表仍在（`store.json` 持久化），会话列表仍从 pi 目录正确派生。
5. 删除一个项目 → UI 中消失，`ls` 确认目录与会话 jsonl **均未被删除**；该会话落到「未分组」区。
6. 边界：路径带软链时，添加同一目录的两种写法 → 只应存在一条记录（`realpath` 去重生效）。

**自动化**

- `server` 侧对 `projects.ts`（路径规范化/唯一性）与 `sessions.ts`（override 合并、排序）写 vitest 单测。
- RPC 桥接用一个假 `pi` 脚本（或 pi 的 mock LLM server）验证 acquire/release/空闲驱逐与 JSONL 帧解析（重点覆盖 `\r\n` 与含 `U+2028` 的字符串）。

## 默认取舍（可直接否掉）

已按「simple」取向预选，若你有不同偏好请指出：

1. **持久化用 JSON 文件 + 原子写**，而非 `node:sqlite`（本机 Node v22.23.2 的 `node:sqlite` 可用但仍是 experimental；单机单人下 JSON 足够且零依赖）。
2. **服务端用原生 `node:http`** 而非 Hono/Express（路由量小，少一层依赖）。
3. **工具调用第一版做简版卡片**（工具名 + 参数 + 折叠输出），不做 dsh 级的 diff 高亮与流式 bash 视图。
4. **下行用 SSE 而非 WebSocket**（事件单向足够，上行走 POST；审批弹窗用 POST 回执）。

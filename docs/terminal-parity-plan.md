# 终端功能对齐方案

对齐基准：`/Users/milan/Downloads/deepseek-harness-master`（下称 dsh）的
`packages/client/ui-sidebar-terminal`、`packages/api/terminal-controller` 与
`apps/web/tests/sidebar-terminal.e2e.ts`。

> **状态（2026-10-22）**：按推荐决策（D1 主机默认 shell、D2 接受
> `@xterm/headless` + `@xterm/addon-serialize`、D3 不做 agent 工具）已实现
> 阶段 0–3。实现后的行为以 [`known-limitations.md`](./known-limitations.md)
> 与 [`design-notes.md`](./design-notes.md) 为准；本文保留为当时的方案与差距记录。

---

## 0. 结论

不移植 dsh 的 `remote.mux` WebSocket RPC 和插件 slot/face 框架。保留
pi-web-simple 现有的 **HTTP + SSE** 架构，把终端从“一个能跑 bash 的 xterm”
升级为“**服务端会话 + 客户端附件（attachment）**”模型，对齐 dsh 侧栏终端
**用户可观察的行为**：

- 从已安装 shell 里选，选择被记住；
- 标签名由服务端持有，双击原地改；
- 同一时刻只有一个窗口能输入，其余显示“只读 / 接管”；
- 断线、重连、刷新后回到同一个进程和同一屏内容；
- 退出的 shell 保留屏幕与退出码，不自动重启；
- 进程不在时显示“不可用 + 新建”，而不是偷偷换一个新的；
- 关标签立即消失、进程后台结束，失败可重试；
- 配额、尺寸、输入长度、空闲回收都有明确上限；
- 主题切换即时生效，正文对比度不低于 4.5:1，光标不低于 3:1。

Agent 端的 6 个 `terminal_*` 工具不在本期。当前项目没有这套工具，属于
“新增能力”，不是“对齐”，放到可选的第四阶段。

---

## 1. 范围

### 1.1 本期做（P0/P1）

| 编号 | 能力 | 优先级 |
| --- | --- | --- |
| T1 | shell 发现、选择、记忆、创建时指定 | P0 |
| T2 | 服务端会话状态（running/exited/failed + exitCode/error） | P0 |
| T3 | 附件模型：单一输入控制者、只读、接管 | P0 |
| T4 | 快照 + 输出序号，重连/刷新后屏幕正确 | P0 |
| T5 | 刷新恢复：绑定终端身份；缺失时“不可用”面板 | P0 |
| T6 | 退出/失败视图，保留屏幕，New terminal 不自动重启 | P0 |
| T7 | 关闭流程：立即移除、后台清理、失败重试 | P1 |
| T8 | 配额：8 个，含已退出/失败/创建中；幂等创建 | P1 |
| T9 | 尺寸/输入校验：500×200、64 KiB、UTF-8 字节 | P1 |
| T10 | 空闲回收：附件心跳 + 2 小时无人使用 | P1 |
| T11 | 主题即时切换、对比度、光标可见性 | P1 |
| T12 | 标签页右键重命名改为服务端标题 + 双击原地编辑 | P1 |

### 1.2 明确不做

- **不搬 `remote.mux`**：dsh 的 Remote 流是它插件/多宿主架构的一部分，
  这里只有一个同源进程，SSE 足够。
- **不做逐帧渲染 ack 和每附件独立流**：本地回环下收益低于复杂度。
  用“单调序号 + 快照兜底 + 客户端缓冲”达到同样的可见结果。
- **不做 dsh 的窗口 holds 精确判定**：`node-pty` 没有
  `inspectActivity()` 的等价物，无法知道“前台有构建在跑”。用
  “附件心跳 + 输出/输入空闲”近似，并在文档里写明这一条差异。
- **不做多窗口各自复制进程**：dsh 在两个窗口恢复同一 tab id 时会各开
  一个进程；这里让两个窗口 attach 到同一个终端，后 attach 者获得输入权。
  单机单用户场景下这更符合直觉，也避免出现无人认领的孤儿进程。
- **不做 agent `terminal_open/send/read/signal/close/list`**（见 4.5）。

---

## 2. 现状

### 2.1 服务端

`server/src/terminal.ts`

- `TerminalManager` 直接持有 `Map<id, TerminalRecord>`，记录 PTY、scrollback、
  待发布输出和 exitCode。
- 常量 `MAX_TERMINALS = 8`、`SCROLLBACK_LIMIT = 128 * 1024` 字符、
  `FLUSH_MS = 16`。
- `pickShell()` 固定优先 `/bin/bash`，没有发现和选择。
- 快照就是原始字符回放，截断可能切在转义序列中间。
- 没有状态机（只有 `exitCode: number | null`）、没有附件、没有序号、
  没有输入上限、没有空闲回收。
- 关闭是同步的：`close()` 立刻删除记录并 `kill()`，失败没有重试。

`server/src/routes.ts:2211-2275`

- `GET /api/terminal`、`POST /api/terminal`、`GET /api/terminal/:id`
  （scrollback）、`POST /:id/input`、`POST /:id/resize`、`DELETE /:id`。
- `POST` 不接受 shell；`input/resize` 不区分调用者。

`server/src/bus.ts:33-35`

- `terminal_output` 只有 `{terminalId, sessionPath, data}`；
  `terminal_state` 只有 `{terminalId, sessionPath, exitCode}`。

### 2.2 客户端

`web/src/features/rightbar/terminal-state.ts`

- 输出走 `outputListeners`，不进 React；`terminalStore` 只有 support 和
  按会话的 `TerminalInfo[]`。
- `attachShell()`：先 refresh，能按 `tab.target` 找到活着的就回放
  scrollback，否则检查 `support` 后直接开一个新的。
- `release()` = 从 store 忘掉 + `DELETE`，不等待、不重试。

`web/src/features/rightbar/TerminalTab.tsx`

- xterm + FitAddon，字号 12、行高 1.2、scrollback 5000。
- 主题在 mount 时从 CSS token 读一次，之后不再更新。
- 挂载时 attach，`term.onData` 直接写；`ResizeObserver` fit 后 resize。
- 退出显示 `terminal.exited` 和“重新启动”；失败只显示一行错误。
- 没有只读、接管、重连、不可用这些状态。

`web/src/features/rightbar/PaneView.tsx:398-522`

- “+”菜单里的“终端”直接开新标签；没有 shell 菜单，也没有空窗格引导卡。

`web/src/features/rightbar/TabMenu.tsx`

- 右键菜单的“重命名”走 `window.prompt`，名字存在布局里。

`web/src/features/rightbar/close-tabs.ts`

- 关标签时对 `tab.target` 调 `terminalActions.release()`，即发一个
  `DELETE` 然后忘掉。

---

## 3. 差距矩阵

| 能力 | dsh | 当前 | 本期处理 |
| --- | --- | --- | --- |
| 新建入口 | 空栏引导卡 + “New terminal”+ shell 菜单；已运行 shell 直接复用 | 只有 “+” 菜单项 | 加终端引导卡与 shell 下拉；“+” 菜单保留 |
| shell 发现 | 环境默认 + 候选列表（zsh/bash/fish/pwsh/powershell/cmd），去重 | 固定 bash | `GET /api/terminal/shells` + 记忆选择 |
| 默认 shell | 宿主默认（mac 上 zsh） | 固定 bash | 见决策 D1 |
| 标题 | 服务端 title，广播，双击原地改 | 布局 title + prompt | 服务端 title + 双击编辑 |
| 输入权 | 附件唯一控制者，其他只读 + Take control | 所有窗口都能写 | attachment/controller |
| 断线 | 显示 Reconnect，进程与屏幕保留 | EventSource 自动重连，无状态提示 | 连接阶段 + 快照重连 |
| 快照 | headless xterm 序列化屏幕 | 原始字符回放，可能截断转义 | `@xterm/headless` + serialize |
| 序号 | 单调 sequence，缺口报错/恢复 | 无 | sequence + 缺口检测 |
| 状态 | running/exited/failed + error | 只有 exitCode | 完整 info |
| 退出 | 保留屏幕，New terminal，不自动重启 | 保留屏幕，Restart（会先杀旧） | 对齐文案与“不自动”语义 |
| 关闭 | 标签立即消失，后台清理，失败可重试 | fire-and-forget DELETE | 关闭队列 + 重试 |
| 配额 | 8，含退出/失败/预留，创建幂等 | 8，含退出；无幂等/预留 | 预留 + 幂等 |
| 空闲回收 | 2h 无人使用 | 无 | 心跳 + 2h |
| 刷新恢复 | 保存绑定；进程缺失显示不可用 + New terminal | 找不到就静默新建 | 对齐 |
| 主题 | 即时切换，正文 4.5:1、光标 3:1 | 仅挂载时读一次 | observer + minimumContrastRatio |
| 尺寸/输入 | 500×200、64 KiB、校验后执行 | 2…1000、无输入上限 | 校验 + 413/400 |
| Agent 工具 | 6 个 `terminal_*` | 无 | 第四阶段可选 |

---

## 4. 目标模型

### 4.1 服务端：一个终端是一个有状态的会话

把 `TerminalManager` 重构成“管理器 + 会话”：

```ts
type TerminalLifecycle = "starting" | "running" | "exited" | "failed";

interface TerminalShell {
  path: string;
  name: string;
  args: string[]; // zsh/bash/fish: ["-i"]; pwsh/powershell: ["-NoLogo"]; cmd: []
}

interface TerminalInfo {
  id: string;
  sessionPath: string;
  title: string;
  shell: TerminalShell;
  cwd: string;
  cols: number;
  rows: number;
  state: TerminalLifecycle;
  exitCode: number | null;
  error?: string;
  controllerId?: string;
}

interface TerminalEnvironment {
  cwd: string;
  maxCols: 500;
  maxRows: 200;
  maxInputBytes: 65536;
  scrollback: 1000;
}
```

每个 `TerminalSession` 持有：

- `info`：上面那份；
- `pty`；
- `screen`：`@xterm/headless` 的 `Terminal` + `@xterm/addon-serialize`；
- `sequence`：每发布一帧 `+1`；
- `attachments: Map<attachmentId, { lastSeen: number }>`；
- `controllerId`：最后 attach 的附件；
- `pending`：16ms 合并中的输出；
- `writeChain`：保证 `screen.write`、snapshot、publish 的顺序；
- `closing / closeFailure`：后台清理状态。

关键不变量：

1. 输出先写 headless screen，再发布；`snapshot` 在读屏前等待写队列排空。
2. `sequence` 只在发布一帧时递增；snapshot 携带它包含到的序号。
3. 除 `snapshot` 外，所有写操作（input/resize）都要求
   `controllerId === attachmentId`。
4. `close()` 先从列表移除并标记 closed，再异步 kill；失败保留记录并重试。
5. 配额统计 `starting/running/exited/failed`，创建期间的预留也计数。

### 4.2 协议（HTTP + SSE）

新增/调整：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/terminal/shells` | `{shells, default}`，已安装且可执行 |
| GET | `/api/terminal?sessionPath=` | `{support, environment, terminals}` |
| POST | `/api/terminal` | 创建；body 可带 `id`，同 id 幂等 |
| POST | `/api/terminal/:id/attach` | 建立附件；返回 `{info, screen, sequence, environment}`；接管输入 |
| POST | `/api/terminal/:id/detach` | 释放附件；若它是控制者则清空 |
| POST | `/api/terminal/:id/input` | `{attachmentId, data}`；非控制者 409 |
| POST | `/api/terminal/:id/resize` | `{attachmentId, cols, rows}`；钳制后广播 |
| GET | `/api/terminal/:id/snapshot` | 只读快照，不改变控制者（缺口恢复用） |
| PATCH | `/api/terminal/:id` | `{title}`；trim 后广播 |
| DELETE | `/api/terminal/:id` | 立即移除；幂等；返回 `{closed}` |
| POST | `/api/terminal/:id/heartbeat` | 续租；空闲回收用 |
| GET | `/api/terminal/cleanup` | 失败的后台清理列表（可选） |
| POST | `/api/terminal/cleanup/:id/retry` | 重试清理（可选） |

创建请求：

```json
{
  "id": "term-uuid",
  "sessionPath": "/path/to/session.jsonl",
  "cwd": "/path/to/project",
  "shellPath": "/bin/zsh",
  "cols": 100,
  "rows": 30
}
```

- `id` 由客户端生成（`crypto.randomUUID()`），使“发出请求后标签被关”
  和“网络重试”不会开出两个进程。
- `cwd` 仍走现有的 `terminalCwd()` 校验。
- `shellPath` 必须在发现列表里；不在则 400。
- 上限 8 → 409 `terminal/limit-reached`，body 带 `{limit}`。
- 无 node-pty → 503，现有行为保留。

SSE 事件：

```ts
| { type: "terminal_output"; terminalId; sessionPath; sequence: number; data: string }
| { type: "terminal_state"; terminalId; sessionPath; info: TerminalInfo }
| { type: "terminal_closed"; terminalId; sessionPath }
| { type: "terminal_cleanup_failed"; terminalId; sessionPath; message: string }
```

`wantsFrame()` 继续按 `sessionPath` 过滤；`sequence` 是每个终端独立的。

### 4.3 客户端：视图状态机

新增 `web/src/features/rightbar/terminal-view.ts`（或把
`terminal-state.ts` 拆成 store + view）：

```ts
type Phase =
  | "idle" | "loading" | "creating" | "connecting" | "connected"
  | "disconnected" | "read-only" | "exited" | "failed" | "unavailable";
```

每个终端视图的记录：

```ts
interface TerminalView {
  phase: Phase;
  info: TerminalInfo | null;
  screen: string | null;      // 最近一次 snapshot
  sequence: number;           // 已应用到的输出序号
  writable: boolean;
  error?: string;
  retry?: "reconnect" | "retry" | "new-terminal";
}
```

`TerminalTab` 只负责画：xterm、FitAddon、主题、键盘、尺寸。挂载流程：

1. 订阅本终端的输出（先订阅，进缓冲）。
2. `tab.target` 为空 → `POST /create`（id 预生成）→ 得到 info。
3. 非空 → `POST /attach`；404 → 若标签从未成功打开过则新建，否则
   `unavailable`。
4. 收到 `{screen, sequence}`：`term.reset(); term.resize(cols, rows);
   term.write(screen)`，把缓冲里 `sequence > snapshot.sequence` 的帧按序写入。
5. 序号缺口 → `GET /snapshot`（不抢控制权）并重放；仍失败 → 重新 attach。

输入：

- `writable = info.state === "running" && info.controllerId === myAttachmentId`。
- 不可写时 `term.options.disableStdin = true`，底部一条“只读 / 接管”。
- 接管 = 用新 attachmentId 重新 attach（dsh 的 `connect()` 同义）。
- `onData` 按 UTF-8 字节计数排队，超过 64 KiB 丢弃并提示，不把整段塞进一个
  POST。

重连：

- EventSource 断开 → `disconnected`，显示 Reconnect（不显示传输诊断）。
- `onopen` 后重新 attach；先重置屏幕再写快照。
- 页面隐藏/侧栏折叠只 detach，不 kill。

关闭：

- 关标签先删布局、立刻从屏幕移除；
- 后台 `DELETE`；失败放进 `localStorage["pi-web-simple.terminal.close.v1"]`，
  页面启动时重试，并在角落显示可重试的提示。
- `beforeunload` 用 `sendBeacon` 发 detach，减少悬挂附件。

### 4.4 生命周期与回收

- **配额**：8。`starting/running/exited/failed` 都算；“创建中”用预留占位。
- **幂等创建**：id 已存在且 `sessionPath` 相同 → 返回现有 info；不同 →
  409。id 已在 `closedIds` 墓碑里 → 409（不允许复活）。
- **关闭**：`closed` 先从 `list()` 消失，广播 `terminal_closed`；PTY kill
  异步；失败 → `cleanup_failed`，60s 后自动重试，同时允许手动重试。
- **空闲回收**：客户端每 30s `heartbeat`；90s 没心跳的附件视为失效；
  终端连续 2h 无附件、无输入、无输出 → 关闭。`exited` 同样回收。
  这是对 dsh `unattendedTimeoutMs` 的近似，不探测前台任务。
- **会话关闭**：沿用 `closeForSession()`，但改成异步清理并记录失败。

### 4.5 可选第四阶段：Agent 端 `terminal_*`

dsh `packages/terminal/tool-terminal` 的 6 个工具（open/send/read/signal/
close/list）是另一条产品线：模型需要的是有界读取、等待原因、后台任务，
而不是 xterm 屏幕。当前 pi-web-simple 的 agent 侧没有这套工具，建议单独立项：

- 复用本方案的 `TerminalManager`，但输出缓冲换成“有界队列 + 增量读取”；
- 增加 `TerminalWaitReason`（`stdin_read | inferred_idle | timeout |
  session_exit`）和后台 send；
- 新建 `extensions/terminal.ts` 注册工具，走 pi 的扩展 API；
- 不把 UI 的 attachment/controller 暴露给模型。

工作量约 3–5 人日，且需要单独设计工具文案与测试。本期不做。

---

## 5. 分阶段实施

### Phase 0：契约与壳发现（0.5–1 人日）

**改动**

- `server/src/terminal.ts`
  - 新增 `TerminalShell`、`TerminalInfo` 新字段、`TerminalEnvironment`、
    常量（500/200/64KiB/1000 行/2h/30s）。
  - `discoverShells()`：默认 shell（`$SHELL` → `/bin/sh` → Windows
    `ComSpec`）+ `shellCandidates`（zsh/bash/fish/pwsh/powershell/cmd），
    逐项验证可执行，按 basename 去重。
  - `pickShell()` 保留为兼容导出，内部改为调用发现逻辑。
- `server/src/routes.ts`
  - 新增 `GET /api/terminal/shells`。
  - `GET /api/terminal` 返回 `environment`。
- `web/src/lib/api.ts`、`web/src/lib/types.ts` 同步类型。

**验收**

- `pnpm --filter @pi-web-simple/server test` 通过。
- `curl /api/terminal/shells` 在本机返回 zsh/bash 等，默认项排第一。
- 没有 node-pty 时仍返回可用的 shell 列表，但 `support.available=false`。

### Phase 1：服务端会话化（2–3 人日）

**改动**

- 新增 `server/src/terminal-session.ts`（或同文件内重构）：
  - headless xterm + serializer；`@xterm/headless@^6`、
    `@xterm/addon-serialize@^0.14` 加入 `server/package.json` 的
    `dependencies`（不是 optional）。
  - 状态机、attachment、controller、sequence、写队列、snapshot。
  - 创建/attach/detach/input/resize/snapshot/rename/close/heartbeat。
  - 幂等创建、配额预留、closedIds 墓碑。
  - 关闭队列与重试；空闲回收定时器。
- `server/src/terminal.ts` 保留 `TerminalManager` 作为门面，路由不变的地方
  继续工作。
- `server/src/routes.ts` 增加 4.2 的端点；旧 `GET /:id` 标为 deprecated，
  返回 `{scrollback}` 兼容一个版本。
- `server/src/bus.ts` 事件加 `sequence`、`info`、`terminal_cleanup_failed`。
- `server/src/terminal.test.ts` 扩充；新增 `terminal-session.test.ts`。

**验收（单测覆盖）**

- 同 id 重复 create 只开一个进程；不同 session 同 id 返回 409。
- 配额：7 个 running + 1 exited 后第 9 个 409；创建中预留也计数。
- 关闭进行中的创建：DELETE 后迟到的 create 被拒绝，进程不残留。
- attach 后旧附件写 input 得到 409 `read-only`；新附件可写。
- 快照含 attach 前的全部输出，且不会与后续 SSE 帧重复。
- 序号单调；`resize` 钳到 500×200；`input` > 64 KiB 返回 413。
- rename trim、空标题不改；关闭后 `list` 立即消失。
- 清理失败保留记录，重试成功后才移除。
- 假时钟推进 2h，无附件终端被回收；有心跳的不回收。

### Phase 2：客户端状态机与界面（2–3 人日）

**改动**

- `web/src/features/rightbar/terminal-state.ts` 拆出：
  - `terminal-store.ts`（support/list/view 订阅）
  - `terminal-actions.ts`（create/attach/reconnect/takeControl/rename/close）
  - `terminal-view.ts`（状态机 + 缓冲 + 序号）
- `TerminalTab.tsx` 重写为“视图 + 屏幕”：
  - snapshot 应用、序号缺口恢复、只读/接管条、重连按钮、退出/失败/不可用面板；
  - 主题 observer（`documentElement.dataset.appearance` + `matchMedia`），
    运行中调用 `term.options.theme = ...`；
  - `minimumContrastRatio: 4.5`，光标色按背景亮度选，保证 3:1；
  - `disableStdin` 跟 `writable` 走；fit 只在可见且可写时发送 resize。
- 新增 `TerminalGuide.tsx`（空窗格引导卡 + shell 下拉）、
  `TerminalTitle.tsx`（双击原地编辑）、`TerminalCleanup.tsx`（清理失败提示）。
- `PaneView.tsx`：空窗格渲染引导卡；“+”菜单的终端项支持直接打开记忆的
  shell，旁边 chevron 打开 shell 列表。
- `rightbar-state.ts`：`openTerminalTab(key, paneId, {shellPath})`；
  `makeTerminalTab()` 记录 shell 偏好；`tab.target` 只存终端 id。
- `TabMenu.tsx`：终端/预览的“重命名”改为内联编辑入口（或调用
  `PATCH`，不再 `window.prompt`）。
- `close-tabs.ts`：改为 `terminalActions.closeTab()`，立即移除 + 后台关闭。
- `web/src/lib/sse.ts`：分发 `terminal_output` 的 `sequence` 和新
  `terminal_state.info`。

**验收**

- 单窗口：新开 → 选 shell → 输入 → 退出 → New terminal；
- 双窗口：第二个窗口输入后第一个变只读，点“接管”恢复；
- 刷新后回到同一进程和同一屏；服务端重启后显示“不可用 + 新建”；
- 折叠/切会话/切标签不杀进程；关标签杀；
- 主题切换立即生效；正文/光标对比度达标；
- 输入 Tab、Ctrl+C、IME 组合键不做改写。

### Phase 3：恢复、清理、回收与测试（1.5–2 人日）

**改动**

- 恢复绑定：布局里的 `tab.target` + 服务器 `list`；缺失 → `unavailable`。
- 关闭重试队列（localStorage）与启动重试；`sendBeacon` detach。
- 清理失败提示（全局角落，不阻塞任何标签）。
- 空闲回收与心跳（如 Phase 1 未完成）。
- 文档：更新 `docs/design-notes.md`、`docs/known-limitations.md`、
  `CHANGELOG.md`。
- 测试：
  - server：`terminal-session.test.ts` 全量；
  - web：`terminal-view.test.ts`（纯状态机，mock api）；
    `TerminalTab.test.tsx` 扩到各 phase 的首屏；
  - 可选：加 Playwright，跑 dsh e2e 清单里的 6 条核心场景
    （启动/持久化/关闭/双窗口/重连/主题）。若不加，用
    `server/src/testing/` 下的脚本做进程级验证。

**验收**

- `pnpm typecheck && pnpm test && pnpm build` 全绿。
- 手动清单：见第 7 节。

### 工时汇总

| 阶段 | 内容 | 人日 |
| --- | --- | --- |
| 0 | 契约 + shell 发现 | 0.5–1 |
| 1 | 服务端会话化 | 2–3 |
| 2 | 客户端状态机 + UI | 2–3 |
| 3 | 恢复/清理/回收/测试/文档 | 1.5–2 |
| 合计 | 本期 | **6–9** |
| 4（可选） | agent `terminal_*` 工具 | 3–5 |

---

## 6. 风险与取舍

1. **默认 shell 改变**（见 D1）：从 bash 改成宿主默认，mac 上会变成 zsh。
   现有测试断言 `bash-` 的地方要改；文档里“终端一律开 bash”的理由要重写。
2. **服务端多一个 xterm**：`@xterm/headless` 是纯 JS，但会增加约几 MB 的
   依赖与启动开销。收益是快照精确、重连不花屏；不做则只能继续接受
   “截断可能切在转义序列中间”。
3. **SSE 无逐帧背压**：浏览器标签被系统挂起时可能积压。用序号 + 快照兜底；
   如果实测有问题，再升级为 `fetch` 流 + ack（协议已经留了 `sequence`）。
4. **空闲回收误杀**：没有前台任务探测，2 小时静默的构建可能被关。
   把超时做成环境变量（`PI_WEB_SIMPLE_TERMINAL_IDLE_MS`），默认 2h，
   文档写明。
5. **多窗口语义与 dsh 不同**：这里同一终端两个窗口共享进程；dsh 在两个
   窗口恢复同一 tab id 时各开一个。单机场景下共享更合理，但需要写进
   known-limitations。
6. **服务重启不保留终端**：与 dsh 一致（进程本地），刷新页面不会丢，
   重启服务会丢。恢复时显示“不可用”，不假装还在。

---

## 7. 手动验收清单

1. 空右栏 → 引导卡“终端” → 默认 shell 直接打开；chevron 里能选 bash/zsh。
2. 选过的 shell 刷新后仍是它。
3. 输入 `echo ok` 回车能看到输出；Tab 补全、Ctrl+C 正常。
4. 运行 `sleep 30`，折叠右栏再展开：屏幕还在，进程没死。
5. 刷新页面：回到同一个进程，屏幕内容一致。
6. 开第二个窗口：输入后第一个窗口变只读；点“接管”后恢复。
7. 输入 `exit`：显示退出码和“新建终端”；点“新建终端”换一个新进程。
8. 关标签：标签立即消失，`ps` 里对应 shell 结束。
9. 开满 8 个：第 9 个提示上限；关一个后能再开。
10. 停掉服务再刷新：显示“不可用 + 新建”，不自动开新 shell。
11. 切换浅色/深色：终端颜色立即变化，正文和光标都看得清。
12. 断开网络（devtools offline）再恢复：显示 Reconnect，恢复后屏幕正确。

---

## 8. 待确认的决策

**D1. 默认 shell 跟宿主还是继续固定 bash？**

- 方案 A（推荐，和 dsh 一致）：默认取 `$SHELL`，菜单里列 zsh/bash/fish；
  mac 上默认 zsh。
- 方案 B（保持现状）：默认 bash，菜单里仍可选其他；只补“可选”。
- 影响：A 会改现有测试和文档；B 改动小，但“默认”仍与 dsh 不同。

**D2. 服务端快照是否接受新增 `@xterm/headless` + `@xterm/addon-serialize`？**

- 接受（推荐）：快照精确、重连不花屏，代价是依赖体积。
- 不接受：保留原始 scrollback 回放，只加序号；重连偶发花屏。

**D3. Agent 端 6 个 `terminal_*` 工具是否本期一起做？**

- 不做（推荐）：本期只对齐侧栏终端，6–9 人日可交付。
- 做：追加 3–5 人日，并需要单独设计工具文案、后台任务和有界读取。

确认这三点后，按 Phase 0 → 1 → 2 → 3 推进；每个 Phase 结束跑
`pnpm typecheck && pnpm test`，并在变更日志里记一条。

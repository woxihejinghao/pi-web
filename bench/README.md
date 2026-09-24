# 性能测试：多会话 / 多工作区同时工作的影响

测量对象是 pi-web-simple 的两层架构成本：

1. **进程层** —— 每个活跃会话对应一个 `pi --mode rpc` 子进程（`server/src/registry.ts`）。
2. **事件管道层** —— pi 进程事件 → `RpcClient` → `registry.onEvent` → `bus.publish` → SSE `res.write`（`server/src/routes.ts`）。

测试环境：Apple M2 / 8 核 / 16 GB，Node v22.23.2，pi `@earendil-works/pi-coding-agent` 0.86.1。

## 怎么跑

```bash
# 场景 A：N 个真实 pi RPC 进程的资源开销（默认 1,2,4,8）
node bench/scenario-a-processes.mjs
VARY_CWD=1 node bench/scenario-a-processes.mjs   # 每会话一个工作区目录，做对照

# 场景 B：N 个会话同时 streaming 时的事件管道（要 import server 的 .ts）
# 每个客户端会在 hello 之后订阅会话 0，模拟真实前端「一个标签页只看一个会话」。
cd server && ./node_modules/.bin/tsx ../bench/scenario-b-streaming.ts
SCENARIOS=8x1,8x4 LOAD_EVENTS=20000 DRAIN_MS=12000 \
  ./node_modules/.bin/tsx ../bench/scenario-b-streaming.ts

# 场景 C：前端主线程渲染成本（真实 Chrome + 生产构建，先 build）
pnpm --filter @pi-web-simple/web build
# 长流式（表格主数据）：每 4ms 一个 delta，持续约 17.6s
cd server && LOAD_EVENTS=4000 LOAD_BATCH=1 LOAD_INTERVAL_MS=4 \
  ./node_modules/.bin/tsx ../bench/scenario-c-frontend.ts
# 短 burst：每会话 2000 个 delta 挤在约 0.12s 内，看「一屏之内」的开销
cd server && LOAD_EVENTS=2000 ./node_modules/.bin/tsx ../bench/scenario-c-frontend.ts
# LOAD_EVENTS 必须显式给：scenario-c 也会把它传给 load-stub，而 load-stub 自己的默认是 20000。
# C_DEV=1 用 vite dev 跑，函数名可读，只用于归因；数字以生产构建为准
```

原始数据落在 `bench/results/*.json`；场景 A 的工作目录是 `bench/.bench-tmp/`（已 gitignore）。
两个脚本都不调用任何模型，零成本、可复现。

## 场景 A：多会话 = 多进程

并发拉起 N 个真实 pi RPC 进程，等全部完成 `get_state` 握手，静置 5s 后测进程树。

| N | 握手 max | 总 RSS | 单会话 RSS | 空闲 CPU |
|---|---|---|---|---|
| 1 | 1219ms | 221.7 MB | 221.7 MB | 0.0% |
| 2 | 1364ms | 446.2 MB | 223.1 MB | 0.5% |
| 4 | 1949ms | 844.2 MB | 211.1 MB | 0.5% |
| 8 | 3222ms | 1478.0 MB | 184.8 MB | 1.0% |

（`VARY_CWD=1`，即每个会话一个独立工作区目录，同档位结果差异 <3%，见 `results/scenario-a-multicwd.json`。）

结论：

- **一个常驻会话 ≈ 220 MB**。空闲时几乎不烧 CPU（<1%），成本是内存而非算力。
- 单会话 RSS 随 N 增大略降（221 → 185 MB），是多个 Node 进程共享只读页的效应；但 **ps 的 RSS 求和会重复计算共享页，实际物理内存增量低于表内总和**。
- 启动延迟随并发上升：N=8 时最后一个进程要 3.2s 才握手完成（N=1 是 1.2s）。冷启动本身约 1.2–1.8s，并发时互相抢 CPU。
- 「多工作区」本身**不额外增加每会话成本**，同一个 cwd 与 N 个 cwd 的开销在噪声范围内。成本由**会话数**驱动，不由工作区数驱动。

## 场景 B：N 个会话同时 streaming

用 `bench/load-stub.mjs` 替换 pi 二进制（产生恒定的高频 `message_update`，20k events/s/会话），其余全走真实 server 代码。

| N×M | 期望事件 | 收到 | 未送达 | P50 | P95 | P99 | 吞吐/s | CPU | RSS 增量 |
|---|---|---|---|---|---|---|---|---|---|
| 1×1 | 20000 | 20000 | 0.00% | 0ms | 1ms | 1ms | 16.3k | 56% | −14MB |
| 4×1 | 20000 | 20000 | 0.00% | 0ms | 1ms | 1ms | 65.0k | 45% | +3MB |
| 8×1 | 20000 | 20000 | 0.00% | 0ms | 1ms | 1ms | 127.5k | 43% | +2MB |
| 8×4 | 80000 | 80000 | 0.00% | 0ms | 1ms | 1ms | 130.3k | 56% | +8MB |
| 8×0 | 0 | 0 | — | — | — | — | 124.9k | 33% | +0MB |

（N = 并发 streaming 会话数，M = SSE 客户端数；`DRAIN_MS=12000` 排空后统计。每个客户端都在 `hello` 之后订阅了它正在看的那个会话，所以「期望事件」是 `EVENTS × M` 而不是 `EVENTS × N × M`——这正是真实前端的形态，见下。）

结论：

- **扇出不再是瓶颈**：8 个会话并发 streaming、4 个客户端，P50/P99 是 0ms/1ms，零丢失，RSS 几乎不动。同一格在实施前是 **P50 1203ms / RSS +688MB**（旧数据见 `results/scenario-b.before.json`）。差别不在服务端变快，而在它不再把 7/8 的 token 流发给不需要的客户端。
- **单客户端完全健康**：8 个会话同时 streaming，13 万 events/s，P99 延迟 1ms，零丢失，RSS 无增长。
- **8×0（无任何客户端）只占 33% CPU** —— 纯服务端管道（读 8 个进程的 stdout、解析 JSONL、广播）成本很低，其余开销都在「把事件写给客户端」。
- 过滤规则是 `server/src/bus.ts` 的 `wantsFrame`：只丢掉「不是当前订阅会话」的 `message_update` / `tool_execution_update`。`agent_start` / `agent_settled`（侧栏状态点）、`extension_ui_request`（被阻塞的扩展对话框）、项目与会话列表照常发给每个客户端——用黑名单而不是白名单，pi 以后新增事件类型也不会漏。
- 客户端在会话切换时 `POST /api/events/subscription` 声明订阅；**在声明之前服务端照发全部**，所以一次切换不会因为竞态丢帧。
- 连接自带背压：`res.write` 返回 false 就暂停投递、排队等 `drain`；队列超过 `SSE_MAX_BUFFERED_BYTES`（默认 4MB）就断开这条连接（`message_update` 带的是增量而不是快照，丢弃会把转录写坏；断开则让 `EventSource` 重连并重读快照）。这是本轮压测没有触发的那一半保护：它的价值只在客户端真的跟不上时才显现。

## 场景 C：前端主线程渲染成本（真实 Chrome）

用 `vite build` 的生产产物 + Chrome headless（CDP 驱动），让**真实前端代码**消费真实 SSE：
服务端仍用 `load-stub` 造高频 `message_update`，前端 `EventSource` → `actions.emitSessionEvent`
→ `useConversation.handleEvent` → `setView` → React 重渲染整条链路全是真的。

fixture：8 个会话 × 40 轮历史（含 Markdown 与代码块），侧栏选中其中最新的一个作为「当前会话」。
指标用 CDP CPU Profiler 的采样归属（`忙 = 总采样 − idle`），并用一个假的
`__REACT_DEVTOOLS_GLOBAL_HOOK__` 统计 React 的 commit 次数。

长流式是这里的重点：每 4ms 一个 delta、持续约 17.6 秒（`LOAD_EVENTS=4000 LOAD_BATCH=1 LOAD_INTERVAL_MS=4`），
partial 会一直长到几万字符 —— 这正是「解析成本随文本增长、帧率却固定」的形态。短 burst
（`LOAD_EVENTS=2000`，全部挤在约 0.12 秒）测不出流式渲染的开销，因为窗口本身只有几帧。

| 场景 | 事件 | React render | 主线程忙（17.6s 内） | 忙/事件 |
|---|---|---|---|---|
| 0 基线（无 streaming） | 0 | 0 | 42 ms | — |
| A 当前会话 · 每帧重绘 | 4000 | 1528 | **10203 ms（58%）** | 2.55 ms |
| A 当前会话 · 50ms 节流 | 4000 | 675 | **3871 ms（22%）** | 0.97 ms |
| B 8 会话并发 · 每帧重绘 | 4000 | 836 | **17713 ms（100%）** | 4.43 ms |
| B 8 会话并发 · 50ms 节流 | 4000 | 525 | **8967 ms（51%）** | 2.24 ms |
| C 7 个非当前会话并发（当前空闲） | **0** | 14 | 490 ms | — |

（「每帧重绘」= `STREAM_REPAINT_MS = 0`，即 `schedulePublish` 每帧发布一次，也就是 0.1.1 以来的行为。
原始数据：`results/scenario-c.json`（节流）与 `results/scenario-c.unthrottled.json`（每帧）。）

结论：

- **流式渲染成本由「每帧重解析整段 partial」主导**：无节流时，长回复把当前会话的主线程占到 58%，8 会话并发直接打满（100%）。把发布下限提到 50ms（`useConversation.ts` 的 `STREAM_REPAINT_MS`）后，两项都减半以上（22% / 51%），观感仍是连续吐字。
- **非当前会话完全免费**：C 场景 7 个会话并发 streaming，前端收到 **0 个事件** —— `wantsFrame` 在服务端就把它们丢了，不再有「传输 + `JSON.parse` + 按 `sessionPath` 过滤」这一趟。
- 成本在**每次 render 的单价**而不是次数：节流把 render 次数降到一半，主线程时间也降到一半，二者同比例。

热点（`C_DEV=1` 拿到可读函数名）：主线程自耗时集中在 **react-markdown / remark 的解析**
（`go`、`consume`、`write`），以及 React 自身的 begin/commit（`i9`/`$`/`n`/`N`）。流式期间每个 delta 都要
用累计后的 partial 文本重新解析一遍 Markdown，解析成本随 partial 长度增长，这是当前会话每事件成本的主要构成。
（`distanceFromBottom` 曾在 render 期间读 DOM、触发强制布局，现已移入 `MessageList.tsx` 的 `useLayoutEffect`。）

对照实验（历史 0 轮 vs 20 轮）显示当前会话的忙时间只差约 7%，所以瓶颈**不是**历史消息的重渲染，而是
**流式 partial 的反复解析**。

## 这些数字在真实负载下意味着什么

load-stub 的 20k events/s/会话是刻意压到上限的。真实模型流式输出通常是每秒几十到几百个 delta，8 会话并发约 1k events/s 量级，比场景 B 已经验证过「零积压」的 130k events/s 低两个数量级。所以：

- **日常使用（1–2 个标签页、若干会话同时跑）：事件管道不是瓶颈，瓶颈是内存。** 内存由 `PI_WEB_SIMPLE_MAX_SESSIONS`（默认 8）决定，最坏约 8 × 220MB ≈ 1.8GB 常驻。
- **多标签页的边界**：以前多个标签页 + 高事件率会互相拖慢（每个标签页复制全部会话的全部事件）。按会话订阅之后，一个标签页的开销只与它自己看的那个会话有关；剩下的保护是背压断开。
- 本测试的 SSE 客户端与 server 在同一进程，测出的 CPU（56%）混合了客户端解析开销，**比真实浏览器场景偏悲观**；但「扇出 → 写队列」的机制与客户端在哪无关。
- **前端主线程是长回复场景的实际约束**：非当前会话的事件已经被服务端过滤（场景 C 收到 0 个），但当前会话在长流式下仍会占到 22%（无节流 58%）。按常见 100 delta/s 折算，节流后约占主线程 10%。

## 建议的改进

本轮已实施：

1. **SSE 按会话订阅**：`POST /api/events/subscription` 声明读的是哪个会话，`wantsFrame` 丢掉其余会话的高频帧。前端本来也只渲染当前会话，之前却让每个客户端复制全部会话的全部事件——这是扇出膨胀的主因，也顺带省掉前端对海量无关事件的 `JSON.parse`。
2. **背压处理**：`res.write` 返回 false 时暂停对该连接的投递，排队等 `drain`。
3. **每连接缓冲上限**：`SSE_MAX_BUFFERED_BYTES`（默认 4MB）之上主动断开，前端 `EventSource` 重连后重读快照。

仍可改进：

4. 多工作区这一侧（`watch.ts` 每项目一个 `fs.watch`、`sessions.ts` 每项目一次 `SessionManager.list`）本次未压测；从代码看成本是 O(项目数)、非递归、单层，在几十个项目规模内可忽略。
5. **流式 Markdown 的解析成本**（当前会话 1.19 ms/事件的主因）：每个 delta 都用累计后的 partial 文本调一次 `react-markdown`。已有 rAF 合并，但仍可进一步按时间窗节流，或对已固定的前缀做缓存，避免每帧重新解析整段。
6. `distanceFromBottom` 已从 render 期间移进 `useLayoutEffect`（`MessageList.tsx`），强制布局只在提交后发生一次；进一步可以换成 `ResizeObserver` 缓存。

## 尚未覆盖

- 真实模型的并发 streaming（场景 A/B/C 的 pi 进程都是替身，delta 速率分布可能与真实不同）。
- 场景 C 在 headless Chrome 下 rAF 不触发（`CVDisplayLinkCreateWithCGDisplay failed`），没有采到帧率 / 掉帧，只有主线程 CPU 口径。
- 多工作区 watcher / 会话列表的规模上限（几十~几百个工作区）。

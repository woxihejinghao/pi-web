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
cd server && ./node_modules/.bin/tsx ../bench/scenario-b-streaming.ts
SCENARIOS=8x1,8x4 LOAD_EVENTS=20000 DRAIN_MS=12000 \
  ./node_modules/.bin/tsx ../bench/scenario-b-streaming.ts

# 场景 C：前端主线程渲染成本（真实 Chrome + 生产构建，先 build）
pnpm --filter @pi-web-simple/web build
cd server && ./node_modules/.bin/tsx ../bench/scenario-c-frontend.ts
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
| 1×1 | 20000 | 20000 | 0.00% | 0ms | 1ms | 1ms | 15.9k | 51% | −13MB |
| 4×1 | 80000 | 80000 | 0.00% | 0ms | 1ms | 1ms | 65.2k | 60% | +13MB |
| 8×1 | 160000 | 160000 | 0.00% | 1ms | 1ms | 1ms | 133.1k | 73% | −31MB |
| 8×4 | 640000 | 640000 | 0.00% | **1203ms** | 1290ms | 1328ms | 104.5k | 201% | **+688MB** |
| 8×0 | 0 | 0 | — | — | — | — | 127.3k | 28% | −66MB |

（N = 并发 streaming 会话数，M = SSE 客户端数；`DRAIN_MS=12000` 排空后统计。）

结论：

- **单客户端完全健康**：8 个会话同时 streaming，13 万 events/s，P99 延迟 1ms，零丢失，RSS 无增长。服务端的 JSON 解析 + bus 扇出在单订阅者下不是瓶颈。
- **8×0（无任何客户端）只占 28% CPU** —— 纯服务端管道（读 8 个进程的 stdout、解析 JSONL、广播）成本很低，其余开销都在「把事件写给客户端」。
- **真正的瓶颈是 SSE 扇出，而且是背压问题，不是丢失**：4 个客户端时 640k 事件最终 100% 送达，但 P50 延迟 1.2s、RSS 暴涨 688MB。事件没有丢，是堵在服务端的写队列里。
- 根因在 `server/src/routes.ts` 的 SSE 处理器：
  ```ts
  const unsubscribe = bus.subscribe((event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  ```
  `res.write` 的返回值（false = 写缓冲已满）被忽略，也没有队列上限、没有丢弃或合并策略、没有「客户端太慢就断开」的保护。同时**每个客户端都收到全部会话的全部事件**，前端再按 `sessionPath` 自行过滤 —— 扇出倍率是 `会话数 × 客户端数`。

## 场景 C：前端主线程渲染成本（真实 Chrome）

用 `vite build` 的生产产物 + Chrome headless（CDP 驱动），让**真实前端代码**消费真实 SSE：
服务端仍用 `load-stub` 造高频 `message_update`，前端 `EventSource` → `actions.emitSessionEvent`
→ `useConversation.handleEvent` → `setView` → React 重渲染整条链路全是真的。

fixture：8 个会话 × 40 轮历史（含 Markdown 与代码块），侧栏选中其中最新的一个作为「当前会话」。
每会话这次 streaming 发 2000 个 delta。指标用 CDP CPU Profiler 的采样归属（`忙 = 总采样 − idle`），
并用一个假的 `__REACT_DEVTOOLS_GLOBAL_HOOK__` 统计 React 的 commit 次数。

| 场景 | 事件 | React render | 主线程忙 | 忙/事件 |
|---|---|---|---|---|
| 0 基线（无 streaming） | 0 | 0 | 40 ms | — |
| A 仅当前会话 streaming | 2000 | 186 | 2386 ms | **1.19 ms** |
| B 8 会话并发（含当前会话） | 16000 | 113 | 2379 ms | 0.15 ms |
| C 7 个非当前会话并发（当前空闲） | 14000 | **0** | **131 ms** | **0.009 ms** |

结论：

- **非当前会话的事件对前端几乎免费**（0.009 ms/事件，14000 个事件只花 131 ms，0 次 render）。
  `useConversation` 的 `if (payload.sessionPath !== sessionPath) return;` 把不属于当前会话的事件
  挡在渲染之外，所以「多会话同时跑」不会拖慢 UI。
- **当前会话 streaming 是唯一的前端成本：约 1.19 ms/事件**。按这个速度，主线程饱和点约
  **860 events/s**（A 场景 2000 事件 / 2316 ms 就是打满的状态）。
- React 并不是每个事件都渲染一次：2000 事件只产生 186 次 commit（0.09 次/事件），
  说明 `setView` 已经被 React 批处理了。成本在**每次 render 的单价**，不在 render 次数。
- B 场景可加性验证：`14000×0.009 + 2000×1.19 ≈ 2.51 s`，实测 2.38 s —— 两个成本项互不干扰。

热点（`C_DEV=1` 拿到可读函数名）：主线程自耗时集中在 **react-markdown / remark 的解析**
（`go`、`consume`、`write`），其次是一次 render 里重复出现的 `distanceFromBottom`（`MessageList.tsx:40`，
在 render 期间读 DOM）、以及 React 自身的 begin/commit（`i9`/`$`/`n`/`N`）。流式期间每个 delta 都要
用累计后的 partial 文本重新解析一遍 Markdown，解析成本随 partial 长度增长，这是 1.19 ms/事件的主要构成。

对照实验（历史 0 轮 vs 20 轮）显示当前会话的忙时间只差约 7%，所以瓶颈**不是**历史消息的重渲染，而是
**流式 partial 的反复解析**。

## 这些数字在真实负载下意味着什么

load-stub 的 20k events/s/会话是刻意压到上限的。真实模型流式输出通常是每秒几十到几百个 delta，8 会话并发约 1k events/s 量级，比场景 B 已经验证过「零积压」的 133k events/s 低两个数量级。所以：

- **日常使用（1–2 个标签页、若干会话同时跑）：事件管道不是瓶颈，瓶颈是内存。** 内存由 `PI_WEB_SIMPLE_MAX_SESSIONS`（默认 8）决定，最坏约 8 × 220MB ≈ 1.8GB 常驻。
- **需要注意的边界**：多个浏览器标签页 + 高事件率场景（长时间 bash 流式输出、大工具结果、很多会话同时吐 token）。这时会出现秒级延迟和内存膨胀。
- 本测试的 SSE 客户端与 server 在同一进程，测出的 CPU（201%）混合了客户端解析开销，**比真实浏览器场景偏悲观**；但「无背压 → 写队列膨胀」的机制与客户端在哪无关。
- **前端主线程不是瓶颈**：场景 C 里 7 个非当前会话并发 streaming 只花 131 ms 主线程时间（0.009 ms/事件）。按常见的 100 delta/s 折算，当前会话占用约 12%（100 × 1.19 ms/s），其余并发会话再加不到 1%。只有当**当前会话**的 delta 速率逼近 860/s（模型很快、或工具结果流很大）时才明显掉帧。

## 建议的改进（按性价比排序）

1. **SSE 按会话订阅**：`GET /api/events?session=<sessionPath>`，服务端只推该会话的事件。前端本来也只渲染当前会话，现在却让每个客户端复制全部会话的全部事件 —— 这是扇出膨胀的主因，也顺带省掉前端对海量无关事件的 `JSON.parse`。
2. **加背压处理**：`res.write` 返回 false 时暂停对该连接的投递（或直接丢弃可合并的 `message_update`，只保证 `agent_settled` / `agent_end` 这类状态事件必达），恢复后再续。
3. **每连接缓冲上限**：超过上限主动断开，前端重连后用 `get_messages()` 重新拉快照 —— 比无限堆积更可控。
4. 多工作区这一侧（`watch.ts` 每项目一个 `fs.watch`、`sessions.ts` 每项目一次 `SessionManager.list`）本次未压测；从代码看成本是 O(项目数)、非递归、单层，在几十个项目规模内可忽略。
5. **流式 Markdown 的解析成本**（当前会话 1.19 ms/事件的主因）：每个 delta 都用累计后的 partial 文本调一次 `react-markdown`。可以按 rAF / 时间窗节流 partial 的渲染，或对已固定的前缀做缓存，避免每帧重新解析整段。
6. `distanceFromBottom`（`MessageList.tsx:40`）在 render 期间读 DOM、触发强制布局；建议把测量搬进 effect / `ResizeObserver`，render 阶段只读缓存值。

## 尚未覆盖

- 真实模型的并发 streaming（场景 A/B/C 的 pi 进程都是替身，delta 速率分布可能与真实不同）。
- 场景 C 在 headless Chrome 下 rAF 不触发（`CVDisplayLinkCreateWithCGDisplay failed`），没有采到帧率 / 掉帧，只有主线程 CPU 口径。
- 多工作区 watcher / 会话列表的规模上限（几十~几百个工作区）。

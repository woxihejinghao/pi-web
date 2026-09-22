/**
 * 注入到页面的测量探针（通过 CDP Page.addScriptToEvaluateOnNewDocument，
 * 在任何应用代码之前执行）。不修改应用行为，只做观测：
 *
 *   - 包装 EventSource，统计 SSE 事件到达时间（主线程真正开始处理事件的时刻）
 *   - PerformanceObserver 收集 longtask（>50ms 的主线程阻塞）
 *   - rAF 循环收集帧间隔（卡顿）
 *
 * 结果都挂在 window.__bench 上，由 bench 脚本通过 Runtime.evaluate 取回。
 */
(() => {
  if (window.__bench) return;

  const state = {
    createdAt: performance.now(),
    sessionEvents: 0,
    messageUpdates: 0,
    agentSettled: 0,
    eventsByType: Object.create(null),
    /** 每个 message_update 到达主线程的 performance.now()，用于算处理吞吐。 */
    updateTimes: [],
    longTasks: [],
    frames: [],
    firstEventAt: null,
    lastUpdateAt: null,
    /** React 的 commit 次数（每次 render 提交到 DOM 算一次）。 */
    reactCommits: 0,
  };
  window.__bench = state;

  // --- 0) 假 DevTools hook：只为了数 React 提交了多少次 --------------------
  // ConversationPane 用 useStore(appStore) 订阅了整棵 store，所以需要知道
  // 「一个事件到底触发了几次 render」，而不能只看 DOM 有没有变。
  try {
    if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject(renderer) {
          const id = this.renderers.size + 1;
          this.renderers.set(id, renderer);
          return id;
        },
        onCommitFiberRoot() {
          state.reactCommits += 1;
        },
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        checkDCE() {},
      };
    }
  } catch {
    // 统计不到就算了，不影响其他指标
  }

  // --- 1) EventSource 包装 -------------------------------------------------
  const Native = window.EventSource;
  if (typeof Native === "function") {
    class InstrumentedEventSource extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener("session_event", (raw) => {
          const at = performance.now();
          state.sessionEvents += 1;
          if (state.firstEventAt === null) state.firstEventAt = at;
          let payload;
          try {
            payload = JSON.parse(raw.data);
          } catch {
            return;
          }
          const type = payload?.event?.type ?? "unknown";
          state.eventsByType[type] = (state.eventsByType[type] ?? 0) + 1;
          if (type === "message_update") {
            state.messageUpdates += 1;
            // 只留时间戳，不复制事件体；16000 条也就 128KB。
            state.updateTimes.push(at);
            state.lastUpdateAt = at;
          } else if (type === "agent_settled") {
            state.agentSettled += 1;
          }
        });
      }
    }
    window.EventSource = InstrumentedEventSource;
  }

  // --- 2) longtask ---------------------------------------------------------
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // headless 或旧内核不支持就跳过
  }

  // --- 3) rAF 帧间隔 -------------------------------------------------------
  let lastFrame = performance.now();
  const tick = (now) => {
    state.frames.push(now - lastFrame);
    lastFrame = now;
    if (state.frames.length > 20000) state.frames.splice(0, 10000);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // --- 4) 控制接口 ---------------------------------------------------------
  window.__benchReset = () => {
    state.sessionEvents = 0;
    state.messageUpdates = 0;
    state.agentSettled = 0;
    state.eventsByType = Object.create(null);
    state.updateTimes = [];
    state.longTasks = [];
    state.frames = [];
    state.firstEventAt = null;
    state.lastUpdateAt = null;
    state.reactCommits = 0;
    return true;
  };

  window.__benchSnapshot = () => ({
    sessionEvents: state.sessionEvents,
    messageUpdates: state.messageUpdates,
    agentSettled: state.agentSettled,
    eventsByType: { ...state.eventsByType },
    firstEventAt: state.firstEventAt,
    lastUpdateAt: state.lastUpdateAt,
    reactCommits: state.reactCommits,
    updateTimes: state.updateTimes,
    longTasks: state.longTasks,
    frames: state.frames,
  });
})();

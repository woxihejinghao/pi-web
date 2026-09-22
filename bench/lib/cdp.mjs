/**
 * 极简 Chrome DevTools Protocol 客户端（无第三方依赖）。
 * Node 22 自带全局 WebSocket，所以只差一层请求/事件分发。
 */
export class CdpConnection {
  #ws;
  #seq = 0;
  #pending = new Map();
  #handlers = new Map();
  #closed = false;

  static async connect(wsUrl, { timeoutMs = 10_000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${wsUrl}`)), timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        (event) => {
          clearTimeout(timer);
          reject(new Error(`CDP connect failed: ${event.message ?? "error"}`));
        },
        { once: true },
      );
    });
    return new CdpConnection(ws);
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => this.#dispatch(event.data));
    ws.addEventListener("close", () => {
      this.#closed = true;
      for (const { reject } of this.#pending.values()) reject(new Error("CDP connection closed"));
      this.#pending.clear();
    });
  }

  #dispatch(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
      return;
    }
    for (const handler of this.#handlers.get(message.method) ?? []) handler(message.params);
    for (const handler of this.#handlers.get("*") ?? []) handler(message);
  }

  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const list = this.#handlers.get(method) ?? [];
    list.push(handler);
    this.#handlers.set(method, list);
    return () => {
      const current = this.#handlers.get(method) ?? [];
      this.#handlers.set(
        method,
        current.filter((h) => h !== handler),
      );
    };
  }

  waitFor(method, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`CDP waitFor timeout: ${method}`));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  /** Runtime.evaluate 的语法糖：返回 JSON 值，异常抛出。 */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result?.value;
  }

  close() {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      // already gone
    }
  }
}

/** 轮询一个 CDP 端点，直到 Chrome 起来。 */
export async function findChromeTarget(port, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      const targets = await response.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Chrome not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no page target on 127.0.0.1:${port} after ${timeoutMs}ms`);
}

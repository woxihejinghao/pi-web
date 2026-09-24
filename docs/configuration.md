# 环境变量

全部可选。不设时用下表的默认值。

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

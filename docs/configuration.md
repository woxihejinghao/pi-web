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
| `PI_WEB_SIMPLE_DESKTOP_TRACE` | 不设 | 仅桌面版：非空时把退出流程的每一步追加到这个文件（排查「退出后还占着端口」用）。不影响行为，见[桌面版](./desktop.md#环境变量与排错) |

开发模式下前端 dev server 的代理目标端口读取 `PI_WEB_SIMPLE_PORT`，两处要保持一致。

桌面版会自己写好三个变量：`PI_WEB_SIMPLE_PORT`（选定的端口）、`PI_WEB_SIMPLE_OPEN=0`
（窗口已由 Electron 负责）、`PI_WEB_SIMPLE_STATIC_DIR`（包内前端位置）；其余从启动它的
环境继承。注意 macOS/Linux 上双击启动拿不到 shell 环境，需要先 `launchctl setenv` 或从
终端直接跑包内可执行文件。

# 桌面版

`desktop/` 是一个 Electron 壳，把**同一个**服务端（`server/build/index.js`）和**同一份**
前端（`web/dist`）装进可安装的 mac / Windows / Linux 应用里。壳只负责开窗口、选端口、
管进程；下面跑的东西和 `npx pi-web-simple` 完全一样——所以浏览器版、CLI 版、桌面版不会
漂移成三个产品。项目管理模型与界面风格仍然来自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，
其桌面版也是同样的做法：Electron 外壳 + 复用同一个宿主服务。

装好之后**不需要系统里有 Node.js**：运行时是自带的。

## 为什么自带 Node

pi 的 RPC 客户端用的是裸命令 `node`（`@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js`
里的 `spawn("node", …)`），也就是说 agent 派生的每个子进程都要能在 `PATH` 上找到 `node`。
两种办法：

| 方案 | 结果 |
|---|---|
| 借 Electron 自己的 Node（`ELECTRON_RUN_AS_NODE`） | Linux/macOS 上可以用垫片糊过去，**Windows 不行**：`spawn("node")` 只认 `.exe`/`.com`，不会去找 `.cmd`/`.bat` 垫片 |
| 自带一份官方 Node 运行时（本项目的选择） | 三个平台一致；agent 用的 Node 与 CI 测过的版本相近；不赌用户装过 Node |

所以安装包里带着 `nodejs.org` 官方发行版的 `bin/node`（Linux/macOS）或 `node.exe`（Windows），
版本写在 `desktop/scripts/prepare-runtime.mjs` 的 `NODE_VERSION`，随安全更新一起升。
下载后会比对官方 `SHASUMS256.txt` 的 sha256，校验不过就丢弃重来。

## 安装

安装包由 [`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml) 在打 tag（`v*`）时构建，
并挂到该 tag 的 GitHub Release 上；也可以在 Actions 里手动触发（`workflow_dispatch`），从 Artifacts 取。

| 平台 | 产物 | 说明 |
|---|---|---|
| macOS（Apple 芯片） | `pi-web-simple-<版本>-mac-arm64.dmg` / `.zip` | 把 `.app` 拖进「应用程序」 |
| macOS（Intel） | `pi-web-simple-<版本>-mac-x64.dmg` / `.zip` | 需要在 Intel 机器或 `macos-15-intel` runner 上构建，见[已知限制](#已知限制) |
| Windows（x64） | `pi-web-simple-<版本>-win-x64-setup.exe` / `.zip` | NSIS 安装器，可选安装目录；`.zip` 是免安装版 |
| Linux（x64） | `pi-web-simple-<版本>-linux-x64.AppImage` / `.deb` | AppImage 需要 `chmod +x` 后直接运行 |

**没有代码签名**（本项目不发证书）。首次打开会被系统拦一下：

- macOS：右键（或按住 Control 点击）→「打开」→ 再确认一次；或者
  `xattr -dr com.apple.quarantine /Applications/pi-web-simple.app`。
- Windows：SmartScreen 提示 →「更多信息」→「仍要运行」。

装完之后启动就是一个原生窗口。**macOS 用 `hiddenInset`：保留系统红绿灯，但把标题栏那条带子画成透明**，页面一直铺到窗口上缘、侧栏的半透明底色因此能跑进控制区；代价是原生标题栏不再是拖拽区，窗口改由页面里打了 `data-window-drag` 的行来拖（侧栏顶部条、品牌行，以及中间栏顶部——有会话时就是对话头部，新会话时是一条同高的空行），行里的控件再由一条全局 `no-drag` 规则自己退出拖拽——窗口另开一层 `sidebar` 毛玻璃（`vibrancy`），让那条半透明侧栏有东西可透，材质与 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 同一个。**Windows 与 Linux 不动**：不跟 dsh 在 Windows 上自绘顶部行，不重造原生窗口控件，就用平台自己的标题栏。菜单 **File → Open in Browser**
可以在浏览器里打开同一个地址——它本来就是同一个服务。

## 它放在哪、跑在哪

| 东西 | 位置 |
|---|---|
| 应用目录（服务端 + 前端 + 依赖） | `pi-web-simple.app/Contents/Resources/app`（Windows/Linux：`resources/app`） |
| 自带的 Node 运行时 | `…/Resources/runtime/node/bin/node`，许可证在同级 `LICENSE` |
| 项目记录与界面偏好 | `~/.pi-web-simple/store.json`——**与 CLI 版共用一份** |
| 模型、密钥、会话 | pi 自己的 `~/.pi/…`，同样与 CLI 版共用 |

共用状态是有意的：桌面版和 `npx pi-web-simple` 打开的是同一批项目、同一批会话，
换一种启动方式不会看到另一个世界。想隔离就设 `PI_WEB_SIMPLE_HOME`。

- **端口**：显式设了 `PI_WEB_SIMPLE_PORT` 就用它（此时端口被占会是一个明确错误）；
  否则先用 5319，被占了才退到系统随机端口——所以 CLI 版和桌面版可以同时开着。
- **工作目录**：进程的工作目录是用户主目录，而不是应用所在目录。pi 的项目范围是按
  cwd 推导的，跟着安装位置变会很奇怪。
- **只监听 `127.0.0.1`**，并且桌面版总是把 `PI_WEB_SIMPLE_OPEN=0` 塞给服务端——
  窗口已经由 Electron 负责，再弹一个浏览器就是 bug。
- **单实例**：第二次启动会激活已有窗口，不会再起一个服务端。
- macOS 上关掉窗口应用仍然活着（平台习惯如此），**Cmd+Q** 才是退出；退出时服务端
  和它下面的 pi 进程一并结束。

## 从源码打包

```sh
pnpm install
pnpm package:desktop     # = 先 pnpm build（前后端），再打当前平台的安装包
```

产物落在 `desktop/release/`。相关命令：

```sh
pnpm dev:desktop                                  # 先构建，再用 Electron 窗口跑当前仓库
                                                  # （窗口加载的是 web/dist 构建产物，改完要重新跑）
pnpm icons:desktop                                # 由 desktop/resources/icon-source.png 生成 icon.png
                                                  # （缩放 + macOS squircle 裁形；换图标 = 替换源素材后重跑）
pnpm --filter pi-web-simple-desktop run package:dir    # 只出解包目录，快很多，用来验证
pnpm --filter pi-web-simple-desktop run package -- --no-build   # 跳过 pnpm build（产物已经构建过）
```

四步流水线（`desktop/scripts/package.mjs`）：

1. 仓库根 `pnpm build`——构建前端、编译后端；
2. `prepare-app.mjs`——把 `server/build`、`web/dist`、`main.cjs`、`preload.cjs`、`LICENSE`、
   `THIRD_PARTY_NOTICES.md` 组装成「应用目录」，再用一次干净的 `npm install --omit=dev` 装
   唯一那个运行时依赖（pi 内核）。**不用 pnpm 的 workspace 链接**：那是指向仓库外 store 的
   符号链接，打包器收不了；
3. `prepare-runtime.mjs`——下载/校验/解压自带 Node；
4. electron-builder——出 dmg / zip / nsis / AppImage / deb。

**只能在目标平台上打包**：自带的运行时是宿主平台的，交叉打包没有意义（脚本会直接拒绝）。
`electronDist` 指向本地 `node_modules/electron/dist`，用的是本地已安装的 Electron，
不去网上重下一份——版本与开发模式完全一致，也不再受下载超时的影响。

开发模式（`pnpm dev:desktop`）跑的是 `electron .`，住在 Electron 自己的 bundle 里，
Dock 图标不会自动变成我们的：主进程会把 `desktop/resources/icon.png` 交给
`app.dock.setIcon`（macOS）并作为 `BrowserWindow` 的 `icon`（Windows/Linux）。
打包后这两处都不需要——图标已经在 bundle 的 `.icns` / `.ico` 里。所以换图标时
除了 `pnpm icons:desktop`，不需要额外做“同步开发版图标”的动作。

## 环境变量与排错

桌面版继承启动它的那份环境，其他变量与 CLI 版一致，见[环境变量](./configuration.md)。
注意 macOS/Linux 的图形界面启动**拿不到你 shell 里的环境**，要让桌面上双击的应用认
某个变量，得这样启动：

```sh
PI_WEB_SIMPLE_HOME=/tmp/piws /Applications/pi-web-simple.app/Contents/MacOS/pi-web-simple
# 或者让 launchd 记住它，再正常双击
launchctl setenv PI_WEB_SIMPLE_HOME /tmp/piws
```

服务端的输出会打到应用的 stderr；从终端启动就能看到：

```
[pi-web-simple] http://127.0.0.1:5319 (web ui + api)
[desktop] serving http://127.0.0.1:5319
```

启动失败会弹一个对话框，里面带服务端最后 25 行日志——不是只丢一句「启动失败」。

退出路径没有界面可看，但可以留痕（排查「关掉之后还占着端口」这类问题时很有用）：

```sh
PI_WEB_SIMPLE_DESKTOP_TRACE=/tmp/piws-trace.log /Applications/pi-web-simple.app/Contents/MacOS/pi-web-simple
# 每发生一件事追加一行：
# before-quit handle=set shutdown=null > quitGracefully > stop: SIGTERM > stop: exited > will-quit
```

开发模式下（`pnpm dev:desktop`）还可以用 `PI_WEB_DESKTOP_NODE=/path/to/node` 指定跑服务端的
Node，默认用宿主 PATH 上的 `node`。

## 已知限制

- **没有自动更新**：升级＝重新下载安装包。签名和更新通道都还没有。
- **Intel 版 macOS 包要在 Intel 上构建**：自带运行时按宿主平台选，所以矩阵里那条
  `macos-15-intel` 标了 `experimental`——runner 一旦被 GitHub 下线，它不会挡住其他平台的发布。
- **Windows 上没有 SIGTERM**：退出时服务端是被直接终止的，它来不及回收自己下面的 pi
  子进程（dsh 用 job object 兜住了这一点，这里没做）。macOS/Linux 上是正常的：服务端收到
  SIGTERM 后先停会话再退出。
- **未签名**：如上，首次打开需要手动放行；也无法公证（notarize）。
- **体积**：自带 Node 运行时（解压后约 108 MB）与完整依赖树，装完约 490 MB，
  dmg 约 180 MB。换来的是一台干净机器上双击即用。
- **asar 关闭**：打包时的 `asar: false`。服务端产物是 ESM，asar 里的 ESM 解析、
  以及「外部 Node 运行时 + asar 内路径」的组合都容易踩坑，v1 先用普通目录；
  代价是文件数多、安装稍慢。

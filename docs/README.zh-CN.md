# pi-web-simple

[English](https://github.com/woxihejinghao/pi-web/blob/main/README.md) · **简体中文**

一个基于 [pi](https://github.com/earendil-works/pi-coding-agent) 的本地 Web UI：**一个本地目录 = 一个项目**，项目下挂该目录的会话，agent 内核是 pi 本身，通过 `pi --mode rpc` 子进程接入。项目管理模型与界面风格参考 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

`npx pi-web-simple` 就能跑起来 —— 需要 Node.js `>= 22.19`，只监听 `127.0.0.1`；其它装法见[快速开始](#快速开始)。

| 深色主题 | 浅色主题 |
| :---: | :---: |
| ![深色主题下的主界面](https://cdn.jsdelivr.net/gh/woxihejinghao/pi-web@main/docs/images/overview-dark.png) | ![浅色主题下的主界面](https://cdn.jsdelivr.net/gh/woxihejinghao/pi-web@main/docs/images/overview-light.png) |

*深浅两套主题默认跟随系统，也可在设置里固定。两图是同一份会话：左栏工作区与会话，中间对话与折叠起来的思考 / 工具步骤，右栏文件变更可直接暂存、提交、推送。*

**功能概览**

- **工作区与会话** —— 服务端目录选择器；一个目录 = 一个项目，项目下挂会话；fork 与重命名；分组方式（按工作区 / 工作区树 / 单列表）与排序方式（手动 / 最近更新），行可直接拖拽换位；就地搜索；窄屏下侧栏收成抽屉。
- **对话** —— SSE 流式输出，Markdown 与代码高亮；思考与工具步骤默认折叠；压缩在转录里单开一行；轮次导航与失败重试。
- **Agent 组成** —— 每个会话一个空闲回收的 pi 进程；新建会话时可选**极简模式**（一句话提示词、只保留 `bash`；第一轮之前还能从会话头部改）。
- **输入** —— 图片输入；`@` 引用文件（候选来自 `git ls-files`）；`/` 命令补全；模型与思考强度合并成一张卡（档位滑轨）；上下文用量读数。
- **问答与计划** —— `ask_user_question` 一次带一整批问题、一次答完；超时的问题仍能回来回答；带 `intent` 的题渲染成审批卡，计划可当场批准或退回。
- **计划模式** —— 让 agent 先探索、先设计再动手：一段提示词指引它只做只读调研。`/plan` 进入，退出按输入框里那枚只在开启时出现的「计划」chip（或 `/plan off`）；写完的计划在同一张审批卡上裁决，正文在右栏的计划标签页里读，并在轮次尾部留一张可再打开的计划卡片。
- **右侧栏** —— 文件树、文件预览、Git 变更（暂存 / 提交 / 推送 / 还原 / 切分支）、内嵌浏览器；可分为左右两格，标签可拖出成浮动面板。
- **设置** —— 外观与语言、模型目录（provider 与模型条目、推理档位、上下文窗口与输入类型）、插件、**提示词**（全局 `AGENTS.md` 与当前工作区上下文，就地编辑后重启会话生效）、**Skills**（列出 pi 发现的全局/工作区技能，可启停并读 `SKILL.md`，只改 pi 配置不动源文件）、MCP。
- **桌面版** —— 与 CLI 共用同一份数据；系统通知与 Dock / 任务栏红点，点一下直达会话。

## 界面一览

**极简模式** —— 新建会话时可选（只保留 `bash`）；会话还没说过话之前，头部的模式标签可以点开改，跑过一轮就固定下来。

![新建会话页的模式选择器](https://cdn.jsdelivr.net/gh/woxihejinghao/pi-web@main/docs/images/mode-picker-dark.png)

**`@` 引用文件** —— 候选来自 `git ls-files`，选中的路径作为一个 chip 落进句子。

![输入框里的 @ 文件引用菜单](https://cdn.jsdelivr.net/gh/woxihejinghao/pi-web@main/docs/images/file-mention-dark.png)

**模型与思考强度** —— 合成一张卡，底下是一条档位滑轨。

![模型与思考强度卡片](https://cdn.jsdelivr.net/gh/woxihejinghao/pi-web@main/docs/images/model-card-dark.png)

## 快速开始

```sh
npx pi-web-simple    # 在 http://127.0.0.1:5319 同时提供前端与 API
```

三种装法起的是同一个东西，启动后都会打开浏览器。按你打算怎么用挑一行：

| 安装方式 | 这样启动 | 适合 |
| :-- | :-- | :-- |
| 不安装 | `npx pi-web-simple` | 先试试，或不想往 PATH 里放东西 |
| `npm install -g pi-web-simple` | `pi-web-simple` | 想在任意目录直接敲一条命令 |
| `pi install npm:pi-web-simple` | 在 pi 里 `/web` | 你本来就泡在 pi 会话里——见下 |

端口和浏览器是仅有的两个开关：

```sh
PI_WEB_SIMPLE_PORT=5400    # 换个端口（默认 5319）
PI_WEB_SIMPLE_OPEN=0       # 不自动打开浏览器
```

想在终端关掉之后继续跑：

```sh
PI_WEB_SIMPLE_OPEN=0 nohup pi-web-simple >/tmp/piws.log 2>&1 &
pkill -f 'pi-web-simple/bin/pi-web-simple.js'   # 停掉
```

### 桌面版

`desktop/` 把**同一个**服务端和**同一份**前端装进 Electron 壳里，mac / Windows / Linux 安装包见 [Releases](https://github.com/woxihejinghao/pi-web/releases)：

| 平台 | 产物 |
| :-- | :-- |
| macOS（Apple 芯片 / Intel） | `pi-web-simple-<版本>-mac-arm64.dmg` · `-mac-x64.dmg`（另有 `.zip`） |
| Windows x64 | `pi-web-simple-<版本>-win-x64-setup.exe`（另有 `.zip`） |
| Linux x64 | `pi-web-simple-<版本>-linux-x64.AppImage` / `.deb` |

**自带 Node.js 运行时**，所以什么都不用预装——pi 的 RPC 客户端用的是裸命令 `node`，Windows 上 `.cmd` 垫片满足不了它。目前**没有代码签名**：macOS 首次打开要右键→打开，Windows 会有一次 SmartScreen 提示。自己打：`pnpm package:desktop`（仅限当前平台）；安装与排错见[桌面版](./desktop.md)。

它与 CLI 共用 `~/.pi-web-simple` 和 `~/.pi`，看到的是同一批项目与会话；端口优先用 5319（被占则退到随机端口），所以两者可以同时开着。macOS 上窗口是 `hiddenInset`：侧栏一路铺到窗口顶边、透出系统的 vibrancy 材质，红绿灯直接浮在它上面；Windows 与 Linux 仍用平台自己的标题栏。

### 作为 pi 包使用

这个包本身也是一个 [pi 包](https://pi.dev/packages)，带上它就能在 pi 会话里直接开界面：

```sh
pi install npm:pi-web-simple
```

然后在 pi 里：

```text
/web            # 启动界面：默认 5319，并自动打开浏览器
/web 5400       # 换个端口
/web --no-open  # 只启动，不开浏览器
/web status     # 看它是否在跑
/web stop       # 关掉
```

`/web` 起的子进程由当前 pi 会话托管，pi 退出时一并结束（不会留下占着端口的孤儿进程）；端口被占用等启动失败会把服务端最后几行日志报回 pi 界面。

### 从源码开发

```sh
pnpm install
pnpm dev
```

开发模式分成两个进程，改代码即时生效：前端 dev server 在 `127.0.0.1:5319`（Vite，`/api` 反向代理到后端），后端 API 在 `127.0.0.1:4319`。浏览器里打开的仍然是 5319。

```sh
pnpm build       # 构建前端 + 编译后端到 server/build
pnpm start       # 用构建产物启动（等价于 npx，端口 5319）
pnpm typecheck   # 前后端类型检查
pnpm test        # 前后端测试（vitest）
pnpm dev:desktop # 用 Electron 壳跑当前仓库（先 pnpm build）
```

## 文档

- [设计说明](./design-notes.md)——架构、与 pi CLI 并存，以及每个面板背后的取舍。
- [桌面版](./desktop.md)——Electron 壳：打包、自带的 Node 运行时，以及它现在还做不到什么。
- [已知限制](./known-limitations.md)——目前做不到什么；装之前值得扫一遍。
- [环境变量](./configuration.md)——全部可选，含默认值。
- [安全策略](../SECURITY.md)——它连不连网、数据放在哪、为什么不能暴露到公网，以及报告漏洞的渠道。
- [贡献指南](../CONTRIBUTING.md)——环境要求、CI 跑的四步、代码约定。

## 友链

- [Linux.Do](https://linux.do)——新的理想型社区。

## 许可证

MIT，见 [LICENSE](../LICENSE)。

界面与部分服务端逻辑移植、改编自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，Copyright (c) 2026 DeepSeek）与 [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)（MIT）。逐字节复制的范围与来源清单见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)——该文件随源码分发，请勿移除。

本项目是非官方项目，与 pi（Earendil Works）和 DeepSeek 均无隶属关系；π 名称与标识归各自所有者。

# 更新日志

本文件记录 pi-web-simple 的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.14.1] - 2026-10-29

### 修复

- **会话更新实时同步**：会话文件监听采用固定刷新窗口，并同步当前进程自己的写入；流式消息、历史加载、会话切换与重复消息的合并更加可靠，避免侧栏和对话内容长时间停留在旧状态。

## [0.14.0] - 2026-10-28

### 新增

- **提示词管理**：设置里新增一页，读写 pi 启动时加载的全局上下文（`AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md`，按 pi 自己的候选顺序取第一个存在的）与当前工作区的那一份，没有文件时可以就地新建。保存会重启驻留的 pi 进程，新会话立刻用上新指令；工作区没选中时只给全局那一半。API：`GET` / `PUT /api/prompts`。
- **Skills 管理**：设置里新增一页，列出 pi 解析到的全局、工作区与包内 Agent Skills，支持按名称/描述搜索、按启用状态筛选、读单个 `SKILL.md`。启停只写 pi 的配置，不改技能源文件，下一条消息生效；工作区还没被 pi 信任时界面明说原因，并且不给改。API：`GET /api/skills`、`GET /api/skills/detail`、`PUT /api/skills`。

### 变更

- **右侧栏撤下终端标签页**：「+」菜单、空面板的引导卡与 `Ctrl` + 反引号都不再提供终端入口，空面板回到一句「空面板」；读取布局时丢弃 `kind: "terminal"` 的标签，旧布局不会带回一个既画不出也打不开的标签。服务端的 `/api/terminal` 路由、`TerminalTab` 与 `terminal-state` 仍留在仓库里，恢复入口时不必重写。相关文档（`docs/known-limitations.md`、`docs/design-notes.md`）已改写。
- 侧栏「设置」按钮不再挂更新红点，版本提示只留在设置页里。

### 修复

- **流式内容的空洞不再让对话崩掉**：流式块按 `contentIndex` 落位，还没到的位置是空洞而不是空块；`partial` 改用 `slice()` 保住这个稀疏形状，渲染、助手文本提取、工具结果与「本轮是否已收尾」的判定都先过 `isContentBlock`，遇到空洞就跳过。

## [0.13.5] - 2026-10-27

### 修复

- **切回最近打开的会话不用再等一遍加载**：消息、fork 点与用量读数按会话缓存（最多 4 份，按最近使用淘汰），切回去立刻有内容，同时仍标成加载中，等最新状态落地。

## [0.13.4] - 2026-10-27

### 修复

- **草稿按会话保存**：输入框正文、图片与 `@` 引用各跟各的会话，切走再回来还在，侧栏的行上也标出哪些会话还留着草稿；空输入不占缓存，会话删掉时一并清理。

## [0.13.3] - 2026-10-26

### 变更

- 移除通用设置「关于」中的 pi 版本模块，保留项目版本信息及其检查更新、更新操作。

## [0.13.2] - 2026-10-26

### 修复

- **回复前切换会话不再遗留「未保存」和旧标题**：首次助手回复后的保存状态刷新改由全局事件处理，切到其他会话或工作区也会刷新原工作区；回复结束时补偿刷新，覆盖文件落盘稍晚的情况。
- **消息操作栏不再上浮覆盖内容**。

### 变更

- 输入框中的技能命令增加高亮，新会话与现有会话使用相同的命令信息。

## [0.13.1] - 2026-10-22

### 修复

- **Linux 上创建不了带图会话的用例（也是 0.13.0 没能发上 npm 的原因）**：
  `routes.test.ts` 把 ~200 KB base64 的转录塞进 `STUB_MESSAGES` 环境变量，而 Linux
  对单条环境字符串的上限是 128 KiB（`MAX_ARG_STRLEN`），`spawn` 直接 E2BIG，
  `/api/sessions/:id/state` 回 500。这条用例在本机 macOS 上一直通过，所以 CI 从
  0.12.0 起就是红的、npm 停在 0.11.0。桩进程新增 `STUB_MESSAGES_FILE`：给到路径就
  从文件读转录，环境变量只留给小 payload。

## [0.13.0] - 2026-10-22

### 新增

- **终端按 dsh 的侧栏模型重做：服务端会话 + 客户端附件**。空面板现在是一张引导卡（不再是一句「空面板」），「+ → 终端」也先选 shell：默认跟主机登录 shell（macOS 上通常是 zsh），列出 `/etc/shells` 与 zsh / bash / fish / pwsh 等候选，选择记在标签上。同一时刻只有一个窗口能输入，其余窗口只读并显示「接管」；`write` / `resize` 由服务端校验 `attachmentId`，不是 controller 就回 409。
- **屏幕快照与单调序号**：每个 shell 在服务端挂一棵 headless xterm（新增 `@xterm/headless`、`@xterm/addon-serialize` 依赖）。`attach` / `snapshot` 返回整屏加序号，`terminal_output` 帧带同一序号；客户端只接受更大的序号，断档时自动重拉快照，刷新、重连、两个窗口看同一个 shell 都不再回放字符流、不会花屏。
- **标签名归服务端**（`TerminalInfo.title`，默认是实际启动的程序名）：双击标签就地改名，右键菜单同一项，改名走 `PATCH /api/terminal/:id`；`RightbarTab.shellPath` 让同一标签重挂载还开同一种 shell。
- **退出/失败/丢失分得开**：已退出的 shell 保留屏幕与退出码，给「新建终端」；服务端重启后标签记住的 id 不存在时明说「进程已经不在了」，不再偷偷拿新 shell 顶替。关闭标签立刻移出界面并在后台 kill，失败在面板底部留可重试提示（`terminal_cleanup_failed`），不再 fire-and-forget。
- **配额、校验与回收**：8 个上限含启动失败/已退出；列数行数夹到 500×200，输入上限 64 KiB（413）；无附件空闲 2 小时回收，附件 90 秒无心跳让出输入权；输入/尺寸变化只在真实变化时发给主机。

### 变更

- **文件树的四行样式补齐 dsh**（图标集本身早已和 dsh 逐字节相同，差的是装它的那棵树）：字号从写死的 12.5px 换成 dsh 的 `var(--dsh-content-font-size-secondary, 13px)`，跟着字号轴缩放（默认 14 时树是 13px）；文件名补上 `white-space: nowrap`，长名字现在走省略号而不是把行撑高；行内提示从 11.5px 回到 dsh 的 12px；文件行的类型图标挂上 dsh 的 `.fileIcon`（`flex: none`），长文件名挤过来时不再被压窄。
- 终端主题即时跟随明暗切换（`MutationObserver`），xterm 设 `minimumContrastRatio: 4.5`。
- 终端标签的「重新启动」改成「新建终端」：先释放旧 id 再开，不再复用同一个 shell。
- `GET /api/terminal` 多返回 `environment`；新增 `GET /api/terminal/shells`、`GET /api/terminal/cleanup`、`POST /api/terminal/:id/attach|detach|heartbeat|cleanup/:id/retry`、`GET /api/terminal/:id/snapshot`、`PATCH /api/terminal/:id`。
- 终端不再只开 bash；`docs/known-limitations.md` 与 `docs/design-notes.md` 的终端段落已重写。agent 侧仍只有 `bash`，没有 dsh 的六个 `terminal_*` 工具。

### 修复

- **会话与路径的加固**：会话文件的 `sessionPath` 与工作区文件解析都改成先 canonicalize（`realpathSync`）再判前缀——符号链接指到目录之外现在被拒，`path=../../../etc/passwd` 在任何系统调用之前就返回 403；对应回归测试在 `server/src/session-path.test.ts` 与 `server/src/routes.test.ts`。
- **请求体有上限**：`POST/PUT/PATCH/DELETE` 的 `Content-Length` 超过 32 MiB（`PI_WEB_SIMPLE_REQUEST_BODY_BYTES`）直接 413，不再先把整段 base64 图片读进内存再判定。
- **会话状态不再被异步回写覆盖**：`useConversation` 的进行中状态改成按最新快照合并，异步回调晚到的旧值不再把界面打回上一轮（`web/src/features/conversation/useConversation.regression.test.ts` 覆盖）。
- **桌面打包更稳**：四个平台的产物校验、依赖安装可复现，Windows 退出时清掉整棵子进程树，目录选择弹窗的焦点与 Esc 处理也补齐了。

## [0.12.0] - 2026-10-16

### 新增

- **预览文件时多了一个「打开方式」分体按钮与本机应用列表（dsh 的 `ui-open-in-app`）**：预览头最右（重新载入之后）是本机打开的分体按钮——主按钮用系统默认应用打开，措辞是「用 Xcode 打开」，箭头列出这台机器上注册为这个文件类型的应用（真实图标、默认那个标「（默认）」），最后一行固定「显示文件位置」；不能预览的文件在空态画同一个控件的放大形态（36px、带「打开」两个字）。同一个文件的头部与空态共用一次查询（`useOpenWith`），列表还在读时按钮显示 13px 灰块并禁用，指针与键盘手势共用同一个 in-flight 锁，所以连点不会打开两次。几何与文案按 dsh：24px 分体、0.5px 边框、11px 字、菜单行 28px、应用图标 14px、最后一行前一条分隔线。应用列表来自 macOS 的 LaunchServices（`server/src/open-with.ts` 里一段 JXA 脚本走 `osascript -l JavaScript` 读 `NSWorkspace` 的 `URLsForApplicationsToOpenURL`）：同名同 bundle 的副本（自更新留下的 staging、多版本安装）合并成系统默认那一个、否则留版本最高的，图标是 `NSWorkspace` 现画的 32px PNG。应用目录只查 `/Applications` 与 `~/Applications`（与 dsh 相同，不去问全量注册表），所以装在别处的 app 不在菜单里，新装的要刷新页面。

- **打开与显示位置都先过读文件那道闸门，主机拒绝是一句话而不是一次失败**：前端只发工作区相对路径，服务端用 `resolveWorkspaceFile`（项目内 realpath + 前缀判定）解析——实测 `path=../../../etc/passwd` 在任何系统调用之前就返回 403；请求体的 `action` 是闭集（`open` | `reveal`），`application` 只对 `open` 有效，`reveal` 带上它会被拒绝。`.html`/`.svg` 的默认打开会先试默认浏览器（macOS 读 LaunchServices 里 `https` 那个 handler），`reveal` 是 `open -R` / `explorer.exe /select,`（退出码 1 算「已交给桌面进程」）/ `xdg-open` 父目录。主机拒绝（`{"ok":false,"error":…}`）与超时都不变成 HTTP 错误，而是头部下面一行原话（自带「关闭」——本项目没有 toast 层，而一句会自己消失的话不适合表达「桌面拒绝了」）：「没有可用的桌面」是一个答案，不是一次故障。**与 dsh 有意不同的一处**：dsh 在没有任何关联应用时把主按钮变成「显示文件位置」并去掉箭头，而这里只有 macOS 答得出关联查询（Windows/Linux 用的是注册表与 GIO，本机验证不到，所以没有带一份测不了的清单），照搬会让默认打开方式彻底没有入口——因此主按钮永远是「打开」（没有列表时措辞是「用默认应用打开」），「显示文件位置」永远在菜单最后一行。主机判断按 dsh：`SSH_CONNECTION`/`SSH_TTY` 非空，或 Linux 没有 `DISPLAY`/`WAYLAND_DISPLAY` 时一个控件也不画。

## [0.11.0] - 2026-10-15

### 新增

- **设置页按 dsh 重做：行是卡片，编辑器就地展开，添加入口合成一个分段控件**：设置行不再是 44px 的扁条，而是 dsh 的卡片（`--dsw-alias-settings-card-fill` / `-stroke` 一并补进主题）；编辑器不再弹窗，而是就地展开在那一行下面——同一时刻只有一张卡，点第二行的「编辑」会先把上一张收起来。添加入口从两个按钮合成一个：卡片顶上用分段控件在「第三方模型提供商」（从 pi 已认识的目录里选）与「自定义模型 API」（手写 id、地址、协议）之间切换，两块面板访问过就留在 DOM 里只做 hidden，来回切不会丢掉填了一半的内容，写入中或正在问端点时禁用切换。已在目录中的模型默认不勾选，重加也不会覆盖已有条目（合入时已有的条目赢）。焦点环改由新增的 `theme/focus.css` 与 `lib/input-modality.ts`（指针/键盘模态，`main.tsx` 在首帧前 `watchInputModality`）提供；页面标题改用 dsh 的 `.title`（16/24），配置路径按钮 28 → 24px，免得把标题行撑高。图标集补上 `strokeLinecap`（round / butt）与 dsh 的 outline chevron / close / trash 等图形，`FetchModelsDialog.module.css` 与 `ProviderEditor.module.css` 并入 `ModelsSection` 与 `SegmentedControl`。

- **会话的任务模块、输入卡与队列条按 dsh 像素级对齐**：计划条不再用布局边框，改用 dsh 的菜单面 —— `--dsw-alias-border-l1` 的 elevation 描边 + `--dsw-radius-lg` + `--dsw-elevation-panel`，宽度也从写死的 748px 改成「输入卡 − 32px」（`width` 与 `max-width` 两条都写，窄窗口才守得住每侧 16px）。状态标记照 dsh 的面板走 `StateDot`（10px 槽里一颗 6px 实心点，进行中是 14px 双圆环呼吸并旋转，`reduced-motion` 下停成固定弧），header 换成 dsh 的 `checklistOutline` 与 `chevronDownOutline`（折叠时旋转 180°——dsh 的 up 箭头正好是 down 箭头关于中心的镜像）。转录里的 diff 卡换成 dsh 的 `DetailItem` 语言：`+` / `−` / 勾 / 播放、10px 圆角方框，每行右侧跟状态词（旧 → 新、已移动），卡片自身不带 padding、每行 10px/14px 内缩加发丝线。输入卡的 max-width 改成内容宽 + 32px，三处侧沟槽 24 → 16px（与 dsh 的 `--dsh-composer-side-clearance` 同值），队列条换成 dsh 的 `.panel` 形态（上圆角、`::before` 铺菜单面、`::after` 画 0.5px 描边、下压输入卡 3px）。主题补 `--dsw-alias-state-idle-primary`，图标集新增 `checklistOutline` 与 `play`。

- **消息操作行按 dsh 对齐：最新一段常驻，更早的行悬停或聚焦才浮现**（dsh 的 `data-actions-reveal` + `endsWithResponse`）：复制 / 分支 / 用量 / 用时 / 时间的尺寸、圆角、间距逐条对齐，图标随字号轴缩放；用量从静态数字改成可点开的 `StatPanel`（缓存命中率加四个分桶，每个都在本轮内求和）；时间戳的三段式由新增的 `useCalendarDay` 供「今天」并跨午夜自动对表；行内说明文字换成自绘 `Tooltip`（portal 到 body，定位交给纯算术的 `tooltip-position`）；复制确认改用 dsh 的 1 秒窗口 —— 飞行中的重复点击不排队，失败不显示勾。

### 变更

- **字号轴的范围与默认值对齐 dsh：10–22、默认 14（原 12/17/15），变量改写到 `body`**：dsh 的真源是 `theme-settings.ts` 的 `FONT_SIZE_MIN` / `MAX` / `DEFAULT`，而本项目此前是 12/17/15，还有几处注释与文档把 dsh 的范围写成了 12–17——这次先纠正溯源，再对齐数值：`server/src/store.ts` 的三个常量、`web/src/lib/types.ts` 的边界、`DEFAULT_SETTINGS.contentFontSize`（15 → 14），以及 `theme/index.css` 里 `:root` 的固定值（第一帧在 `/api/settings` 返回之前就画出来了，两处必须一致）一起改。`applyContentFontSize` 从 `documentElement` 改写到 `body`：dsh 的 boot 脚本与 `ThemePresenter` 都写在 body 上，派生变量（`--dsh-content-font-delta` 等）也是在 body 块里算的。已存设置里的旧值不受影响，只有越界值会被夹到新范围。

### 修复

- **展开工作区不再把该工作区的整个历史重读一遍**：侧栏的工作区列表是 pi 的 `SessionManager.list` 派生的，它为每个 `.jsonl` 流式读完整文件、逐行 `JSON.parse`，只为算出标题、消息数和最后活动时间。原来的缓存是**整目录**粒度：目录里任何一个会话被写过，整个目录就重解析一遍。实测展开 pi-web-simple 自己的工作区（102 个会话 / 178MB）冷读 **672ms**，而 `sessions_changed` 之后（也就是你正在用的那个工作区每写一条消息）又是 672ms。现在缓存降到**按文件**：先 stat 目录拿到每个文件的 `大小|mtime`（102 个文件 **1.2ms**），只有签名变了的文件需要重解析——什么都没变 **0.9–1.5ms**，动过其中一个文件 **67ms**（单个文件的解析成本 5–76ms）。**没有复刻 pi 的派生语义**：变化的文件被符号链接进一个临时目录，交给 pi 自己的 `list` 去读，逐字段与整目录列出对照（新增的用例就是拿 pi 的结果做 `toEqual`）。临时目录这条路有三个边界，都写成了回落：pi 对「自定义目录」会按 header 的 `cwd` 过滤，任何一个喂进去的文件没出现在结果里（被过滤、链接失败、读不了）就退回整目录读一次，并把那次权威答案（连同 pi 主动跳过的文件）按文件记下，不会每次请求都回退；目录的现况负责删除对账——不在名单里的缓存条目直接丢掉；同一目录的并发请求排队等前一次读完，而不是各自跑一遍全量（原来的缓存只在解析完成后才写入，N 个并发冷请求会各读一遍 178MB）。桌面版支持 Windows，那里建符号链接要开发者模式，所以链接失败时退化为硬链接，跨卷再失败就走整目录那条路。

- **还没列过的工作区不再先说自己「还没有会话」**：侧栏的工作区行只从 `sessions[projectId]` 画，所以「请求还在飞」与「真的一条都没有」长得一样——而首次列出正是上面那次整目录的读，于是点开一个没打开过的工作区时，屏幕先显示「还没有会话。」，0.7 秒后 5 行会话突然冒出来。现在这种工作区显示「正在载入会话列表…」，并由 `useDelayedFlag`（250ms，与转录那枚提示同一枚钩子）压住头几帧：热工作区毫秒级返回，出现又消失的提示只会闪两帧，比不显示更差。标记只在「从未列过」时打——已经有行的重载继续画旧行，不退回空态也不闪提示；读失败或被更晚的请求顶替都不会把提示留在屏幕上（只有最新那次请求能清它）。**它只解释等待，不缩短等待**：服务端重启后第一次展开仍然要付那次冷读。

## [0.10.0] - 2026-10-15

### 新增

- **会话页对照 dsh 补齐五处差距（P1 批次）**：这一轮把对照检查里排前的五项全部落地。① **`edit`/`write` 的工具卡画 diff**（dsh 的 `DiffBlock`）：`web/src/features/conversation/diff-card-model.ts` 从调用参数本地推导（`edit` 逐条 `oldText`→`newText`，`write` 整段新增），`diff@8.0.4` 的 `structuredPatch`（context 3、单处编辑超 256 行回落整段替换）切成行，`DiffCard.tsx` 渲染——路径头、`+/−` 行、文件间 `⋯`、超出 9 行折叠成「其余 N 行」、复制带前缀、换行开关；折叠行的摘要旁给出 `+N −M` 计数。参数没到齐或调用失败回落通用卡。② **回答被截断时有一行说明**（dsh 的 `TurnMaxTokensItem`）：转录里最后一条 `stopReason === "length"` 的回答下画 `TurnTruncated`（warning 点 + 「回答在输出上限处被截断」），流式中不画。③ **排队消息可以撤回和编辑**（dsh 的 `QueueDock`）：pi 没有逐条队列原语，服务端 `server/src/queue.ts` 维护一份镜像——入队时记下文本与图片，`queue_update` 事件对账（头部排空、尾部收养终端发的纯文本项）；新路由 `POST /api/sessions/:id/queue/update` 用 `clearQueue()` 取回实际队列、校验前端看到的条目还在原位（不在就先恢复现场再回 409）、应用变更后整队重排（编辑只换文本，图片丢弃——dsh 同语义）。前端 `QueueDock.tsx` 挂在输入框上方：每条排队消息一行预览、行内编辑（Enter 提交 / Esc 取消）与删除，乐观更新、失败回滚。④ **会话内容宽度可调**（dsh 的 `ConversationWidthControls`）：两侧拖拽把手（向外拖一格等于内容让两格）+ 在把手上滚轮按行/页滚动转录；偏好存 `dsh.conversation.contentWidth`，未设时按列宽的 64% 取中（680–920px），设了就夹在 640px 到列宽减 176px 之间；宽度轴经 `--conversation-content-width` 供正文与输入框共用。⑤ **任务清单行显示相对上次的 diff**（dsh 的 `todo-diff-model`）：`todoBaselinesOf` 正向扫一遍转录给每个 `todo` 调用配它之前最近的一份快照（答不出的调用不更新基线），行尾给「新增 2 · 更新 1 · 移除 1」计数，展开卡画每次变动的标记——新增/移除换 `+`/`−`，状态变化给「待处理 → 已完成」，没动的行折在「N 项未变化」下；首次写入只说「首次记录」。

- **「关于」里的项目版本行现在会告诉你有没有新版，并且能一键更新**：以前那一行只是把构建时烘进去的 `__APP_VERSION__` 印出来——它回答「我是什么版本」，不回答「我落后了吗」。现在服务端去 npm registry 问 `pi-web-simple` 的 `latest` 标签（`server/src/updates.ts` 的 `readAppVersion`），与**每次现读 `package.json`** 得到的当前版本比较（不烘进产物，否则更新完还会接着报旧号）；落后时那一行给一枚「立即更新」，命令按代码自己的位置选——pi 的包目录下走 `pi update npm:pi-web-simple`，其余（`npm install -g`、npx 缓存）走 `npm install -g pi-web-simple@latest`，新增的 `POST /api/updates/app` 执行它并把刷新后的答案返回。**这是唯一一个「做了什么」与「现在是什么」可以不一致的更新**：改的是磁盘副本、进程里还是旧代码，所以成功后那一行说的是「已更新到 x.y.z，重启后生效」，而不是翻成「已是最新」；服务端也不从正在作答的那个请求里重启自己。桌面壳通过新变量 `PI_WEB_SIMPLE_DESKTOP=1` 自报家门（`desktop/src/main.cts` 写入），那一行的按钮换成「复制下载地址」（release 页）——它这份代码在 app bundle 里，`npm install -g` 更新的是另一个东西，但**照样检查**。侧栏那枚圆点现在把项目自身也算进 `hasAnyUpdate`；设置页里 pi 与项目两行共用同一条状态规则（`versionStatus`，原 `piVersionStatus`）；`PI_OFFLINE` / `PI_SKIP_VERSION_CHECK` 两个开关照旧一并管住这次检查。顺带把 `presets.ts` 自己那份 `PACKAGE_ROOT` 并进 `config.ts` 的同一份。

- **回答里提到的文件现在是一枚能点的 chip，点了在右栏打开并滚到那一行**：显式链接（`[the loader](src/app.ts#L24-L30)`，GitHub 风格 `#L24` / `#L24-L30`）与行内代码（`` `useConversation.ts:396` ``、`` `src/app.ts:24-30` ``）渲染成 chip（`FileRefChip`），裸文本路径不做。判定「这个 token 是不是一个文件」的词汇表放在轮的边界上（`turn-refs.ts`）：本轮每个工具调用参数里的 `path` / `file_path`，精确拼写优先、其次 **basename 唯一命中**；解析在 `file-ref.ts`（路径形状、`?query` 与 scheme 拒绝、盘符豁免、行区间上限 500 行、`./` 折叠），解析与匹配都是纯函数并各有测试。**流式期间不做**，未命中不降级（行内代码仍行内代码、外链仍外链），锚点内部的行内代码不 chip。**行定位存在预览标签页上**：同一个文件只有一个标签页，第二次点另一行是把它移过去而不是叠副本，刷新后位置还在；有位置时代码分支换成新写的 `CodeView`（一行一个 DOM 行），1MB 以上的分页文件由 `TextPager` 一页页读到覆盖目标行（上限 20 页），分页定位改由服务端一次扫描完成（`/text?fromLine=`，带回 200 行前置上下文与 `startLine`）。行视图带语法色（`highlightLines` 交出逐行高亮，主题 `css-variables`，亮暗切换不需要重新高亮）。**图片引用悬停即出图**：`/raw` 现在也服务图片（`RAW_MIME` 并入 `IMAGE_MIME`），chip 上挂着 `data-file-preview-url`，悬停 400ms 后浮出缩略图与文件名。另配一个可复现的行为验证 `pnpm test:file-refs`（`bench/verify-file-refs.ts`，与场景 C/D 共用真实 Chrome 设施、零 LLM 成本，共 21 项断言）。**顺带修掉一个真实的重挂 bug**：`Markdown` 的 `components` 原本是渲染期新建的箭头函数，react-markdown 把每一项当作元素类型，于是整棵 markdown 子树在每次父级重渲染时被卸载重挂（文件 chip 的悬停计时器、代码块的滚动位置、折叠行的展开状态随之丢失）；现在四个渲染器都在模块作用域、数据从 context 取，`components` 成为模块级常量。
- **计划模式：先探索、先设计，批准之后再动手**：落在本仓库自己的扩展 `extensions/plan-mode.ts` 上，和 `ask-user`、`todo` 同一条路——不在包清单里，只由 Web 启动的 pi 用 `--extension` 带入（`server/src/presets.ts`），极简组成照旧什么都不给。**状态是一条日志**：每次开关只写一条 `pi.appendEntry("pi-web-simple:plan-mode", { active })`，读取时从当前分支折叠最新一条，于是 resume、fork、compaction 之后自然正确；服务端读的也是同一个文件（`server/src/session-plan.ts`，随 composer 读一起返回 `planMode`），界面上没有第二份状态。**指引是软的**：`before_agent_start` 往系统提示里加一段 `plan-mode`，不动工具清单（工具表一变 provider 的缓存前缀就作废）。bare `/plan` 只记状态、等下一条消息；`/plan <message>` 用 `pi.sendUserMessage()` 把那条消息立刻发出去。**审批复用问答那条通道**：`exit_plan_mode` 通过 `ctx.executeTool("ask_user_question", …)` 提一个带 `intent: plan-review` 的单题批次，交给一张独立审批卡（`PlanReviewPanel`，整卡接管）；intent 里多带一个 `callId`（`exec.callId`），审批卡、转录卡片和侧栏标签页靠它认出同一份文档。它刻意没有 deadline（一张读到一半就过期的卡会把「我还在看」变成「没人回答」），批准回 `{ approved: true }` 并记 inactive，退回把反馈放进错误结果让模型重写，plan 模式外调用它直接失败。**交互面按 dsh 重排**：① 模式 chip 从会话头部搬进输入框的控制行（`PlanChip`，附件按钮旁），只在模式开启时才画——进入靠 `/plan`（`/` 菜单里就有），chip 是「出去」的那条路；② 卡片不再在卡内展开计划正文，「在侧边栏打开计划」进顶部警示条右侧，右栏因此多了一种 **`plan` 标签页**（`plan-store.ts` 按会话发布、`PlanTab` 读，转录是唯一来源，所以会话一打开、刷新之后标签页自己就活了）；③ 评审一到就自动打开那份文档一次（dsh 的 `PlanReviewOpen`），手动关掉之后不会再被自动打开；④ 一轮结束后的计划卡片落在轮次尾部（`data-plan-card`），被退回的计划和批准的一样留卡；⑤ 侧栏会话行有了 dsh 的第三种状态：有待审批的计划时状态点是 warning、无障碍文案「计划待审批」，时间戳位置换成「计划审批」。**浏览器里走了一遍，补上四处**：① 计划模式的权威来源是**进程**（`POST/GET /api/sessions/:id/plan` 都从 `get_entries` 折叠，文件只作兜底），composer 读还多带一个 `sessionOnDisk`，文件不存在时前端刚做的开关不会被一次「没东西可读」的读推翻；② 新会话页那条输入框也认这个命令了：`/plan` 作为**第一条消息**时同样以扩展命令送出、同样点亮 chip，而不是画出一条 pi 从没写过的用户气泡；③ 开关本身**不再发通知**——chip 就是反馈，只有「已经开着 / 已经是关的」才提示一句；④ 退出计划模式后立刻向进程确认一次，chip 不必等下一轮结束才消失。另附一个真的拉起 pi 的验证脚本 `pnpm test:plan-mode [log|exit|all]`：`log` 验 `/plan` 的日志协议（不花模型调用），`exit` 让模型真的调一次 `exit_plan_mode`、检查卡片上的 intent（含 `callId`）与无截止时间，再批准并把这次退出读回来。
- **空会话可以在头部换模式了**：组成原本只能在新会话页选，选完就跟着进程走——因为它就是启动参数。但 pi 只在**第一个请求**时才把首条 system message 写进会话 JSONL，所以一个还没说过话的会话在磁盘上没有任何组成痕迹，换一个组成不会和任何历史矛盾。新的 `POST /api/sessions/:id/preset` 就守在这条线上：关闭旧进程、用新 preset 重开同一个会话文件，路径、id 与侧栏位置都不动；一旦首条 system message 落盘就回 409——这正是 dsh 的 `agent-preset-locked`，只是判据取的是 pi 自己的证据。会话头部的模式标签因此分成两态：空会话时是可点开的选择器，跑过一轮之后变回只读徽章。`presetLocked` 随 composer 读一起返回，不额外多一次请求。

### 修复

- **扩展命令不再在转录里留下一行孤儿**：pi 对扩展命令只记录**命令自己写下的消息**（`/plan <message>` 记的是那条需求，`/todos` 之类什么都不记），而输入框原来把用户敲的那一行原样乐观插进转录，于是屏幕上有一行 pi 从没写过的消息，只有刷新才会消失。现在 `extensionCommandName()` 认出这一类文本并改走 `conversation.runCommand()`：不画乐观行，等 pi 在流里记下它自己那条再采纳（新增的 `adoptUserRef` 只认命令之后的第一条 user 消息）。普通消息、技能命令与提示词模板一个字没改——后者本来就被 pi 展开成普通消息记录。
- **技能列表不再因为第一次枚举失手而整场会话消失**：命令列表只有活着的 pi 进程答得出来，服务端拿不到进程时会退化成「只有内置命令」并在响应里带一个 `error`。前端以前把这个结果原样当作最终答案缓存进 `commands`，于是启动瞬间那次失败（预热进程还没起好）会让 `/` 菜单在整个会话里都没有技能和模板，直到刷新页面——这正是「输入 `git-commit` 有时候匹配不到」的来源。现在这份降级结果会被标记为 partial：内置命令照常可用，但不计入「已加载」，并按 1.5s / 4s / 10s 有界重试；`commandsLoaded` 在 partial 时同样为 false，不会再把技能报成「未知命令」。
- **`/` 补全按技能名而非 `skill:` 前缀排序**：技能与模板命令都带命名空间（`skill:git-commit`），而用户输入的是后半段。原来的匹配只看整串，`git-commit` 只能算子串命中，和别的子串命中并列后由字母序决定先后——输入 `/search` 时 `skill:brave-search` 会排在 `skill:search` 前面。现在 `filterCommands` 先按命名空间尾名匹配：完全相等（`git-commit`）→ 尾名或全名前缀（`git`、`skill:git`）→ 全串子串 → 去掉标点后的模糊命中（`gitcommit`）→ 仅描述命中；命中 `git-commit` 的技能稳定排在首位。
- **`/` 菜单不再替别的组成作主**：命令是进程的属性，而列表原来按 project 取——`registry.listCommands(projectPath)` 的缓存键是 project 路径，句柄则用 `findLive()` 随便拿一个同项目的活进程，或者干脆拿默认组成的预热进程。于是一个项目里先打开标准会话、再打开极简会话时，极简的菜单里仍然列着它有模板、有技能、有 `todo` 的样子——点下去只会变成一条普通消息。现在 preset 是问题的一部分：`GET /api/projects/:id/commands` 接受可选的 `presetId`（未知值 400），`listCommands(projectPath, presetId)` 的缓存键与预热槽同形（`compositionKey`），句柄也只按该组成找。前端的 `commands` 状态随之从 project 键变成 `commandsKey(projectId, presetId)`，会话打开与 hero 上选模式都会按自己的组成去取；服务端会在响应里回显它答复的是哪个组成，一次与切换赛跑的请求不会再落到错的键下。实测极简进程的 `get_commands` 恰好只有一条 `/web`。
- **打了一条不在当前组成里的命令，现在会说一声**：pi 对没注册过的 `/xxx` 是原样当普通文本交给模型的，界面上读起来就像「命令没反应」。`unknownCommandName()` 用与内置命令解析同一套正则找出这种名字（`/etc/hosts` 这类路径不受影响），由 composer 发一条提示——消息照发，因为用户可能就是想发这段文字。只在命令列表已经落地后才判断，否则刚打开会话的第一秒会把每条命令都报成不存在。
- **`/` 菜单的取消语义与 dsh 对齐，并修掉删掉斜杠后打不开的问题**：Escape 关掉菜单时，把当前 token（斜杠位置 + query）记为「不要了」；同一个 token 原样重读（Escape 紧跟的那次 `keyup`）不会再弹出来，输入新的 query 或换到另一个 token 才重新武装——这是 dsh `ui-input-trigger` 的规则。原实现漏了其中一条：token 消失（删掉斜杠、敲了空格）时要清掉这条记录，否则删掉 `/` 再输入 `/`，残留的 veto 会让菜单永远不再出现。现在这段状态转移由 `resolveCompletion` 单独承载，`/` 和 `@` 两套补全一起用，规则有测试钉住。
- **计划审批不再和批量问答卡重叠**：`plan-review` 原本只是把选项列表换成审批块，卡壳还是问答卡的——于是卡头把计划标题印第二遍、页码写着「第 1/1 题」，而 Skip 会被 `outcomeFrom()` 读成「退回重做」、一个选项都没选时点「提交」只会报「还有 1 个问题未回答」。现在按 dsh 的 `PlanReviewPanel` 改成**整卡接管**：`QuestionComposer` 命中 intent 时直接把它当整张卡返回，于是只剩一条全宽警示条（状态点 +「计划审批」+ 右侧「查看全文」）、`h3` 计划标题与正文首段（两行截断，标题行不再重复成摘要）、底部只在「请求修改」之后浮出输入框与「提交修改意见」；页码、Skip、提交、折叠与取消按钮一并退出（Escape 仍可取消，输入框回车仍可提交）。标题与摘要也从计划本身取（`plan-review-text.ts`，dsh 的 `extractMarkdownPlainText`：首行作标题、首段作摘要），不再拿 `header` 里那句“Approve this plan…”当正文。
- **右栏的计划标签页也按 dsh 的 `PlanPreview` 收尾**：容器补上 `position: relative`（逐条对比后这是 `PlanTab.module.css` 与 dsh 唯一的差值），文档排版也不再借用转录那套紧凑间距——`Markdown` 多了 `variant`（默认 `message`，`document` 才是 dsh `MarkdownText` 的文档间距：标题 32/16、段落 16、列表 16、`strong` 600），标签页用它渲染，尺寸、代码块与表格仍走同一套 token。

### 变更

- **`ask_user_question` 改成只服务 Web，终端会话不再加载它**：它原本和 `todo` 一起由包的 `pi.extensions` 清单自动发现，于是 `pi install npm:pi-web-simple`（或把本仓库列进 `packages`）之后**每个终端会话**也会注册这个工具。现在清单从两条 glob（`./extensions/*.js` + `./extensions/*.ts`）改成只剩一个入口（`./extensions/index.js`，即 `/web`），问答工具改由 Web 启动的 pi 显式带入：`server/src/presets.ts` 的标准 preset 追加 `--extension <包根>/extensions/ask-user.ts`，而极简仍然连这份参数也不给。**扩展文件本身没动**：`rpc` 走编码进 `select` 标题的整批卡片、`tui` 走逐题对话框，后者现在只服务手工 `pi -e extensions/ask-user.ts` 的会话。附带修掉一处一直存在的问题：没把包装进 pi 的 `npx pi-web-simple`，此前 Web 会话里其实根本没有这个工具，现在有了。发布闸门也把 `extensions/ask-user.ts` 列进必备产物。
- **`todo` 也改成只服务 Web，终端会话不再加载它**：上一条的同一个动作，理由不同——问答是「格式只有认得的客户端解得开」，任务清单则是它的载荷本身就是 Web 的投影：每次调用带回的整份列表写在 `details.todos` 里，面板与转录行读的就是这个形状，而清单能带给终端会话的只有工具列表里多一行和那行 snippet。现在它也由 `server/src/presets.ts` 在非极简组成里用 `--extension` 带入，发布闸门把 `extensions/todo.ts` 一并列进必备产物。**代价写在明处**：pi 自己不带 todo 工具，所以普通终端会话既没有 `todo` 也没有 `/todos` 覆盖层，想用得手工 `pi -e extensions/todo.ts`——文件里的终端渲染与覆盖层原样保留，只服务这种会话。极简组成照旧两样都不给（dsh 的极简名单里也没有）。
- **品牌 mark 换成 π WEB 字标，桌面图标按平台分开圆角**：素材仍是黑底白字的一张方图（`desktop/resources/icon-source.png`，网页端 `web/public/pi-mark.png` 与它同源）。但两端对圆角的期待相反：macOS 从 Big Sur 起要的是 1024 画布里 824×824、四角透明的 squircle，Windows 与 Linux 要的是满幅方形、圆角交给系统或桌面环境——原来三个平台共用一份裁好圆角的 `icon.png`，在 Windows 上会让图标比同排应用小一圈。现在 `pnpm icons:desktop` 出两份：`icon.png`（macOS）与 `icon-square.png`（Windows/Linux），`electron-builder.config.mjs` 与开发模式的 `electron .` 各按平台取用；网页端那一份始终是满幅方形，界面里的圆角由 CSS `border-radius` 按尺寸给（侧栏 24px、新会话页 30px、状态行 14px），预裁会被再裁一次。
- **极简模式的说明写全了它的边界**：新建会话页的那句话补上了「扩展命令与提示词模板也不加载（只放回部署自己的 `/web`）」。

### 文档

- README 与 linux-do 宣传文里「极简模式选了就改不了」改成「跑过一轮之后不能改」。

## [0.9.0] - 2026-10-12

### 新增

- **新建会话时可以选择「极简模式」**：这是 dsh 的 `minimal` agent preset——整个系统提示固定成一句话（`You are a helpful software engineer assistant.`），模型面向的工具只剩一个 `bash`，上下文文件、技能、MCP、扩展与提示词模板全都不加载。**它不是界面精简，是进程的组成**：pi 没有改工具集或系统提示的 RPC（既没有 `set_tools` 也没有 `set_system_prompt`），所以一个 preset 只能表达成启动参数（`--system-prompt` / `--tools bash` / `--no-context-files` / `--no-skills` / `--no-mcp` / `--no-prompt-templates` / `--no-extensions`）。选中的 id 从新建会话页一路带到 `POST /api/sessions`，之后没有任何地方能改它——等同 dsh 的 `agent-preset/locked`，只是锁在进程上而不是落在日志里。选项长在工作区选择器旁，会话头部只在非默认时挂一枚只读标签。**`/web` 被单独留下**：`--no-extensions` 是唯一能把 `todo` 与 `ask-user` 一并去掉的开关，而 `/web` 是这个部署自己的入口。**预热按组成分桶**：`claimPrewarmed()` 带 presetId、不匹配就返回 `null` 让调用方自己 spawn（极简会话因此不走预热）。**已存在的会话从文件反推**：`readSessionPreset()` 读会话 JSONL 首条 system message 里的提示段落与工具声明，只在打开会话时读一次、不进列表；判据按段落匹配而不是整体比较——`--system-prompt` 替换的是 persona 段，pi 仍会附上自己的 `<cwd>` 段；工具列表作为兜底（实测极简会话的 `toolsAdded` 恰好只有 `bash`）。

- **自动调用有了行为规则，不再只靠一行摘要**：`ask_user_question` 除了进系统提示工具清单的那一行 `promptSnippet`，现在还带三条 `promptGuidelines`——它们和 bash 之类内置工具进的是同一个位置（系统提示的 Guidelines 段）：该问的是「答案代价高、用户得长期承受」的（数据模型、公开 API、依赖选型）；不该问的是用户已经授权你自己决定的、或选错很容易回退的；以及**能从仓库里读到答案的不要问**。此前只有那一行摘要，边界只能由模型自己揣度：实测（真实小项目、prompt 里不含任何「问」字）它会主动问——「加个登录功能」触发了三个真正需要人决定的问题（认证方式、账号存哪、本次范围）；而把同一个任务放进空目录时，两例都触发了，它问的其实是「项目在哪」。反方向也验证过：写明「你自己定，不用问我，直接做」时它不调用，直接动手。规则确实进了系统提示（用一个临时扩展把 `getSystemPrompt()` 写出来确认：38973 字符的提示里，两个 snippet 与三条 guidelines 都在）。

- **问答链路有了一个真跑 pi 的验证脚本**：`pnpm test:ask-user [basic|timeout|plan|all]` 会真的拉起一个 pi 进程、像一次会话那样加载本仓库的 `extensions/ask-user.ts`，并按 web 客户端的方式回答；断言全部落在「线上回来的字节」和「pi 记下的结果」上，所以跑绿意味着扩展、codec 与 pi 三方一致，而不是某个桩件听话。三个场景各自一个新进程（扩展没有状态，一个会话的对话框不该漏进下一个）：`basic` 验一批两题（含多选与自定义文本）的往返；`timeout` 故意不回答，等 pi 自己的窗口过期，验它被记成 `timed-out` 而不是一次决定（约 40 秒）；`plan` 验 `intent` 过了解码、`approve` 仍是模型自己给的标签。它会消耗模型调用，所以不在 `pnpm test` 里。

- **写好的计划可以当场批准或退回**：`ask_user_question` 的题目可以带一个 dsh 的 `intent`（`{ kind: "plan-review", approve: "<选项标签>" }`），卡片识别后不再画选项列表，而是渲染一张紧凑的审批卡：一条「计划审批」条、「查看完整计划」的链接、计划标题，以及默认只给两行的纯文本摘要——展开才是完整 markdown（在 220px 里自己滚）。两个动作是「请求修改」与模型自己给的 approve 标签：后者**原样显示、不翻译**，因为回传的就是那个字符串，翻译过的按钮会发回一个提问方从未提供过的值。点了「请求修改」就把自由文本框交出来，答案就是那一题的 custom（decline + 反馈）。**校验放在扩展里**：approve 必须真的是这一题自己的某个选项标签、且这一题必须带 `detail`，任一条不成立就整个调用失败。服务端只做透传，认不出的 tag 降级为普通选项列表；前端遇到多问题批次里带 tag 的题也走普通列表——一个裁决代表不了一批问题。

- **答过的提问可以翻回来看**：`ask_user_question` 的工具行不再是那段原始 JSON——折叠时一行「已回答 · 2 个问题」，展开是把答案当成同一张卡读回来：选项上标出被选的那条（连同它的说明）、自由文本单独一段、跳过的题就在原位写「已跳过」。**回看不分页**：这是阅读而不是决定，一个看不见上一个裁决的结论正是用户打开它想核对的东西；而结果读不懂时（旧版本写的、或形状不认识）**降级回通用工具行**，至少还能看到原始输出，一张没有记录可画的卡片比它替掉的东西更空。超时后由后续消息补答的批次不在这里重拼答案——那些答案就在下面的那条消息里，位置比任何重排都准确。

- **超时的问题不再丢失：截止时间过后，它仍然可以回答**：卡片的截止时间一到不再把整批当作「谁都没答」，而是按 dsh 的语义上报 pending，问题留在牌桌上等人回来。判定不看任何内存状态，而是**从转录里投影**：一次超时的工具结果自己记着 `outcome: "timed-out"`，用户的补答则是一条带标记的普通 user 消息（`[answer_to_pending_question] {"callId":…,"answers":[…]}`），`pending-questions.ts` 把两者对起来读，于是刷新、压缩、分叉之后结论都一样，服务端一行没改。它**不占输入框的座位**——没有任何进程被它挡住，它是输入框上方的一条，点开才是同一张卡片（`QuestionComposer` 现在同时服务两种场景，靠 `cancellable` / `timeoutMs` / `draftKey` 三个 prop 分岔）。补答发出去的是新一轮的 user 消息，而不是伪造一个已经结束的工具结果。**还修掉了一个会真正丢问题的边界**：pi 在客户端消失（关标签页、断连）时会用自己的计时器了结对话框，而它的返回值与「用户点了取消」同为 `undefined`，上一版一律记成 cancelled；现在扩展用自己的时钟分辨两者（取消立刻回来，截止时间在窗口之后才回来），于是没人在场时记的是 `timed-out`。草稿跟着卡片走：`question-draft-store.ts` 把未提交的选择写进 `localStorage`（按对话框 id 或工具调用 id 分键），读回时要求草稿与当前批次一一对应，题数对不上就整份丢掉。

- **`ask_user_question`：一批问题一次答完，卡片长在输入框的位置上**：这是 dsh 的 `ask_user_question`——一次调用带一整批问题（每题有稳定 id、可选 header、可选 detail markdown、可带说明的选项、可多选，也可以只有自由文本），用户在一张卡里逐题作答、最后一次提交，工具拿到的是一份按 id 对齐的答案批次。**pi 的 UI 子协议只有 `select` / `confirm` / `input` / `editor` 四种单问题对话框，没有批量形态**，所以批次被编码进 `select` 的 title（`pi-web:ask-user:v1:` 前缀），由 `server/src/ui-requests.ts` 在入站时解包：浏览器收到干净的 `questions`，回答时再由服务端把决定打包回 pi 期待的值。**翻译只放在这一段**，前端不需要认识任何编码。TUI 不走这条路：`ctx.mode === "tui"` 时退回逐题的原生对话框。**超时的语义在这里和普通对话框相反**：卡片到点会主动答 `{ timedOut: true }`，扩展据此返回 pending（文字里明写「这是 pending，不是 skip」），而 **pi 那边的截止时间被刻意推迟了 30 秒**（`REPORT_SLACK_MS`）——不让出这段余量，pi 总是先了结、上报永远输掉，工具就只能报「取消」。答案形状照 dsh 来：单选的自由文本**取代**选项、多选的文本**补充**选项，跳过就是一条空的 `selected`，而整批是原子的（还有题没答时提交会被拦下）。与 dsh 有一处刻意的不同：**首选项带「(Recommended)」也不会被预先选中**。

- **压缩在转录里有了自己的一行**：一次 compaction 之后，对话流里多出一条可展开的「上下文已压缩 · 压缩前 324K tok · 时间」，展开是 pi 写的那份摘要（最高 320px 自己滚）。**它落在压缩发生的位置**：看着压缩发生时行就出现在转录末尾、它折叠掉的那些轮次下面，而从磁盘读出的会话里 pi 重放的 context 本来就从切点开始，行自然在最上面。它也不占轮次号（`groupTurns` 只认 user / assistant），导轨上的刻度与跳转目标都不会移位。压缩进行中时，同一位置先出现同一条行头的「正在压缩上下文…」（扫光），`compaction_start` / `compaction_end` 两帧驱动，中止或失败时不落任何东西。手动 `/compact` 也走同一条路：不再额外重读转录，也不再弹底部那条「已压缩上下文：约 X → Y tokens」提示。服务端一行没改（只多了一个锁住这个假设的测试）。

- **模型条目多了「支持推理」与两个档位勾选，获取模型时也会顺手采纳网关自愿给出的能力字段**：模型目录里每行的披露区多了一栏「思考强度」——一枚「支持推理」复选框，勾上后这个模型的 `reasoning` 变成 `true`，输入框右下角那张卡片里的滑轨立刻有档位可拖；旁边两枚「极高 xhigh」「最高 max」是提供方专属的档位名，按 pi 的规则只有 `thinkingLevelMap` 明确写了才算数。**放在行上而不是 provider 上**，因为能力属于模型；而**必须由人来说**：OpenAI 与 Anthropic 的 `/v1/models` 每条只有 `id` / `object` / `created` / `owned_by`，pi 自己也不认识自定义 provider 下的模型。勾选只**增删 `xhigh` / `max` 两个键**，手写的其他档位映射（包括把某一档映射成 `null` 来禁用它）原样活过保存。同时「获取可用模型」也变贪了一点：网关如果肯说，`context_length` / `max_model_len` / `top_provider.context_length`、`max_output_tokens` / `max_completion_tokens`、`architecture.input_modalities`、`capabilities.vision`、`supported_parameters` 里的 `reasoning` 都会被读进待加入的条目。**只采纳肯定信号**：`reasoning: false` 会被忽略，数字只认正整数（`0` 与负数当作占位符丢掉）。

- **模型条目可以直接改上下文窗口、最大输出和输入类型了**：模型目录里每行多了一枚披露箭头，点开是三个字段——「上下文窗口」与「最大输出 token 数」两个文本框，以及「输入类型」的文本 / 图片复选框。**默认收起**，因为这三项是例外而不是常态，常开的五行控件会让最常做的那件事（改个名字）看起来必须先填完它们。两个容量字段在界面上是**文本**：`128000` 和 `128K` 说的是同一个容量，所以 `model-capacity.ts` 在两种拼写之间翻译（`1M` 按 1000K 算，能整除就缩写成 `K` / `M`）；打字期间的文本由行自己的缓冲持有。读不懂的文本（`abc`）在行里存成 `NaN` 并**拦住保存**——`JSON.stringify(NaN)` 会变成 `null`，而 `null` 会让 pi 拒绝读整个 `models.json`；服务端不信客户端、在 `parseModelEntries` 里又拒绝一遍。**空着的字段保存时从条目里删掉**，让 pi 回到自己的目录或内置默认；渲染不出来的字段（`cost`、`compat`、`inputLimits`）照旧按 id 合并保留。输入类型**至少留一个**：空数组在 pi 那里不是「什么都不接受」、是「没说」，所以最后一个还勾着的复选框是禁用的；没声明过 `input` 的模型显示为只勾「文本」。服务端读回这些字段时也会丢掉 pi 的 schema 不会收的值（`contextWindow: "1M"`、`maxTokens: -5`、`input: ["audio"]`），于是一份手改坏的 `models.json` 仍然打得开设置页。

- **输入框右下角的模型与思考强度合成了一张卡片，样式照 Codex 来**：收起时是一枚按钮——模型名加当前档位词；点开是一张卡，顶上居中的一行灰字报出当前档位，右上角一枚重新载入，中间是能点开模型列表的名字行，底下一条滑轨：走过的部分填蓝、未到的档位画成小圆点、一枚白球停在当前档（关闭 / 极简 / 低 / 中 / 高 / 极高 / 最高）。**用一个滑块而不是第二个下拉菜单**，因为档位本来就有序——位置同时说出了「在哪一档」和「还剩几档」。滑轨支持点击、拖动、方向键与 Home/End；拖动时只在本地预览、松手才提交，横跨五档的一次拖动是一次选择而不是五次往返。两半放进同一张卡，是因为它们本来就是同一个问题的两半。已滑过的档位在蓝色填充上留成浅白色的小圆点，未到的留成轨道上的灰点。档位切到「关闭」时不画蓝色填充、只留轨道——`off` 不是梯子的最下一级，是「不用梯子」。数据来源按代价分岔：**当前档位**来自 pi 自己写进会话文件的 `thinking_level_change`；**可选的档位**由模型的 `reasoning` / `thinkingLevelMap` 推出（服务端按 pi 的 `getSupportedThinkingLevels` 规则重算），只有 `models.json` 不认识的模型才触发一次 live 读取。切换走新的 `POST /api/sessions/:id/thinking`，**不支持的档位由 pi 自己钳制**、响应返回的是真正生效的那一档；超出 pi 七档之外的值仍是 400。模型不能思考时（`levels` 只有 `["off"]`）滑轨整个不画。新会话页也有它：选了就随 `POST /api/sessions` 过去，服务端在 `set_model` **之后** `set_thinking_level`（顺序承重），没选就不传。

- **桌面版有了系统通知与红点**：会话在后台跑完时，桌面版会发一条系统通知，**点它会还原并聚焦窗口、直接打开那个会话**；Dock（macOS）、任务栏（Windows）与 Unity 启动器（Linux）上同时出现未读红点，数字是「已完成但还没打开」的会话个数，打开一个就减一。浏览器版此前已经有这套通知，桌面版走的是**主进程**：通知与红点归操作系统管，只有主进程碰得到，点击也必须由它转回来——所以 `desktop/src/preload.cts` 第一次开了三个函数（`notify` / `setBadge` / `onNotificationClick`），这是对「桥只传数据」那条旧约定的有意修改。红点的数字由 `appStore` 的一个订阅算出（`sessionActivity` 里 `done` 的条数），订阅按引用变化重算、`setNotificationBadge` 再去掉未变的数字。**Windows 没有数字徽标 API**，只能把一张位图交给 `BrowserWindow.setOverlayIcon`，数字点阵由 `desktop/src/badge-overlay.cts` 现画（`nativeImage.createFromBitmap` 直接吃裸 BGRA，超过 9 显示成「9+」）。设置页那一行从「浏览器通知」改名「通知」。顺手补了窗口生命周期的一处：关掉窗口后 `window` 变量原来一直指着那个已销毁的 `BrowserWindow`，于是点 Dock 图标不会重建窗口；现在统一走 `mainWindow()`。

- **输入框里可以打 `@` 引用文件了，候选来自 `git ls-files`**：会话的输入框和新会话页的输入框都支持——打 `@` 弹出一张卡片列出工作区里匹配的路径，↑↓ 选、Enter/Tab 确认、Esc 关掉，选中的路径变成一个 chip 落进句子（`@api.ts`，同名时向外长一段变成 `@lib/api.ts`），一次 Backspace 就能整块删掉。相邻字符也照中文标点断开（`看看，@api` 触发，`看看@api` 不会），邮箱（`a@b.com`）不会。**插进去的是路径本身，不是文件内容**：pi 的 RPC 模式没有 `@file` 语法，模型拿到的是一句话加一个路径，用自己已有的 read 工具去打开——行号、图片与 PDF 处理、截断策略都还是 pi 自己那套。索引只要路径，而 `git ls-files --cached --others --exclude-standard` 一句话就能给全（已被 `.gitignore` 过滤，实测本仓库首次 23ms、之后走 5 秒缓存 0ms）；不是 git 仓库的工作区回退到一次有上限的遍历（深度 8、两万条）。**手打的 `@api.ts` 不会被当成 chip**——只有补全写进去的才带那枚画图标用的 glyph 槽。顺带修掉两个老问题：`/` 菜单按 Esc 关掉后紧跟的 `keyup` 会把它重新打开；**发送后两张菜单不会自己关**（`submit()` 清空草稿是程序化写入，不触发 `input`）。另外**搜索失败与「没有匹配」是两件事**：请求挂掉时菜单报的是原因，而不是把它装成「没有匹配的文件」。

- **输入框里的上下文用量从一枚孤立的圆环变成了一枚 chip**：圆环照旧回答「离上限还有多远」（75% 转黄、90% 转红），旁边多出它代表的那个数字——`12%`——不用点开面板就能读，两者共用同一枚颜色，所以弧和读数不会各说各话。内边距、圆角、字号直接沿用左边那张模型档位 chip 的配方：两个控件描述的是同一个会话、紧挨着被一起读，配方不同就会读成两个来源。用量未知时（pi 刚压缩完、或磁盘上的会话没有可比的窗口）环只画轨道、读数写「未知」，点开仍是那份「已用 / 窗口 / 剩余」的面板。

### 修复

- **答案批次与提问对不上时不收**：`ask_user_question` 拿到的答案少一题、多一个未知 id、或同一 id 出现两次时，此前会照单全收并交给模型——而「少的那题」在模型眼里和「用户跳过了」长得一模一样，等于把沉默记录成一次决定（实验里一个空批次就让它停手不做了）。现在扩展直接让调用失败，错误消息点明缺了哪个 id；服务端在更早的位置用同一套规则拒绍（400，卡片保留可重试）；两边都不再静默降级。dsh 的宿主也拒绝同一种批次，理由相同。

- **扩展不再漏掉类型检查**：`extensions/*.ts` 不属于任何子包，此前不在任何 tsconfig 的 `include` 里——这一版给工具加 `intent` 时一个漏掉的闭括号把 `extensions/ask-user.ts` 变成了语法错误，而三个包的 typecheck 与全部测试都是绿的（单测碰不到它），只有真的用 pi 加载它才会炸。现在新增 `tsconfig.extensions.json` 并由根 `typecheck`（以及 `prepublishOnly`）一并跑。这也是把宿主包改成 `peerDependencies` 的附带好处：`pnpm install` 会把它们装到根 `node_modules`，扩展的类型解析才有地方可解——此前根目录连 `@earendil-works/pi-tui` 与 `typebox` 都找不到，想检查也检查不了。

- **宿主提供的包不再声明成 `dependencies`**：pi 在启动时会警告 `pi-web-simple/package.json` 把 `@earendil-works/pi-coding-agent` 放在 `dependencies` 里——扩展在宿主进程内运行，这份包由 pi 的模块映射提供，装一份物理副本会让编译后的 ESM 绕过那层映射、产生重复的类与注册表。现在五个宿主包（`pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-tui` / `typebox`）按 pi 的 `docs/packages.md` 声明为 `peerDependencies`（`"*"`）；仓库自己的开发工具（bench 直接跑 pi 的 RPC、桌面版打包脚本要找 pi 的 `cli.js`）仍有一份真依赖落在 `devDependencies`，所以 `pnpm install` 之后本地的解析路径没有变化，只是启动时不再有那条警告。

- **浅色主题下终端是黑底白字**：配色和字体是从设计令牌里现读的（xterm 画在 canvas 上，继承不了 CSS），而令牌表住在 `body` 上、这两处读的是 `documentElement`，读到空字符串后落回硬编码的兜底值：背景落空，`.xterm-viewport` 于是留下 `xterm.css` 写死的那片黑。现在两处改读 `body`，视口背景也在样式里跟着 `--dsw-alias-bg-base` 走——xterm 6 的库里已经没有任何地方往视口的 style 上写字了，这一条只能由外面来。

- **macOS 上一条通知都发不出来**：Electron 42 起 macOS 的通知换成 `UNNotification`，而它要应用有**真正的签名**才肯投递；`node_modules` 里那份 `Electron.app` 只有链接器签名（`flags=0x20002(adhoc,linker-signed)`），于是 `Notification#show()` 静默走 `failed` 分支——`notification.isSupported()` 照样返回 `true`，界面上看起来就是「什么都没发生」，排查时也没有任何线索。现在开发脚本（`desktop/scripts/sign-dev-electron.mjs`）会先给这份 Electron 做一次 ad-hoc 重签，打包时由 `electron-builder.config.mjs` 的 `afterPack` 对成品做同一件事（原先 `mac.identity: null` 名副其实地一个签名也没有，打包版同样收不到通知）。主进程同时把 `failed` 事件写进 stderr，这类失败不再无声。ad-hoc 的指纹随每次构建变化，所以升级安装包后 macOS 可能把通知授权当成一个新应用再问一次。

### 性能

- **切会话不再把整条转录一次性挂到 DOM 上**：长会话读回磁盘后，以前是一次同步提交把上千条消息全部挂上并让浏览器整列布局，实测 800 轮会话在点击后造成一次 **285ms** 的主线程阻塞（首帧要 377ms）；而读者本来就停在底部，屏外那些轮次占住这一帧是最不值得的。现在 `MessageList` 首屏只挂**尾部 24 个 flow 项**（`TAIL_INITIAL_ITEMS`），其余在 `startTransition` 里补齐——过渡渲染按 fiber 让出主线程，滚动/输入可以随时打断它；首屏小，`getBoundingClientRect` 触发的强制布局也就小。**往上滚到已挂载区顶部时立刻把剩下的全部挂上**（`TOP_BACKFILL_PX`），并在提交后按列高差补 `scrollTop`，不会把正在读历史的读者甩走；导轨跳到一个还没挂载的轮次时，先把窗口撑到它再滚过去（`pendingJumpTurnRef`）。实测 800 轮会话点击→首帧从 377ms 降到 159ms、首屏 longtask 从 285ms 降到 **0**；250 轮（接近真实中位）从 148ms/102ms 降到 129ms/0。数据与复现见 [bench/README.md 场景 D](./bench/README.md)。

- **`turnAtLine` 改成二分查找**：导轨要的「当前读到第几轮」原来是拿 `querySelectorAll` 从前往后逐个 `getBoundingClientRect`，在底部读长会话时等于把每一行都量一遍——切会话那一帧尤其贵，因为第一次读矩形会强制浏览器给整列新挂上的 DOM 做一次同步布局。现在行在文档里有序，用二分取「最后一个 top 不小于探针线的行」，矩形读取从 O(轮数) 降到 O(log 轮数)（800 轮：~1600 次 → ~11 次），而且每个滚动帧都省。

- **一次切会话只解析一次 JSONL**：打开会话要解析整个 JSONL（`SessionManager.open`），而一次切会话会同时发 `/messages` 与 `/composer` 两条请求，两边本来各自打开同一个文件——那次解析于是在服务端唯一的线程上跑了两遍（大文件各 40–130ms）。新增 `server/src/session-open.ts`：按「文件大小 + mtime（纳秒）」缓存刚解析好的 `SessionManager`，后一条读它的请求直接复用；缓存至多 2 份、1.5s 过期（一份 manager 大约等于它解析的文件大小，所以只为了共用一次切换，不当转录缓存）。磁盘路径只在会话无常驻进程时走，而任何写入都会 append/重写文件、即改动大小或 mtime，所以命中一定是同一份字节。实测带图会话（31MB payload）：`/composer` 37ms → **1ms**，重复切回同一会话时那一对请求 160ms → **95ms**（`/messages` 也不再重复解析，只剩序列化）；纯文本会话本来就只要几毫秒，基本不变。

- **工具结果里的图片不再随转录一起传**：会话把每张图都以 base64 存在 JSONL 里，一次切换却把整条会话的截图全塞进一个 `/messages` 响应（截图多的会话 15–31MB），浏览器要先 `JSON.parse` 完才能画出第一行，而读者只看其中一两张。新增 `server/src/session-images.ts`：转录把**工具结果**的图换成 URL（`/api/sessions/<id>/image/<序号>?v=<mtime>`），由浏览器按需取（`ImageThumb` 本来就带 `loading="lazy"`），端点按序号从文件重新取字节。**序号是「在转录里第几张图」**，两边都按 `buildSessionContext().messages` 的顺序数；URL 随文件 mtime 变，响应因此带 `immutable` 可长期缓存，旧版本号的请求直接 404 而不是把新文件同位置的图回给旧转录。**用户消息的图仍内联**：一轮失败可以重试，重试要把 prompt 自带的图重发给 pi，而 pi 要的是 base64。常驻会话也不重写（转录来自 pi 内存、可能含尚未落盘的轮次）。实测 200 轮 / 15MB 工具图：`/messages` **15.2MB → 0.2MB**、92ms → 1ms，切会话那一对 161ms → 44ms，首帧 280ms → **133ms**（场景 D）。

## [0.8.0] - 2026-10-09

### 新增

- **侧栏可以选分组方式和排序方式了（dsh 的视图选项菜单）**：分组头右侧新增一枚滑块按钮，点开是 dsh 那份带组标题的浮层 —— 「分组方式」（按工作区 / 按工作区树 / 单列表）+「排序方式」（手动排序 / 最近更新），当前项在行尾带勾。度量逐项照搬 dsh 的 `ViewOptionsMenu`（组标题 11px `label-tertiary`、每行 30px 的 `dense`、0.5px `border-l2` 分隔线；`sliders` / `workspaceTree` / `flatList` / `chevronsUpDown` / `check` 五枚 glyph 从 `ui-primitives` 抄来，其中 `sliders` 的两枚旋钮是整圆，所以 `Glyph` 多了一条圆的支持）；状态在 `sidebar-view.ts`，缓存在 `localStorage` 的 `pi-web-simple.sidebar-view.v1`。**默认值刻意与 dsh 不同**：分组默认「按工作区树」（dsh 默认平铺）—— 嵌套是菜单出现之前这个侧栏唯一的分组方式。选「单列表」时会把每个工作区的整份会话列表拉下来：那个视图没有工作区行，也就没有「展开其余 N 个会话」。

- **工作区和会话都能拖拽排序了**：插入标记是 dsh 的 `::before`/`::after` 原件 —— 两段 5×7 的 45° 渐变拼出一个左端小箭头，接一条从 x=4 开始的 2px 实线，颜色 `--dsw-alias-state-business-primary`；会话行 `right: 4px` / `top: -7px`，工作区行铺到右边缘、外扩到 `-8px`。工作区拖拽提交给服务端（`PUT /api/projects/order`，接口此前已有但没有入口），会话拖拽写进浏览器本地的顺序（每个工作区一个 account，单列表另有 `__flat_session_order__`，与 dsh 同名）。两侧都只允许同级移动（工作区不跨父级，会话不跨工作区），草稿行不可拖。拖拽状态住在整棵树上（`useSidebarDrag`），判定读 ref 而不是 state —— `dragover`/`drop` 可能早于 React 重画发起拖拽的那一行。侧栏原有的行菜单与新的视图选项菜单共用一个 `SidebarMenu`（portal 定位 + 点击外部 / Escape / 滚动关闭）。

- **可以让模型给新会话起名了，默认不开**：通用设置多了一行「自动命名」，从已配置的 provider 里挑一个（通常是最便宜的那个）模型，会话的第一条消息就顺手交给它起一个短标题，写进会话自己的 `session_info` —— 和手动改名落的是同一处。**默认关闭**，因为这一页里只有它花钱：每命名一个会话就是一次额外的模型请求。为此三道闸门都压得很低：一个会话只问一次（只在第一条用户消息上触发，之后再聊多久都不问）、只发首条消息的前 2000 字节（首条消息可以是一个粘进来的文件）、最多 32 个输出 token，请求本身有 10 秒上限。**用户改过的名字永远赢**：调用前查一次、写回前再查一次，所以模型思考期间手动改的名不会被迟到的答案盖掉；子会话（fork 出来的）不自动命名，它的上下文继承自父会话，一个新名字描述的是错的东西。失败一律静默 —— 少一个自动标题不是用户能做什么的事，确定性的那个标题本来就在屏幕上。只支持 `openai-completions` 与 `anthropic-messages` 两种线上协议（见[已知限制](./docs/known-limitations.md)），其它协议直接拒绝，而不是发一份按另一种 API 拼的请求。
- **右侧栏多了一张「本轮改动」：一轮的改动有自己的面板了**（那个卡片本来只把每一行当成单个文件的预览）。点卡片表头或某一行，打开的就是这一轮的改动：左边一个文件选择器（列表带每个文件的 `+N -M`）、右边「在右侧栏打开整个文件」，下面是带双行号的统一 diff。数据通路是新的：一轮的改动只存在于转录里、而转录在对话面板手上——由 `MessageList` 算完、`ConversationPane` 发布进 `turn-changes-store`（一个独立的小 store：`appStore` 被外壳整棵订阅，写它会让整页重渲染，而这份数据每结束一轮就要写一次），面板按 `sessionPath + turn` 读回来；等价重算不写（流式期间每次往返都会得到一份内容相同的新数组）。tab 的地址是 `<turn>#<index>`：turn 是身份，所以从表头与从某一行进同一轮落到的是同一个 tab，只是把它的选择移过去。
- **卡片不再直接开文件预览，项目外的文件也能点了**：表头与每一行都打开这张面板并定位到那个文件，项目外的路径也不例外——它的 patch 和别的文件一样在转录里，只有「打开整个文件」那枚按钮需要项目内相对路径（没有就不画）。
- **diff 行抽成了 `DiffHunk.tsx`**（变更面板与这张新面板共用）：两边现在不只是“长得像”，而是同一份解析（`diff-parse.ts`）、同一套行样式，不可能对同一段 patch 给出不同的行号或不同的增删数。为此 `ChangesFile.tsx` 里那个私有的 `Hunk` 组件被移了出去。
- **两处有意不跟 dsh**（都记在 `docs/known-limitations.md`）：没有左右对比视图（这个项目的变更面板也没有，不做第二个例外），也没有换行开关（变更面板的 patch 本来就随面板滚动、长行必须换行才读得全，一个永远开着的开关比不给更糟）。此外面板的数据只活在当前页面：刷新后右栏布局会回来，但要等会话重新载入并再次发布；没有数据时它直接说「这轮改动的内容已不可用」，而不是画一个空面板。
- **终端的 shell 可以在新建时挑了**：「+」菜单里「终端」那一项仍是登录 shell，它下面按主机自己的顺序（`/etc/shells`）列出其余的 shell，点哪个就用哪个开。**一个 shell 的主机什么都不会多出来**——Windows 只有 `ComSpec`，多数容器只有 `/bin/sh`，那时菜单和以前长得一模一样。不做二级菜单：第二层要靠 hover 才可用，触屏上就等于没有这个选择，而 shell 本来也就那么几个。
- **标签按实际启动的 shell 命名**（`zsh` / `bash` / `pwsh`），不再一律叫「终端」——一个标签条上得能分辨两个终端。取的是**真正跑起来的**那个程序：请求的 shell 若已不在本机列表里（在别的机器上存下的布局，或者那个包被卸载了），服务端会回退到登录 shell，标签就显示回退后的那个。为此服务端现在在 `TerminalInfo` 上报告实际启动的 shell（`pickShell` 之后的那个，而不是请求里写的），并在 `TerminalSupport` 上报告默认的那一个——「不选」到底意味着哪个程序，只有主机知道；把 `pickShell` 导出成可单测的纯函数也是为这个，/etc/shells 内容由机器决定，走 `create` 的测试只能断言「两种情况之一发生了」。
- 选择的 shell 存在标签上（`RightbarTab.shell`），刷新页面与「重新启动」都回到同一个 shell；**不选就是不写这个字段**，而不是写一个空串，免得同一个意思有两种写法（`readTab` 只认字符串，所以旧布局里的标签读回来就是「不选」）。已经开着的 shell 不会被换掉：换程序是重启一个进程，不是改一个属性，那条路就是「重新启动」。
- **右侧栏的预览会跟着文件一起变了**：打开的文件不再只在点「重新载入」时才更新。服务端的 `workspace_changed` 现在带着**变更路径**（工作区相对、`/` 分隔，去重后最多 200 条；超出上限、或 FSEvents 报出 null 文件名时给 `null`，意思是「有东西动了、但说不清是谁」），预览标签用这份路径判断这次编辑是不是自己那个文件（`preview-refresh.ts` 的纯函数，单测覆盖：目录变化算命中、`src/ap` 不算 `src/app.ts`、`null` 一律算命中、空列表不算）。命中就重读，**自动刷新默认开启**；关掉之后抬一条「文件已更新，当前显示为旧内容。」加一枚「重新载入」，正文保持旧的那一版而不是先变空白。两条规则值得单说：**读取进行中收到的改动留到这次读取结束再刷**——否则正在路上的回复会被顶掉，正文还可能混着两个版本；**重读失败不清空已有内容**——失败行压在旧版本上方，只有首次读取就没有内容可看时才是整页错误。开关与图标沿 dsh 的取法：按钮画的是**点击之后会变成什么**（跟着时是暂停符），靠 `aria-pressed` 与提示说明当前状态；**一处有意不跟**：dsh 0.2.1 把这枚按钮用 `<span hidden>` 藏起来了，这里把它放出来。开关本身是**每个标签页的内存态**，不进那份持久化布局，所以切走再回来恢复为开启。
- **「变更路径」是这个事件的新契约**，`BusEvent` / SSE / 前端的 `workspaceChanged` 三处一起改的：服务端在发布前把 `sep` 归一成 `/`，读取方因此不必知道事件是哪个平台发出来的。变更面板只读 `projectPath`，行为一字未变。
- 实测（真后端 + 生产构建 + 真 Chrome 的 CDP 探针，13 项断言全过）：外部写入后正文自行换成新版；事件里确实点名 `notes.md`；关掉开关后横幅出现、旧内容仍在且新版没有上屏；横幅上的「重新载入」把正文换成最新并收起横幅；刷新失败时错误行出现、旧内容不被清空。
- **目录选择器里可以把文件夹拖进来了**：把文件夹拖到弹窗上，地址栏立刻填上它的绝对路径并打开那一层。浏览器读不到这个路径（就是[目录选择器为什么要走服务端](./docs/design-notes.md)讲的那道墙），所以那里退到另一种读法：拖进来的文件夹名如果就在当前列表里，就进入同名那一项；两样都够不着（既没有壳、当前列表里也没有它）时给一句说明而不是静静地什么都不发生。桌面版为此在 preload 上多了一个 `getPathForFile`——`webUtils` 在这个进程里读一次路径、只回传一个字符串，页面仍然没有 `ipcRenderer`、也没有 Node，与那次「桥只有数据」的约定同一条线。拖拽期间弹窗盖一层柔光并写一句「松开即可填入这个文件夹的路径」，拖进来的普通文件不当作目录（否则它会以路径的形式递到服务端，在那里换回一句更难看懂的错误）。
- **目录选择器的地址栏现在把路径当草稿来读，照 dsh 的做法**：输入的**最后一段**前缀过滤「这段文字命名的那一层」——`/Users/dev/proj/sr` 只留 `src`、`scripts` 这类以 `sr` 开头的项——而目录部分变化时，列表在 250ms 静默后**跟着这段文字走**（输入 `/tmp/x/be` 时视图先落到 `/tmp/x`，再按 `be` 缩窄，全程不离开地址栏）。两条 dsh 的规矩照搬：**过滤只作用于草稿命名的那一层**（文本指向别处时旧的那层保持不动，否则一次按键会让视图动两次），以及**没有任何行匹配时不缩窄**（没人匹配的尾段是一个正在拼写的名字，不是要一个空列表）。`~`、相对路径与 `/tmp` 这类会被服务端 `realpath` 改写成另一个名字的文本也认得自己落到的那一层——靠的是把「刚发出的目录文本 + 它落到的路径」成对记住（正是这条让 `/tmp/pw-probe/` 能缩窄到它自己在 `/private/tmp` 下的那层）。规则抽在 `path-draft.ts`（13 个单测：尾分隔符、跨平台分隔符、无匹配不缩窄、`scanned` 配对），另有一遍真后端 + 真 Chrome 的 CDP 探针：层全列、尾段缩窄、无匹配不缩窄、跟随扫描、点行进入后不回退、Enter 提交后也不回退，无页面错误。
- **消息输入框能接住拖进来的文件夹了**（chip 的形状照 dsh 的引用块）：把文件夹拖到输入框上，光标处出现一个 `alpha/` 这样的引用——**只看得到目录名，发出去的却是完整路径**（chip 拼满输入框换不来可读性，agent 也不需要短名字）。路径相对当前工作区，工作区外保留绝对路径；同一目录拖两次复用同一个名字，遇到同名的第二个目录则往外多带一段（`pw-probe/alpha/`）直到不重名。**不带 `@`**：pi 在 RPC 模式下没有文件引用语法（`@file` 参数在那里被明确拒绝，TUI 的 `@` 补全只是编辑器行为），带个符号反而是一条 agent 需要猜的 token；`alpha/` 展开后的路径才是它拿现成工具就能打开的。会话输入框与新会话页两张卡一起改（它们本来就是同一个输入的两个位置）。
- **“显示短的、发送长的”靠一张 label → 路径的表**（`useReferenceDraft`）：表只在这一处、只认它自己造出的名字。手改过的 label 不再是那张表里的字符串，于是**不再解析，按用户看到的样子发出去**——发错方向的失败（把一条用户没写过的路径塞进消息）则不可能，因为 label 只为这个输入框真的收到过的路径而造。发送失败时回填的是原草稿，表也跟着留着，回到输入框的引用还是它原来指的那个目录。
- **编辑器仍是 textarea，chip 由一层镜像画出来，图标画在草稿自己的字符上**：斜杠菜单、输入法、选区、自适应高度、粘贴图片全部不动，只要把 textarea 的**文字设为透明**（`caret-color` 不受 `color` 影响，光标照旧），在它下面压一层同样排版的层，把路径片段画成 chip。**chip 只换颜色不换宽度**（宽度一变，光标就会落在字的旁边而不是字与字之间），所以 14px 的图标不能挤进文字流，只能盖在已有字符上：拖入的引用自带一个**图标槽**（一个 em 空格 + 一个空格），镜像层把图标盖在 em 空格上——图标左边缘因此正好落在普通文字的起点。**没有任何一步要求 em 空格恰好等于 14px**：镜像层排的是与 textarea 一模一样的字符，字体渲染多宽两层就都是多宽。手打的引用没有槽，于是有颜色、没图标（图标下面会是字母）；而**带槽的引用即使句子紧接着它继续写（`alpha/x`）也仍是 chip**，而手打的仍需要两边的空白（否则 `and/or` 会变成文件夹）。选区填充因此改成半透明，textarea 的滚动条也隐藏，随轮换同步 `scrollTop`。
- **chip 对光标是一个整体**（照 dsh 的原子节点）：光标在引用里、或贴着按键来的那一侧时，**一次 Backspace/Delete 删掉整段**（连图标槽一起），而不是一个字一个字地啃；普通文本不受影响（有选区时也照旧）。插入后**总跟一个空格**（dsh 的 `insertReference` 也是这条规则：原处就是空格则复用，不是则补一个），光标落在那之后——所以插完接着打字是与引用分开的一个词，不会粘成 `alpha/x`。
- **修掉 `droppedFolder` 的下标错位**（目录选择器的拖放也跟着修）：它返回的位置是 `items` 里的下标，而 shell 拿它去查 `files` —— 两者在掉落里掺进字符串项时（拖拽几乎总会带一段 URL 文本）就会错位，于是“路径拿不到”只在真实拖拽里出现、合成测试里却不出现。现在它自己数 kind 为 `file` 的项，返回 `files` 的下标。
- 浏览器拿不到文件夹的路径（与目录选择器同一道墙），所以网页版拖入文件夹时会抬一条「拖入文件夹需要桌面版」的提示，而不是静静无事发生。
- 实测（真后端 + 生产构建 + headless Chrome 的 CDP 探针）：拖入文件夹后输入框里是「em 空格 + 空格 + `alpha/`」（图标槽 + 短名，不再是 200px 的整条路径），同一个目录拖两次仍复用 `alpha/`；**图标左边缘与普通文字起点重合**（320 对 320），句中引用的图标落在它自己的槽上（348.3，不与前一个词重叠），手打的引用 `display: none`（槽下面会是字母）；把 `fetch` 在页面里截住后按发送，请求体里是 **`{"message":"/tmp/pw-picker-probe/alpha/"}`**——完整路径、**槽没了**；请求被拒后回填的是原草稿（槽还在，图标不会因为一次失败的发送消失）。两种卡片在含引用的换行、140 字的长单词、中文混排等文本上 **textarea 行数与镜像行数逐一相等**（即换行点一致）；拖入一张 PNG 仍然进附件条（目录分支没吃掉图片那条路）；零页面错误。另：拖入后文本是「em 空格 + 空格 + `alpha/` + 空格」且光标在最后；光标贴着引用末端按 Backspace、或从引用内部按 Delete，都是**一次删掉整段**（剩下那个尾空格），而空格后按 Backspace、以及普通文本，都不被接管（留给浏览器）。
- **标签能重命名了**：终端与预览这两种自带名字的标签，右键菜单里多一项「重命名」，写下的名字存在布局里，刷新、切会话都还在。文件和变更标签没有这一项——它们的名字来自文案表，写在标签上的东西永远不会被读出来，给一个看起来能用、实际不生效的菜单项比不给更糟。用 `window.prompt` 而不是把输入框画进标签里：侧栏改会话和工作区名字就是这么做的，键盘、读屏、输入法全由平台提供，一个应用里一种重命名手势好过三种各有一点不一样。取消和清空都按「不改」处理——存一个空名字会让 `tabTitle` 退回成「终端」，那看起来像被重置，而不是改得不好。

### 变更

- **应用图标换成了一张手写的 π 位图**：桌面版的打包图标、浏览器标签页的 favicon、侧栏的品牌格、新会话页的字标与运行状态行的 mark 从此是同一张图 —— `desktop/resources/icon-source.png` 与 `web/public/pi-mark.png` 是同一份素材。桌面端那条「按几何参数现画圆角蓝紫方块 + 三条白短棒」的生成脚本因此只剩解码、缩放与裁形（`desktop/scripts/render-icon.mjs`）：素材被缩进 macOS 图标的内容区（1024 画布里的 824×824），再按超椭圆裁出 squircle 与透明边（指数取 5），顺手挡掉非 PNG、非正方形、小于 512 的源素材；`desktop/resources/icon.svg` 随之删除。界面里三处原先各画各的 π 也改成引同一张图，只在深色主题下多一道 `border-l3` 的内发丝（黑底方块与深色页面的底色重合，没有它就只剩一个白 π 浮在行上）；favicon 也不再随主题反色。**开发模式也没落下**：`pnpm dev:desktop` 跑的是 `electron .`，Dock（以及 Windows/Linux 的任务栏）挂的原本是 Electron 的图标 —— 主进程现在把同一张 PNG 交给 `app.dock.setIcon` 与 `BrowserWindow` 的 `icon`（`desktop/src/main.cts` 的 `AppPaths.icon` 只在未打包时非空）。

- **移除对话区右上角的话题树**：那个按钮、它点开的 `TreeDialog`（含样式）、`GET /api/sessions/:id/tree` 路由、`readSessionTree`，以及只服务于它的 `SessionTreeView` / `SessionTreeNode` 类型与一整组 `tree.*` 文案都删了。那个面板本来就只能看：pi 没有任何 RPC 能把叶子指针移到别的节点，唯一的分支操作是 `fork`，而它只接受用户消息 —— 所以它能提供的唯一动作（在能分叉的节点上分叉）与消息操作行里的「分支」完全重复，而后者就在每一条用户消息下面，离要分叉的地方更近。**消息操作行的「分支」不受影响**。

- **左侧栏的搜索框改成 dsh 的：在分组头里就地展开，不再是独立一行**。收起时是「工作区」分组头右侧一枚 28px 放大镜（在标签与「添加工作区」之间），点它或整行展开成一个 30px 胶囊：`border-l4` 的 0.5px 发丝 + 12px 圆角 + 透明底（8px 的圆角只在收起时出现），同时「工作区」标签与尾部动作让位，输入框 13px/18px 淡入、放大镜缩到 11px、右侧多一枚 24px 的清除按钮 —— 取值逐个取自 dsh `ui-workspace/rows/WorkspaceBrowser.module.css`。交互也照它：点整行（不只图标）聚焦输入框；Escape 与清除按钮都是「清空 + 收起」；点别处一律失焦，只有查询为空时才真正收起。状态仍在本项目自己的 `searchOpen` / `sessionQuery` 上（后者还要驱动列表筛选与把分页的工作区拉全），所以 `toggleSearch` 拆成 `openSearch` / `closeSearch`，收起一定连查询一起清掉。

- **侧栏换成 dsh 的表面：底色从平涂改为两道光晕，macOS 桌面另开毛玻璃让侧栏透出去**。dsh 的侧栏列用一条自上而下的渐变压出「顶部一道蓝、三分之一处化没、底部三分之一再抬一点蓝灰紫」的柔光，这里逐值照抄浅深两套，**光晕在所有平台都保留**，但**填充的半透明只在 macOS 生效**——那正是 dsh 给 `vibrancy` 材质留的透光口。透明链共三节：`desktop/src/main.cts` 在 darwin 上开窗口的 `sidebar` 材质与透明背景；`web/src/theme/index.css` 把 `html`/`body` 的页面底色收掉；`AppLayout.module.css` 的列把不透明填充换成 dsh 那份 40%（浅）/ 50%（深）的着色，列分隔线跟着从半透明列挪到不透明的中间栏；系统「减少透明度」打开时退回 90% 不透明的同色填充。开关属性 `html[data-platform]` 由 web 侧从壳的 bridge 转印（`lib/desktop.ts` 的 `markDocumentPlatform`），纯浏览器没有它，侧栏照旧不透明。**macOS 桌面改用 `hiddenInset`，让侧栏的底色一直跑到窗口顶边**：保留系统红绿灯（按 dsh 的 `(16, 18)` 内缩），但把标题栏那条带子画成透明，窗口改由页面里打了 `data-window-drag` 的行来拖（侧栏顶部一条 52px 的条、品牌行、中间栏顶部），行里的控件再由一条全局 `no-drag` 规则自己退出拖拽。**Windows 与 Linux 不动**：仍然用平台自己的标题栏。设置页也没落下：左栏按 `--dsh-frame-top-clearance`（48px）整体下移，不再和红绿灯叠在一起。

- **侧栏的会话列表改成按页取：工作区不再每展开一次就把目录里的每个会话重读一遍**。派生一份列表的代价是整个工作区的历史——pi 要流式读完目录里每个 JSONL 才能数出消息条数、取出首条用户消息，而侧栏只画 5 行。三处一起改：**服务端分页**，`GET /api/projects/:id/sessions` 收 `limit` 与 `focus`，回来的是 `{ sessions, total }`（`limit` 只收窄这一页，`total` 仍是全部可见会话数）；`focus` 让正在读的那个会话即使排在第 6 位以后也随这一页一起回来。**服务端按会话目录缓存解析结果**（`sessions.ts`），缓存的凭据是目录里每个文件的**名字、大小与 mtime**；这道检查每次请求都做，而不是信任文件监听——漏掉一个事件就会让列表一直陈旧下去。**前端不再重复取**：`refreshSessions` 在没有 `force` 时，手里已经有这次视图要画的行就直接返回，所以把展开过的工作区收起再展开、或在两个工作区之间来回切，都是零请求；真会让列表变的路径（`sessions_changed`、SSE 重连、隐藏/删除、首次输出后的刷新）一律带 `force`。「展开其余」仍是 dsh 的页大小（5）递进，但带一个请求序号：连点两次时，迟到的旧页不会把新页盖回去。
- **MCP 一节改为直接读写 pi 自己的两份 `mcp.json`，不再依赖 `pi-mcp-adapter`**：pi 现在内置了 MCP 支持，配置就是用户级 `<agentDir>/mcp.json` 与工作区级 `<工作区>/.pi/mcp.json`，所以那一页不再有「需要先安装 pi-mcp-adapter」这一态，也不再提供一键安装——更因为装那个扩展会**替换掉** pi 内置的这套支持，于是「补一个缺失的依赖」实际变成了「换一个配置来源」。读侧的合并规则照抄 pi 自己的 loader：工作区条目整条替换同名的用户级条目，只带 `enabled` / `exposure` / `toolExposure` 的工作区条目算覆盖（其余字段、凭据在内仍来自用户层），只在 `-` 与 `_` 上不同的两个名字共享工具命名空间而后者被拒，格式是严格 JSON——一个文件读不了或某条非法只把那条记下来列在列表下面。写侧保留文件其余内容（顶层字段与表单没展示的 `exposure` / `timeout` / `oauth` 都不动），保存/删除/启停走同一条原子写回。随之删掉的是跨工具来源与导入（六种兼容导入、冲突与来源视图、「从其他 Agent 导入」对话框）、`POST /api/mcp/install` 与 `POST /api/mcp/imports`、`pi-mcp-adapter` 的加载与缓存层、以及对应的 i18n 文案。传输收敛到 pi 支持的两种（stdio 与 streamable HTTP），编辑器里不再有 sse。`mcp.test.ts` 现在写真实的 `mcp.json`，并新增了覆盖语义、命名冲突、非法条目与坏 JSON 的用例。

- **会话重命名改写 pi 自己的文件，不再是 Web 侧的一个覆盖项**：改名的落点从 `store.json` 的 `sessionOverrides[path].name` 换成 pi 会话文件里的 `session_info` 条目——pi 读**最后一条**，所以改名变成对日志的追加，而不是更新一张侧表。这是「重命名不写 pi 的文件」那条老规矩的撤销：在 `store.json` 里存一个名字，等于给「这个会话叫什么」第二个答案，而 `session_info` 本来就是 pi 存放显示名的地方（`/name` 写的也是它）。写入按有没有驻留进程分两条路（新模块 `server/src/session-title.ts`）：有进程时走 RPC（`set_session_name`，与流式写入在同一进程里串行，不会互相踩 leaf 指针），没有时用 `SessionManager.open(path).appendSessionInfo(name)` 直接追加（不必为了改个名字冷启动一个 1.5–3.2 秒的进程）。**空名清除名字**（pi 把空 `session_info` 读作「没有名字」）；会话文件不在时路由返回 404，而不是凭空建一个文件再把名字丢掉。服务端的 `deriveTitle` 随之只剩两级——pi 的名字、然后首条用户消息——`TitleSource` 里的 `override` 一并删掉。`SessionOverride.name` 保留为**只读**，只为迁移而留：启动时（`title-migration.ts`，在文件监听之前）一次性把旧名字写进各自的会话文件再删掉这份拷贝——幂等，失败不阻断启动，文件不在盘上就跳过。pi 里**已经有名字**的会话由 pi 的名字胜出。`PI_WEB_SIMPLE_SKIP_TITLE_MIGRATION=1` 是逃生口。两处已知副作用：`session_info` 是 pi 的一条 entry，会出现在 `/tree` 里（`forkPointsFrom` 只认 user message，fork 目标不受影响）；追加会改文件 mtime，所以改名会把该会话顶到侧栏最前。
- **标题的清理与截断按字节算，不再是一个 80 字符的 `slice`**：会话名和首条消息都是自由文本，而此前那个 `clip()` 只按 `.length` 切、也不剥转义——一个贴了 SGR 颜色码的名字会把 `[31m` 当成标题的一部分，一个 emoji 落在第 80 位上会被切成孤立代理对。现在标题规则单独一个纯函数模块（`server/src/title-text.ts`，22 个单测）：剥 OSC / CSI / 其余 ESC 转义、C0/C1 控制符，以及**方向性与不可见字符**（`‪-‮` 这些能让一个标题显示成另一句话的玩意儿），折叠空白，然后按 **UTF-8 字节**截断且不切码点，被切时补一个 `…`。预算从 80 字符换成 **120 字节**（`PI_WEB_SIMPLE_TITLE_BYTES`）：对一个中文标题约 40 字、对一个英文标题 120 字符。由首条消息派生的标题还多一道**词数**上限（8 词，`PI_WEB_SIMPLE_TITLE_WORDS`），照 dsh 的 `fallbackSessionTitle` 两道上限并存：只有词数管不住中文（没有空格可数），只有字节会把一个英文句子在词中间切开。`preview` 仍是 200 **字符**，但同样过了清理，而且按码点切。技能的展开折叠照旧在清理**之前**做。
- **轮次末尾的改动文件卡片对齐 dsh：有行数了，也有悬停对比**。此前行尾是 `编辑 ×3` 这样的调用次数，理由是「转录里没有权威依据」；依据其实一直在工具结果里——`edit` 的 `toolResult.details.patch` 就是 pi 生成的标准 unified diff，`parseUnifiedDiff` 解析它得到的 `additions`/`deletions` 与右侧栏变更面板上的数字出自同一个解析器，所以行尾的数字与悬停画出来的每一行永远一致。`write` 没有 patch（pi 只回一句 `Successfully wrote N bytes`），那一侧是由 `content` 合成的**一整段新增**：覆盖已有文件时只能记 `+N -0`，因为转录从来没读过被覆盖的内容；`content` 缺失（参数被输出上限截断）或超过 200 KB 时照 dsh 的 `oversized` 显示「过大」，不猜。为此 `turnFiles` 多收一份工具结果表（`MessageList` 里已经有那个 map），它此前只停在 `assistant` 消息上，拿不到结果。
- **同一个卡片的版式照 `ChangedFiles.module.css`**：单文件只画 header（标题就是文件名，再列一行是同义的重复），多文件才带列表，折叠阈值 3 → **4** 行；表头与行尾都是 `+N -M`（千分位用 dsh 的 `Intl.NumberFormat('en-US')`），整轮的总数在表头、单文件的那一行在自己行尾。**悬停 500 ms 出对比预览**（dsh `HoverCard` 的 `openDelayMs`），画的是这次调用自己的 patch：同一文件改了三处就是三段 patch，dsh 那边是快照对比出来的一份**合并 diff**——合成的代价是先后两处改动不会互相化简，那需要一份两侧文件都没有的中间态。浮层挂在卡片**外面**（多包一层 `position: relative` 的壳）：卡片自己的 `overflow: hidden` 是为了裁圆角，浮层放进去会被一起裁掉；默认向上弹，卡片上方不足 372px 时改向下（`data-place`），dsh 的 HoverCard 量完空间再选边，这里用一个数字做同一个决定，因为能逃出去的方向只有转录那一个竖向滚动容器。
- **投影里不再有 `tools` / `calls` 两个字段**（连带 `turnFiles` 不再需要那个只为取工具标签的 `Translate` 参数）——没人读的东西不留，和「服务端那个没人读的终端标题」是同一条规矩。`bash` 改的文件依旧不在卡里：一条 `echo x > a.ts` 没有任何可以归属的路径，要覆盖它得在轮次边界做真快照，那是另一件事（见 [已知限制](./docs/known-limitations.md)）。
- **通用设置「关于」里去掉了「插件更新」一行**：插件页本来就是逐行做安装与更新的地方，「关于」里的那一行只把数字指过去，多一次跳转而已。随之删掉 `UpdateSection` 的 `onOpenPlugins`、设置页里那个只服务它的 `setSection("plugins")` 回调，以及三条只服务于它的 i18n 文案。`extensionUpdateCount` / `extensionUpdateStatus` 仍留在 `updates.ts` —— 插件页自己还要用。
- **任务清单改由本包自带的扩展提供，形状对齐 dsh**：`todo` 工具此前来自 `@juicesharp/rpiv-todo`——一份要另装的增量工具（`create` / `update` / `delete` 等六种动作、四态状态、`blockedBy` 依赖、`activeForm` 标签）。现在 `extensions/todo.ts` 自己注册它，语义照 dsh 的 `todo_write`：每次调用带回**整份**列表并替换旧的，一条任务是 `content` 加 `pending` / `in_progress` / `completed`，没有 id、没有墓碑、没有依赖字段——整表替换不需要身份。面板与转录行的取值因此从 `details.tasks` 换成 `details.todos`（旧载荷仍读得懂，老会话照样显示自己的清单，只是不再渲染 id 与依赖）。**同时删掉整条「装扩展」的路**：`server/src/todo.ts`、`GET /api/todo`、`POST /api/todo/install`、`store.json` 的 `todoNoticeDismissed`、面板与插件页的安装提示、对应 i18n 文案——一个不会缺席的依赖不需要一条检测它是否缺席的路径。工具名仍是 `todo`（不是 dsh 的 `todo_write`），因为面板与转录行按这个名字分派。
- **plan 不再是会话级的，它随轮次清空**：dsh 的投影在 `turn/start` 清空、`turn/end` 保留，于是面板永远只描述它所属的那一轮；这里也一样，只是清空不是一个动作而是一条边界——`projectTodos` 只看最后一个 pi 已经接手的用户消息之后的那一段（排队中、还没被拿起来的提示不算开新轮，与 `groupTurns` 同一规则，否则一条还没处理的消息会提前擦掉正在进行的计划），所以 `/reload`、分支、compaction 之后算出来的都是同一个答案。转录里每次调用的展开体不受影响：那是历史记录。
- **`pi.extensions` 从一个目录改成两条显式 glob**（`./extensions/*.js` + `./extensions/*.ts`）：manifest 里写目录时 pi 只加载了 `index.js`，同目录的 `todo.ts` 不会被发现（实测 `pi -e <目录>` 也一样），显式的两条 glob 才会把两个入口都算进来。
- **服务端不再有一个没人读的终端标题**：`TerminalInfo.title`、`TerminalRecord.title`、`TerminalManager.rename` 与 `POST /api/terminal/:id/rename` 一起删掉了。它们从来没有消费者——标签名一直存在右侧栏的布局里（`RightbarTab.title`，`tabTitle` 读的就是它），而服务端那个字段只在内存里，刷新和重启都活不过去，连 SSE 事件都不带它。留着它等于给「标签叫什么」第二个答案，而这次要接重命名，得先定下这个答案只有一个。（实测：那个路由现在 404，终端信息里只剩 `id / sessionPath / cols / rows / shell / exitCode`。）
- **左侧栏按 dsh 的规范重排**：列几何照 `ui-sidebar/SidebarRoot.module.css`（`6px 12px` 内边距、60px 品牌行、36px 分组头、42px 设置项），行几何照 `ui-workspace/rows/Rows.module.css`（工作区行 34px、会话行 32px、标题 14px/20px、时间戳 10px/16px、12px 圆角、悬停与选中同用 `--dsw-alias-interactive-bg-hover`）。列宽 268 → **280**（dsh 的 `SIDEBAR_DEFAULT`）；列分隔线 `border-l2` → **l3**；品牌名 14px → **18px**；头部图标按钮 24px → **28px**；“新会话”的圆角从刻意偏离的 14px 回到 dsh 的 **12px**；`--dsw-radius-*` 四档 token 补进设计 token 表（此前未移植）。滚动条照 dsh 贴到列自己的右边缘：负外边距抵消列内边距，行落点用 `edge − 滚动条 − 2` 算回原位，公式读的是本项目自己的 `--dsh-scrollbar-width`（这里全局 8px，dsh 是 5px —— 要跟的是行的落点，不是条本身的粗细）。
- **缩进改用行内 `padding-inline-start` 而不是外边距，会话行不再比工作区行多缩 26px**：被外边距推开的是整行连背景一起，而 dsh 的悬停/选中填充要铺满整列；两个层级在 dsh 里共用同一个 `--dsh-workspace-indent`（每层 12px）。工作区行之间恢复 dsh 的 4px 组间距（组内 2px）。「展开其余 N 个会话」照 dsh 的 `.sessionOverflowButton`：28px 行高、8px 圆角、**悬停不变底色**只提亮文字。顺带补上 `.projectRowCurrent` —— 它一直被 `ProjectTree.tsx` 引用却从没在样式表里定义过，当前工作区因此一直没有行底色。
- 两处刻意不跟 dsh，代码里各自注明：品牌是字母标记而不是 dsh 的字标美术件；搜索是独立的行，dsh 是在分组头里就地展开一个。（行的操作按钮一度是第三处——绝对定位的一簇，现已回到 dsh 的 flex 行，见「修复」。）
- **侧边栏的图标换成 dsh 当前那一版**（`ui-primitives/src/icons/index.tsx` 的 artwork）。此前这一栏的 chrome 图标大多取的是另一套 —— Figma 导出的填充版，或 `icons.tsx` 里自绘的描边 —— 而 dsh 现在把侧边栏画成描边的：新会话是气泡加号（`IconNewChatOutlineRegular`，18px）、搜索是描边放大镜（`IconSearchOutlineRegular`）、重命名是方框加笔（`IconEditOutlineRegular`）、删除是描边垃圾桶（`IconTrashOutlineRegular`）、设置是描边齿轮（`IconSettingsOutlineRegular`）。工作区的文件夹、展开三角、溢出的省略号也按当前 artwork 换过（`folderOpen` 的 duotone 内填由 20% 改成 dsh 的 16%，`caretRight` 的 viewBox 从 14 改回 16）。为此 `Glyph` 多了一条**逐 path 的 `stroke` 开关**：dsh 有两枚是半填充半描边的（`projectAdd` 的加号、`rename` 的笔），只有一个 glyph 级的开关没法同时画出这两半。
- 顺带删掉 `icons.tsx` 里已经没人用的 `SearchIcon` / `PencilIcon` / `TrashIcon`；`PlusIcon` 仍被右侧栏用着所以留着，`EyeOffIcon` 也留着 —— dsh 没有「隐藏会话」这个概念，它用归档，这边不假装是同一个动作。
- **新会话页的工作区 chip 照 dsh 的 `HeroShell` 重画**：度量逐项对齐它那张 `.workspace`——图标、标签、箭头之间 **4px**（原 6px），`max-width: min(100%, 360px)` 配 **28px** 最小高度与 `0 8px` 内边距，圆角改读 `--dsw-radius-sm`，**13px/20px、字重 500**、墨色 `--dsw-alias-label-primary`（原来是硬编码的 `#000` 且不带字重行高）；标签补上 `overflow: hidden` + `text-overflow: ellipsis`，长工作区名缩到看不见时文件夹与箭头仍贴住剩下的字。**底色只在悬停与展开时出现**，跟着 dsh 把 `[aria-expanded="true"]` 也算进来——菜单开着而指针移开时，chip 不能变回没有状态的样子。图标换成 dsh 原件而不是复用 `FolderIcon`：后者是 `icons.tsx` 自绘的 1.4px 描边，摆在 13px 的标签旁边偏重；未选工作区时用 `IconFolderCloseRegular`（1px 描边），选中后换成 `IconFolderOpenRegular`（fill-only），箭头是 `IconChevronDownOutlineRegular` 的 12px 版。
- **hero 的纵向节奏回到 dsh 的 12px**：标题、工作区行、输入卡三段的间距从 18px 改成 dsh `HeroShell` 的 12px（figma 75:8208 在这一段写的就是 12），工作区行再留 dsh `.workspaceRow` 的 8px 左内缩，让 chip 里的文件夹落在输入卡自己的内边距上方而不是列的最左缘。
- hover 会话行时**隐藏时间戳**再显示操作按钮（dsh 就是隐藏时间戳）。这是 dsh 尾格二选一的前半段：时间戳让出的正是后半段──按钮入场、标题收缩──要用的空间（见「修复」）。
- **终端不再提供 shell 选择，一律开 bash**：上一版做的「+ 菜单里列其余 shell」连同它依赖的整条链路一起撤了——`TerminalSupport.shells` / `default`、`CreateTerminalInput.shell`、`POST /api/terminal` 的 `shell` 字段、`RightbarTab.shell`、`attachShell` 的 shell 参数、`api.openTerminal` 的字段、`shellChoices` 与两条 i18n 文案。**默认从登录 shell 改成 bash**：`pickShell` 现在优先 `/bin/bash`（这台主机没有才退回 `$SHELL`，再没有就取 `/etc/shells` 第一个；Windows 落在 `ComSpec`）。理由是「跟着谁装的走」对一个用来看 agent 干了什么的终端没什么价值，而每台机器一致有。`TerminalInfo.shell` 留着——标签名还是按真正跑起来的程序取（现在几乎总是 `bash`）。实测：本机 `$SHELL=/bin/zsh`、请求体不带 `shell`，回来的是 `info.shell=/bin/bash`，PTY 里 `echo $0` 也是 `/bin/bash`。
- **左侧栏的会话行按 dsh 最新那版对齐，三处此前读串了的地方**：① **文字颜色**回到 dsh 的 `label-primary`（此前用的是 `label-secondary`——上游只把归档行压到 `label-caption`，本项目没有归档，每一行都该是亮的）；② **左侧状态槽改成每行恒占的 16×20 格**（dsh 的 `.slot`），只有槽里的标记有无之分——此前空闲会话整格不渲染，标题因此比有状态的行左移 20px，列表会随着状态出现/消失整体晃一下；③ **选中项去掉加粗与时间戳升色**，只留 dsh `.selected` 那一层底色（代码里「dsh bolds the open conversation」这句注释是误读，它的 `Rows.module.css` 里 `.sessionRow.selected` 只有 `background`）。行高 32px、标题 14px/20px、时间戳 10px/16px、`gap: 0` 与标题 `margin: 0 6px 0 4px` 本来就已经是 dsh 的值，这次没动。

### 修复

- **在搜索框里打字会把整页卸掉（React #300）**：`ProjectTreeItem` 里「当前查询下没有匹配就把这个工作区整块折起来」的那条 `return null` 写在了 `useState` / `useRef` / `useCallback` **之上** —— 一旦某个工作区无匹配，这一次渲染就比上一次少调三个 hook，React 直接按崩溃处理（`Rendered fewer hooks than expected`），整棵组件树被卸掉。早退现在挪到所有 hook 之后；只有查询真的过滤掉一个工作区时才会走到，所以此前只在输入框里敲下第一个字的那一刻暴露。单测补了筛选与折叠两条。

- **会话项终于和 dsh 一样高了——根因是滚动容器被写成了 flex 列**：`.scroll` 之前是 `display: flex; flex-direction: column`，而 dsh 的 `.list` 是普通 block 滚动容器。flex 列里的子项默认 `flex-shrink: 1`，会话一多、内容超过可见高度时，浏览器优先**压缩每一行**而不是让列表溢出滚动 —— 固定 `height: 32px` 的会话行于是被压到 32px 以下（会话越多越扁），而且因为刚好被压进容器，连滚动条都不出现。这正是「pi 的会话项看着比 dsh 矮」「上下内间距不同」的原因：行被压扁了，文字上下那 6px 的居中留白跟着变小。改成 block 滚动容器后（与 dsh 的 `.list` 一致），32px 行高不再被 flex 重算；“展开其余 N 个会话”按钮从依赖 flex stretch 变成需要显式宽度，补上了 dsh `.sessionOverflowButton` 本来就有的 `width: 100%`。同样的两处垂直节奏差异也一并跟了 master：组间距从 2px 改回 **4px**（原来写了两条 `margin-top: 2px`，以为会相加，实际只互相覆盖）。

- **输入框右侧留白与左侧对齐，运行中输入不再抽**：textarea 的右内边距从 8px 提到 14px —— dsh 的 8px 是因为它的滚动容器另加了 4px margin，这里没有那层，换行后的文字于是贴着卡片边；现在两侧都是 14px。另外自适应高度的测量从 `useEffect` 挪到 `useLayoutEffect`：`height: auto` 会让输入框先塌回一行再量，写在 paint 之后就会闪出这一行，并且让滚动区连续两次 resize、把转录上下弹一下（跟随滚动会贴两次底）—— 放进 layout 阶段后浏览器只看见最终高度，`ResizeObserver` 也只收到一次通知。

- **输入框左下角的「引导 / 追问」开关撤掉了**：这条规则现在只有一个来源 —— 设置里的「繁忙时的发送行为」。此前它是**本次会话内的临时覆盖**，于是同一个问题有两个答案：设置改了、输入框里还记着上一次点过的那个，而那个开关本身又不落盘、刷新就没。**Cmd/Ctrl+Enter 仍然永远走另一种投递**，所以不常用的那一种不需要为了够得着而占一个位置。随之删掉 `Composer` 的 `busyMode` state 与采纳偏好变更的那个 effect（偏好现在是 render 时直读的 prop）、`.modes` / `.mode` / `.modeActive` 三条样式，以及 `composer.sendMode` / `composer.steer` / `composer.followUp` / `composer.steerTitle` / `composer.followUpTitle` 五条文案。

- **输入框那枚蓝色圆钮里的图标换成 dsh 的原件**：发送与停止此前画的是 `icons.tsx` 自绘的描边图形（一枚纸飞机、一个 8×8 描边方块），1.4px 的线落在同色蓝底上几乎看不见。现在两个 glyph 逐字节取自 dsh `InputBar.tsx` 里那两段内联 `<svg>` —— 发送是几乎撑满 16px 盒的**实心**箭头，停止是 10×10、圆角 3 的实心方块 —— 底色、白字、34px 圆钮、悬停与禁用态一个没动，这一对本来就是 dsh 同一枚 `.primary` 的两个状态。注意**不是** `ui-primitives` 里同名的 `IconSendOutline` / `IconStopFill`：前者是描边的另一枚，后者是 11×11、圆角 1 的另一个方块，都不是输入框在用的那两枚。

- **运行中的状态行补上 dsh 的分割线，折叠标题补上高光**：底部「正在努力...」上方现在有一条 0.5px 的细线（dsh `RunningStatus` 的 `runningDivider`，样式取自 `ChatView.module.css`），把已完成的内容和还在计时的状态分开，行首放上 pi 自己的 π 标记（dsh 那个位置是鲸鱼尾巴）；`StepProcessGroup` 的进行中标题（如「正在分析请求」）也照 dsh 的 `TextShimmer` 加了高光扫过 —— 折叠起来的那一小段没有别的动效，这道光就是「还在工作」的信号。两处都走「渐变在裁切文字后面移动」这条 dsh 自己的手法（透明填充 + `background-clip: text` + 滑 `background-position`），不占布局。
- **运行中的两处文案各归其位**：转录里的折叠标题（`StepProcessGroup`）回到 dsh 的进行时活动词——「正在读取文件」「正在运行命令」等，而不是一个固定的「正在努力...」；并且轮次里**未被回复或轮次结束切开**的最后一段（dsh 的「未闭合」）一律算进行中，即使此刻既没有流式文本、也没有正在执行的工具（模型正在准备下一段），标题仍是活动词而不是「执行了命令」。底部那条状态行（`TurnStatus`）才用「正在努力...」（新键 `turn.working`，取代了「正在执行中...」的 `turn.executing`）。

- **「对话显示」对齐 dsh 最新的四档，默认「标准」**：dsh 的 `transcriptView` 有 `compact` / `standard` / `detailed` / `verbose` 四档（中文为「简洁 / 标准 / 详细 / 完全展开」），此前这里只有「标准 / 紧凑」两项——而「标准」是**把每一行都平铺**的第二种形态，dsh 里并不存在（它的 `foldCompletedTurns` 除 `verbose` 外所有模式都为真）。现在设置里是同样的四项，行为由 dsh `ChatPresentationPolicy` 的三个字段决定（移进 `transcript-policy.ts`）：`foldCompletedTurns`（`verbose` 之外都为真）、`stepGrouping`（`compact`/`standard` 为 `collapsed`，`detailed` 为 `history`，`verbose` 为 `none`）与 `settledReasoningPreview`（只有 `compact` 为假）。**按步分组那一层也一并移植了**：一轮内被回答隔开的每段思考与工具调用收成一个可折叠的小分组，标题是活动摘要（`已读取文件并搜索代码`，进行中为 `正在读取文件`），落在新的 `StepProcessGroup` 上，分类与标题逻辑移自 dsh 的 `process-activity` 与 `processTitle`。于是 `standard` 折每一段（**包括正在流式的那一段**）、`detailed` 只折已关闭轮次的段（流式中的段平铺）、`verbose` 完全不折，这也正是 `standard` 与 `detailed` 的可见差别。**默认值跟 dsh 桌面端一样是 `standard`**；两档时代存下的 `normal` 迁移为 `standard`，`expanded` 迁移为 `detailed`，所以存量 `store.json` 里的 `normal` 现在也会折叠。

- **会话行悬停时标题与操作图标叠在一起，图标按钮还顶着一块多余的灰底**。两处都回到 dsh 现在的 `Rows.module.css`：操作按钮不再是绝对定位在行右侧的一簇，而是行里 `flex: none` 的一员——早先那版不占位，`flex: 1` 的标题仍按整行宽度排版，长标题一直排到图标底下，两者叠着；现在悬停时按钮入场、时间戳退场，标题被挤到按钮左侧，从不重叠。整行点击目标（`.sessionTitle::after`）不受影响：它是定位元素，按钮簇只需自己 `position: relative` 就排在它之上、保留自己的点击，不必再靠 `pointer-events` 那一套。按钮的悬停态也照 dsh 的行内规则：默认 `label-tertiary`，悬停只升到 `label-primary`，**不铺底色**——灰色方块是头部 28px 控件的语言（`SidebarRoot.module.css` 的 `.iconButton`），而行内按钮所在的行本身在指针下已经有底色了。另外照 dsh 补上了「菜单打开时钉住这一行」：工作区行的菜单是 portal 到 `document.body` 的，指针一旦移到菜单上，行就不再 `:hover`；这里随 `menuAt` 给行加同一枚类。

- **桌面打包里那句「没产物就早点炸」说的是一个不存在的参数**：`actions/download-artifact` 没有 `upload-artifact` 那个 `if-no-files-found`，传了会被静默丢弃，只在日志里留一条 `Unexpected input(s) 'if-no-files-found'`——于是防护从头到尾是空转的，真遇到空产物时仍会走到 `gh release upload "$tag" artifacts/*`，把没能展开的 glob 原样交给 gh，报一句跟根因无关的错。现在换成一个显式步骤：数一遍 `artifacts/*`，为 0 就带一句人话退出。0.6.3 那条记录写的是这个意图，参数名是错的，此行才是它真的落地。

## [0.7.0] - 2026-10-08

### 新增

- **思考行与操作行都能折起来看了，形态对齐 dsh 最新那一版**：轮次那层换成 dsh 的 `TurnProcessNodeView`——整行 33px 的控件加一条 0.5px 分隔线，文案是完成汇报 `已完成，用时 2分33秒`（只有数字走代码字体），点开才露出该轮的思考行与工具行，chevron 在展开时翻向上方（100ms）。行那一层：收起是工具图标、悬停交叉淡入向下 chevron，展开时同一枚 chevron 旋转 180°——**没有照抄 dsh 的「换一枚向上图标」**，因为新挂载的节点没有上一帧可以过渡，那样折叠会硬切；行同时开始自己持有颜色（`tertiary`，悬停升 `secondary`），标题/图标/chevron 全部继承，之前标题写死 `secondary` 导致悬停反馈只到得了图标。收起状态的思考行摘要跟着显示模式走（dsh 的 `settledReasoningPreview`）：流式中无条件显示，「紧凑」下只留一行 `思考`。
- 折叠组与紧随其后的答案之间回到 16px，与 dsh 现在的一致（原先是照搬旧版 dsh 的 8px）。
- **右侧栏多了终端标签页**：「+」菜单里选「终端」就开一个真 PTY（xterm.js + `node-pty`），标签页就是你正在看的那个 shell。它**记得住自己挂在哪个 shell 上**：折叠侧栏、切会话、刷新页面都只是断开，重新打开或刷新后会读回那段屏幕内容接着看（`GET /api/terminal/:id`），不会在旁边再开一个。**关掉标签页才杀进程**——标签页就是那个 shell；其余任何「卸载」都不杀，所以后台跑着的构建不会被收起侧栏掐断。已退出的 shell 还留着屏幕和退出码，旁边给一个「重新启动」（它会先把旧的那个真的关掉，否则已退出的 shell 仍占着上限名额）。
- **终端是全仓第一个按需加载的东西**。xterm 那一份 338 kB（gzip 86 kB），而它只服务这一种标签页，所以它自己成了 `TerminalTab` 那一块，主包回到 1087 kB、这一批加完分屏与浮动面板后是 1119 kB；标签条、关闭、重连、置灰判断都留在主包里，边框只在真的挂上一个终端标签页时才把那一块取回来。
- 服务端新增 `terminal.ts`：可选的 `node-pty` 加载与 `spawn-helper` 可执行位修复（缺了那个位只会得到一句误导人的 `posix_spawnp failed`）、PTY 进程表、按 16ms 合并上报字节、128 KB 滚动缓冲、退出码，以及 8 个 shell 的上限。**输出不经过 React**：`terminal_output` 帧由 `terminal-state.ts` 直接分发给订阅了那个 id 的 xterm，`yes` 打满屏也只是 `term.write`，一次渲染都不触发。`node-pty` 声明在 `optionalDependencies` 里，装不上时「终端」那一项置灰、悬停写明原因，其余功能一概不受影响。
- **右侧栏有了快捷键，绑定直接取自 dsh**：`⌥⌘B` 收起/展开右栏 · `⌥⌘↵` 面板全屏 · `⌘P` 打开文件 · `` ⌃` `` 新开终端 · `⌘T` 新开浏览器标签页。这张表不是自己编的，而是从 dsh 里**拥有**各条命令的那个包照抄下来的（`ui-sidebar-right` / `ui-sidebar-files` / `ui-sidebar-browser` / `ui-sidebar-terminal`），好让两个应用之间的肌肉记忆可以通用。**按键提示与监听器读同一张表**：按钮 `title` 里那个「收起右栏（⌥⌘B）」是拿命令自己的绑定现算的，所以不存在「提示写着某个键、按下去没动静」。
- **浏览器里几条默认键挪到了 `⌥` 上**，因为光秃秃的那几个归浏览器：`⌘P`（打印）、`⌘T`（新标签页）、`⌘⇧B`（显示/隐藏书签栏）。桌面版是 Electron 壳，没有这些抢占者，所以那一列就是 dsh 桌面版的原始绑定。`` ⌃` `` 是例外——两个运行时都是它，dsh 也刻意没设成 `primary`。
- 新增 `web/src/lib/shortcuts/`：`binding.ts`（物理键协议：规范化 / 比较 / 键帽串）、`environment.ts`（桌面与浏览器、macOS 与 Windows/Linux 的判定）、`dispatch.ts`（纯派发：命中哪条命令、要不要让路）、`use-shortcuts.ts`（全应用唯一的 `keydown` 监听与 DOM→手势适配）。命令表由**动手的那个功能**注册（`features/rightbar/shortcuts.ts`），外壳只装监听——否则「打开右栏」这条命令的属主就正是它要打开的那个东西。
- **三处 Enter 提交学会了对 `Alt` 让路**：`Composer`、变更面板的提交框、扩展问答卡片原本只看 `event.key === "Enter"`，而 `⌥⌘↵` 正好是面板全屏，按下去会**同时**发消息和切全屏。现在三处都在 `Enter` 分支上拒收 `Alt`，并且**不 `preventDefault`**，把事件留给快捷键层——dsh 的 Composer keymap 在同一处画了同一条线，它的注释原话是「返回 true 可以停掉 Lexical 的兜底换行，但**不消费**应用快捷键需要的那个 DOM 事件」。
- **标签上按右键能关掉一组了**：弹菜单里是「关闭这个标签 / 关闭其他标签页 / 关闭全部标签页」。dsh 那套停靠组件自己只带「关闭」一项，另外两项是照它的扩展位（`sidebar.right.tab.menu.item`）加的——一条标签上挂着一串 shell 和预览时，一个个点 ✕ 正是菜单该省掉的事，而它的第一项永远是「关闭」，位置和 dsh 里一样。菜单走 `document.body` 渲染：标签条是**故意**横向滚动的（四个标签时不让每个标题缩成两个字），画在里面的菜单会跟着被裁掉、被滚走，dsh 为同一个原因也这么做。只剩一个标签时只给「关闭」——三个名字说同一件事比一个更难读。
- `closeTab` 拆成了 `closeTab` / `closeTabs`（一次写入，不是每关一个写一次布局），并把「关掉标签会连 shell 一起杀」这条规则从 ✕ 上收到 `close-tabs.ts`：它原本只有 ✕ 一个调用点，现在菜单也能整组关，规则需要**一个**属主而不是第二份拷贝。这一条是这层唯一会杀进程的路径——折叠侧栏、切会话、刷新页面都只断开，后台跑着的构建因此活得下来。
- **预览能画 PDF 和 HTML 了，这两个形态都不是这个应用画的。** PDF 交给浏览器自己的查看器：新增 `GET /api/projects/:id/raw` 把字节按 `application/pdf` 流给一个 iframe，带 `content-length`、`inline` 的 `content-disposition` 和 `x-content-type-options: nosniff`——那个 content type 正是「谁来画」的判据，所以要声明而不是让浏览器猜；PDF 的框**故意不加沙箱**，因为要看的是查看器本身。HTML 画在 `sandbox=""` 的框里，`html-frame.ts` 再往文档里塞一条 CSP（`default-src 'none'`、`script-src 'none'`、图片/字体/媒体只许 `data:`、连接与表单全关）。**两把锁都要有**：`sandbox=""` 管住「跑」，管不住「取」——一个不跑脚本的页面仍然可以用一张图片的 URL 把看到的东西带出去，而 pi-web 服务端本来就不发任何安全响应头，没有东西可继承，所以策略只能写在文档里。框的背景是白的而不是跟主题：画的是**别人的**文档，一份不写背景色的 HTML 在深色主题下就是黑底黑字。`.pdf` 也从「已知二进制容器」那一列挪了出来——它不再是「不支持」，而是「这里画不了、有人能画」。
- **超过 1 MB 的文本不再只给开头那一段。** 原来这类文件只在上方写一句「仅显示前 1 MB」，读者被留在文件开头，而后面再也够不着。现在这种文件改走 `GET /api/projects/:id/text`：一页上限 256 KB 且最多 2000 行，**一定在一行结束后收尾**（唯一例外是单行本身就超过一页，那时按字符边界切开——`utf8SafeCut` 从窗口最后一个字节往回找到那个序列的首字节，把整个多字节字符留在同一边，否则接缝两边会各出现一个替换字符），返回 `nextOffset` 与 `eof`。按**字节偏移**而不是行号寻址，因为行号要先读完它前面的一切才知道是第几行，40 页之后的日志会重扫 40 个越来越长的前缀。前端一次只画一页，页与页之间用一条写着行号的虚线标出接缝，底下是「读取更多」与「已显示 N 行」；**不自动加载**——一个几百 MB 的文件不该因为滚到底就把浏览器吃掉。翻页的正文画成纯文本，哪怕它是源码：接缝必须看不出来，而按页调 `CodeBlock` 会在一个本没有接缝的文件中间插进语言标签和复制按钮。
- **右侧栏能分屏了，标签也能拖出成一个浮动面板。** 停靠区最多**左右两格**：按 `⌘\` 分当前这一格，或者把一个标签拖到某一格的左/右边缘松手；缝隙本身可以拖（两格各留 1/5 的下限，再窄就钉住而不是继续缩小），两格分别有自己的标签条、自己的滚动位置和「分栏」按钮——**上限两格**时那枚按钮置灰并写明「已达两格上限」，栏太窄放不下两格时置灰写「栏宽不足，拖宽侧边栏后再分栏」。把标签拖到标签条与窗格之外松手，它就变成一个**浮动面板**（默认 380×300、下限 220×140，落在释放点减去 60/14 的手抓偏移处）；浮窗能拖、能从右下角缩放、能按头部那枚按钮收回栏内，位置随会话保存。标签拖到另一格里换格、或拖到标签条的某个槽位插队，都会先画出一条 0.5px 的插入竖线。**被拖空的窗格会自己合并掉**（连同 `sizes` 一起作废），不补种占位的「文件」页——文件树与变更面板是每项目一份的视图，补种等于把它画两遍。
- **上面这些数字与文案是从 dsh 抄的，不是自己定的。** 浮窗 380×300 / 下限 220×140 / 级联原点 160×120、步进 24px、拖拽阈值 4px（4px 以内松手仍然算一次点击）、手抓偏移 60×14、两格下限 1/5（dsh 的工具箱默认 0.12，右侧栏用它自己的 0.2）、「分栏」被拒的那两句话、分隔缝那 0.5px 发丝线加 ±4px 命中区（缝本身**不占布局宽度**，`flex: none; width: 0`，两格才严丝合缝）——都取自 dsh 的 `ui-dockkit`，好让两边的手感一致。**一处刻意不同**：浮窗被拖出视口左上角时两个轴都钳回 0（dsh 只钳顶部），因为这里的抓手是浮窗自己的头部，浮窗跑到屏幕外之后就没有东西可以抓了。
- 新增 `dock-geometry.ts`（纯几何：投放位置、拖拽阈值、缝隙分数与下限、浮窗矩形与级联）与 `dock-hit.ts`（指针位置 → 投放目标），各有单测；手势本身在 `/tmp/piws-sc/v5.mjs` 的探针里对着真浏览器跑，因为服务端渲染器不跑 `useEffect`、也拒绝 portal，量不到矩形。
- **四个手势收在一个「一次只跑一个」的机制里**：`pointer.ts` 的 `useGesture` 只认发起手势的那个 `pointerId`，结束时统一清预览。栏左边缘那条 5px 的抓手也从自己写的一套 `useRef` + `onPointerMove` 改走同一条路——它原来只在指针留在文档内时才收得到移动，而它的左边正是对话区。

### 变更

- **默认对话显示改为「紧凑」**（dsh 的默认）。只有默认值变了：`store.json` 里已经写明模式的用户不受影响。另外活轮次与失败的轮次不再折叠——表头是一句完成汇报，这两种轮次都没有可汇报的东西。
- **每会话的右侧栏布局存储升到 v2**（`pi-web-simple.rightbar.v2.<会话路径>`）。v1 的键只读一次、之后不再写：v1 记的是「一栏里的标签列表」，v2 记的是窗格、窗格宽度与浮窗，所以升级的代价只是**第一次打开时分屏状态回到单格**，标签本身一个不丢。

### 修复

- **拖标签进 HTML 预览框会把手势卡死**（这条由新功能带出来，但根因在浏览器侧，值得单独说清）。`sandbox=""` 的框是不透明源、**单独一个渲染进程**，而 Chromium **不把指针捕获带过进程边界**：指针一进那个框，父文档就再也收不到 `pointermove`，最关键的是收不到 `pointerup`——于是「把标签拖到预览上放」这条最自然的操作会停在半路：投放提示层留在屏幕上、手势永不结算，直到下一次按下把它顶掉。这不是监听器写法的问题，事件在任何属于我们的处理器跑之前就已经被路由到另一个进程了。修法是**不让指针进那个框**：手势期间给整个视口盖一层透明遮罩（`gesture-shield.ts`），命中测试落在它身上，而它在这个文档里。指针捕获照常把事件（包括兼容鼠标事件）重定向回手势起点的元素，所以遮罩偷不走标签的点击。**dsh 没有这一层**——它的投放层同样是 `pointer-events: none`，这条路在那边也没被走通，只是它没有会撞上的框。
- **分隔缝画在了栏的末端，而不是两格之间**。分隔条原来跟在 `panes.map()` 后面，于是它成了行的最后一个子元素：宽度 0、0.5px 发丝线、`role="separator"`、8px 命中区全都照旧，看上去一切正常，只是整条缝（连那 8px 的抓手）跑到了视口右边缘之外（实测 `x = 1280`，窗口宽 1280，`elementFromPoint` 返回 null），**拖动分栏宽度因此从来没生效过**。dsh 的 `PaneTree.tsx` 把分隔条渲染在每个 cell **之前**，照着改之后它才落在两个窗格中间。探针里那段「按住缝隙往左拖、量两格宽度」是唯一能发现它的检查；`Rightbar.test.tsx` 补了一条比对标记顺序的断言。
- **浮动面板会画在侧栏和外壳底下**。浮窗原来按深度算行内 `zIndex: depth + 1`（拖拽中的那个用 `floats.length + 1`），而行内样式压过样式表里的 `.float { z-index: 40 }`，于是整层落到 1——低于它本该浮在之上的停靠栏（30）、应用外壳（20）和侧栏（40）。几何断言全都照样通过（位置、尺寸、portal 都对），只有面板与侧栏重叠时才看得出。现在两个高度都写在 CSS（`.float` 40、被手势抓着的那枚 `.floatLifted` 41），层内先后交给绘制顺序，与 dsh 一样。
- **底部的用量/计时栏不再偶尔跳动**。没有步数也没有 token 时这一行原本整行不渲染（照 dsh 的规则），但它是会话列的 flex 子项，卸载它等于把列高减掉 34px，输入卡会砸到窗口边缘——而转录**每次切换会话都会先被清空**（读回文件之前），一次慢读就能踩中：栏消失、输入卡下坠 34px、读完弹回来；本地读取通常在一帧内完成，所以平时只表现为「偶尔」。现在这一行常驻、只有两枚 pill 各自消失，并用 `min-height` 把空行盒子撑到与满行同高。
- **消息操作行（复制 / 用量 / 用时）不再掉到窗口底部之外**。自动跟随只挂在消息和流式增量上，而转录的高度还会被别的东西改：折叠一个已完成轮次的过程组、展开一个工具行、附件里的图片加载完成、设置里改正文号、todo 或提问卡片把输入栈撑高、窗口被拖小——这些都不经过消息，底边被推远之后就**没有任何东西把读者带回去**，于是操作行滑到折叠线以下，而「回到最新」的圆盘因为 `pinned` 仍为 true 也不出现（实测：窗口从 900 压到 700 时它落在可视区外 192px；展开最后一轮的过程组时 6347px）。现在用一个 `ResizeObserver` 同时看滚动区与消息列：跟随时重新贴底，不跟随时只重读一次距离——对齐 dsh 的 `ChatViewport.attach` → `onResize`（跟随时就再跟一次）。
- **草稿会话开终端会起在服务进程自己的工作目录里**。`SessionManager.open` 对一个**不是会话的 id 不报错**，而是返回服务进程的 cwd，所以 `terminalCwd` 里那句「草稿会抛错、由请求带上的 workspace 兜底」的兜底从来没生效过：新建会话（`draft:…`）里打开终端，shell 落在服务端被启动的那个目录，同时「工作区必须是已注册项目」这道校验也被绕过（任何 id 都能开出一个 shell）。现在先确认那个 id 确实指向一个会话文件再问 pi。用真浏览器 + 真 PTY 的探针发现的——修之前提示符是 `pi-web %`，修之后是 `ws %`；回归测试在 `routes.test.ts` 的 `terminal api` 里，把闸门拿掉时那三条会同时变红。

## [0.6.3] - 2026-10-06

### 修复

- **四个平台的安装包都打出来了，却挂不到 GitHub Release**：「挂到 GitHub Release」这个 job 不 checkout 源码（产物是下载下来的），所以工作目录里根本没有 git 仓库；而 `gh` 默认靠 git remote 判断「对哪个仓库操作」，于是它以 `failed to run git: fatal: not a git repository` 失败——`gh release view` 和随后的 `gh release create` 一起挂在仓库解析这一步（用本机同版本 gh 做过对照：不在 git 仓库里必然报这一句，在仓库里则会正常走到 API）。现在显式给一步 `GH_REPO`，绕开仓库解析，也因此不必为此多一次 checkout。顺带给「下载产物」那一步补上 `if-no-files-found: error`，免得日后没产物时把 `artifacts/*` 原样交给 gh、报出一条看不懂的「找不到文件」。这个 job 从加进来到 0.6.2 一直被 skip（前面的打包步骤失败），所以从没暴露过。

## [0.6.2] - 2026-10-06

### 修复

- **Windows 桌面包一直打不出来**：Node 官方发行包的**内部布局两个平台不一样**——类 Unix 的 tar.gz 把可执行文件放在 `bin/` 下，Windows 的 zip 则把 `node.exe` 直接放在解压出来的目录根上（压根没有 `bin/` 这一层）。`desktop/scripts/prepare-runtime.mjs` 用同一种布局去取两个平台的文件，于是 Windows 上 `tar` 报「Not found in archive」并以退出码 1 失败。0.6.1 那次跑批里 mac arm64 / mac x64 / linux 三个平台都已正常打包，只有 windows-x64 挂在「打包」这一步——就是这个原因。安装包里 `resources/runtime/node/bin/node.exe` 的落点没有变：那个 `bin/` 本来就是脚本自己摆的，不是从发行包里搬的（见 `desktop/src/main.cts` 的 `appPaths`）。

## [0.6.1] - 2026-10-06

### 修复

- **桌面版在 CI 上打不出安装包**（`.github/workflows/desktop.yml` 从未成功过，v0.4.x / v0.5.0 也没产出 GitHub Release）：`electron` 44 起发行包不再带 `postinstall`——二进制改成「首次 `require('electron')` 时惰性下载」，`bin.install-electron` 是它给的替代入口——所以 `pnpm install` 之后 `node_modules/electron/dist` 是空的。而 `electron-builder` 被配置成直接用本地这一份（`electronDist`，为的是省掉重复下载、并保证打包用的 Electron 和开发时跑的是同一个），打包脚本又硬要求它存在，于是四个平台全都倒在「打包」这一步、1~2 秒内退出。本地看不出问题，是因为跑过一次 `pnpm dev:desktop` 就顺手把二进下下来了，CI 上没人跑过 electron。现在 `desktop/scripts/package.mjs` 会在打包前显式补一次（`node_modules/electron/install.js`，自带幂等判断：dist 与 `path.txt` 都对就 `exit 0`，不会重复下 100 MB）；顺带把两条「重装一遍依赖即可」的旧提示改成正确的补救办法——那条建议在 electron 44 之后已经不管用了。

## [0.6.0] - 2026-10-06

### 新增

- **失败的轮次会在它该有回答的位置留下一条失败行**（`TurnFailure.tsx`）：模型请求失败、pi 又放弃之后（一次没重试，或自动重试用尽），转录里那条 `stopReason: "error"` 的 assistant 消息以前不显示——一个没吐出任何 token 的失败（最常见的形状）等于整轮没有反馈，pi 设置里关了自动重试时连重试行都没有。现在它画在回答原本的位置上，与重试行同形（同一套 `<details>`、同一个「失败原因」标签），换成错误色、不带扫光——已经没有东西在跑了。它**读转录而不是读流**，所以刷新、切会话、重开标签页之后这行都还在，而重试行只在当时有效；判定收在三条：只认本轮最后一条 assistant 消息（pi 重试成功后会从 agent state 删掉错误消息、但保留在 session 文件里，所以「文件里有错误消息」只说明某次尝试失败过）、轮次没结束不画（否则会和「等待重试模型请求」互相矛盾）、重试次数只附在最后一轮上（`auto_retry_end.attempt`——session 文件里没有这个数字，从磁盘读出来的失败行只写「模型请求失败」，不编一个次数）。行右边的「重试」是把那条 prompt 再发一次。

### 修复

- **新建但还没落盘的会话不会再从侧栏消失**：pi 要等第一条 assistant 回复才写 JSONL，而侧栏列表是按磁盘推导的，所以之前一个正在跑的新会话只在它恰好是「当前打开的那个」时才可见——切走或再新建一个，它的行就从侧栏掉了，哪怕 pi 进程还在。这份记录现在改成按工作区维护的 `unsavedSessions`（值是最新在前的路径列表，替代原来的单个 `draftProjectId`）：同项目下多个未落盘会话并排显示，创建接口返回真路径时在原地替换，文件落盘后由 `refreshSessions` 剔除，进程被关（`session_closed`）时一并删掉那一行——它永远不会落盘，留着只会指向一个打不开的会话。
- **断线重连后不再留下永远转下去的「进行中」状态点**：`hello` 帧带着服务端当前全部进程句柄，重连时拿它核对一遍运行标记（`reconcileActiveSessions`）——标记是 `ongoing` 却没有对应句柄，说明进程是在流断开期间没的（多半是服务端重启），此时收不到 `session_closed`，不清掉那枚点阵就会一直转。
- **切走再切回来不再把正在跑的会话当成空闲**：`isStreaming` 现在取两个来源的并集——本 hook 自己的事件订阅，和 app state 里按会话路径记的运行标记；只用前者的话，切走再切回会重新挂载 hook、丢掉内部状态，`TurnStatus` 和输入框那枚「停止」会一起消失。
- **排队里还没轮到 pi 取走的发言不再凭空多开一轮**：输入框在流式期间按 Enter 会把 steer / follow-up 乐观地放进转录（用户得看得见自己发了什么），但 pi 还没开始它那一轮；`groupTurns` 现在借 `undeliveredPrompts`（转录里的用户消息数 − pi 已取走的条数）把这些消息留在正在跑的那一轮里，等 `message_start` 才开新一轮。否则排队的那条会让正在跑的轮次不再是最后一轮，「本轮改动文件卡片」就在文件还在写的时候提前亮出来、下面那份列表还要接着长几行。用计数而不是比对文本：pi 在排队前就会展开 skill 命令，回显并不等于用户敲进去的那句话。

### 文档

- 设计说明补上失败行、`unsavedSessions`、`isStreaming` 并集与排队轮次分割四处的取舍；已知限制补一条「失败后只能把这条 prompt 再发一次，没有真正的重试」。

## [0.5.0] - 2026-09-24

### 改进

- **变更面板自动跟随工作区变化**：服务端递归监听每个项目的工作树（`node_modules` 的路径段在回调里滤掉），400ms debounce 后推一个 `workspace_changed`；面板开着且没有写操作在跑时自动重读 `git status` —— 编辑器保存、格式化、终端里的 `git` 命令都会反映进来，不必再点刷新。

### 性能

- **SSE 按会话订阅**：切会话时 `POST /api/events/subscription` 声明正在读哪个会话，服务端只推该会话的 token 流；侧栏状态点、扩展对话框、项目/会话列表这些低频帧照旧发给所有连接。实测 8 会话 × 4 客户端从 P50 1203ms / RSS +688MB 降到 P50 0ms / +8MB（[bench](./bench/README.md)）。
- **SSE 背压与缓冲上限**：`res.write` 返回 false 时暂停投递、排队等 `drain`；队列超过 `SSE_MAX_BUFFERED_BYTES`（默认 4MB）断开该连接，前端 `EventSource` 重连后重读一份快照（断线期间漏掉的增量不可能被下一条补上）。
- **图片上传前在浏览器里压缩**：长边缩到 1568px 并重新编码，截图/照片通常小一个数量级，不再让一张 5MB 截图把会话 JSONL 撑到 ~6.7MB；GIF 与小图原样放行，压缩失败或结果反而更大时回退原文件。
- **`useT()` / `useLanguage()` 改为字段级订阅**：不再因为设置里任何一处变化而重渲整条消息列表。
- **流式输出加 50ms 发布地板**：`message_update` 原本每帧重解析整段 partial Markdown，长回复下成本随文本增长（压测：当前会话占主线程 58%，8 会话并发直接打满）。现在最多每 50ms 发布一次，主线程占用减半以上，观感仍是连续吐字；`message_end`、`agent_settled`、工具结果仍立即发布。

## [0.4.1] - 2026-09-24

### 文档

- **README 补上「安装后怎么启动」**：把 `npx` 零安装、`npm i -g` 全局命令、pi 包 `/web` 三种方式整理成一张对照表，附 `PI_WEB_SIMPLE_PORT` / `PI_WEB_SIMPLE_OPEN` 两个开关和后台常驻（`nohup`）命令；中英两份 README 同步。

## [0.4.0] - 2026-09-24

### 新增

- **任务完成时发浏览器通知**：通用设置多了一行「浏览器通知」，默认关闭。打开后，会话任务跑完（`agent_settled`）而用户又不在看那个会话时，发一条系统通知（标题是会话名，正文一句「会话任务已完成」，点击跳回该会话）；同一会话的多次完成用 `tag` 相互替换，不堆成一摞。打开开关就是权限的申请入口——拿不到 `granted` 时开关弹回去并给一句提示，不把偏好写进 store；权限事后被浏览器撤销则静默跳过，不改写用户的选择。

## [0.3.0] - 2026-09-24

### 新增

- **界面双语**：设置页「外观」下面多了一行语言（`跟随系统` / `简体中文` / `English`），默认跟随系统——中文机器照旧中文，其它语言落在英文；选择写进服务端 store，刷新和换浏览器都在。430 条文案进了 [字典](./web/src/lib/i18n/messages.ts)：中文表是源表，英文表按 `Record<MessageKey, string>` 收口，漏一条翻译编译不过；占位符改名有测试兜。
- **格式也跟着语言走**：相对时间 `刚刚 / 12分钟` ↔ `just now / 12m`，耗时 `1分05秒` ↔ `1m 05s`，消息时间 `9月17日 21:00` ↔ `Sep 17, 21:00`。
- **README 截图分语言**：英文 README 用英文界面截图，中文 README 用中文界面截图，两套图各自来自一份真实的 pi 会话（`greet` 演示项目：读 → 编辑 → 写 README → 跑 `node`）。

### 说明

- 右栏标签页的标题改成渲染时按 kind 查表：标签列表会跨语言切换、也会被持久化，创建时把标题存下来就会留下旧语言。
- `app-state` 的通知在 action 内取当前语言的 translator——action 不是组件，拿不到 hook，但读 store 就能拿到用户此刻在看的语言。
- 模块级常量表（工具变体、命令来源、MCP 作用域、插件分组、传输方式、状态词表、选项表）都改成按 `t` 求值的函数，避免把首次 import 时的语言冻住。

## [0.2.2] - 2026-09-24

### 修复

- **npm 页面与 registry 显示的是中文版 README**。npm 用 glob `{README,README.*}` 挑包说明，而它返回的顺序是 `[README.zh-CN.md, README.md]`（不是字母序），命中第一个就 `break`——于是 0.2.1 里 `npm view pi-web-simple readme`、npm 网页、以及任何读 registry 的地方（包括画廊）拿到的都是中文版。中文版移到 [docs/README.zh-CN.md](./docs/README.zh-CN.md)，根目录只剩 `README.md`，候选就只有一个；它内部的相对链接（`docs/*` → `./*`，根目录文件 → `../*`）按新位置全部改过，英文版与 CONTRIBUTING、设计说明里的链接也跟着改指新路径。

## [0.2.1] - 2026-09-24

### 变更

- **README 拆成中英两份**：[README.md](./README.md) 为英文（npm 与 [pi.dev 画廊](https://pi.dev/packages/pi-web-simple) 展示的就是这一份），[README.zh-CN.md](./README.zh-CN.md) 为中文，两份顶部一键互切。切换链接用 GitHub 绝对地址而不是相对路径，因为相对链接在 npm 页面上会 404。
- **`files` 补上 `README.zh-CN.md`**：npm 只默认带 `README.md`，不加这一项包里就没有中文版，切换链接会指向一个不存在的文件。
- [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [设计说明](./docs/design-notes.md) 里指向 README 的链接改指中文版（英文版里没有中文锚点）。

## [0.2.0] - 2026-09-24

### 新增

- **包本身成了 pi 包**：加上 `pi-package` 关键词与 `pi.extensions` 清单，`pi install npm:pi-web-simple` 就能装进 pi 会话，同时包会被 [pi.dev/packages](https://pi.dev/packages) 画廊自动收录（那里没有提交入口，只按关键词索引 npm）。
- **`/web` 命令**：`/web [端口] [--no-open]` 启动界面（默认沿用 5319，自动开浏览器）、`/web status` 看状态、`/web stop` 关闭。子进程由 pi 管理，`session_shutdown` 时一并结束，不留孤儿进程；端口被占用之类的启动失败会带上服务端最后几行日志报回 pi 界面。

### 工程

- **`scripts/verify-dist.mjs` 多两道发布闸门**：`extensions/index.js` 是否随包发出，以及 `package.json` 是否还带着 `pi-package` 关键词。后者是又一种静默失败——少了它 `npm publish` 照样成功，只是画廊永远不收录。

## [0.1.1] - 2026-09-24

### 改进

- **代码高亮移植了 dsh 的流式增量 tokenizer**：用 `codeToTokensBase` 接上一次的 `grammarState` 按行续接，冻结最后一个换行之前的全部内容（连同它们的 HTML），每个新 delta 只重新 tokenize 正在写的那一行。200 行 typescript（约 9 KB）实测：全量一次 101ms，续接后重算最后一行 0.6ms。2 万字符上限只剩在「必须从头 tokenize」的路径上，流式增长的长块不再受它限制。
- **语法预热扩展到按需加载的语言**：JS 引擎的 pattern 用到才编译，没预热过的 grammar 第一次 tokenize 出来的 token 比之后每一次都粗，同一块代码第二次绘制时颜色会变；现在动态 `import()` 落地后、在通知重渲染之前先跑一遍样本。

### 移除

- **`docs/PLAN.md`**：实现阶段的计划文档，文件结构、步骤与验证清单都已完成，其中的临时路径（`/tmp/dsh-probe`）与「待创建」目录树也已经和仓库对不上。设计取舍仍由 [设计说明](./docs/design-notes.md) 承载，原文在 git 历史里（`git show HEAD:docs/PLAN.md`）。
- [设计说明](./docs/design-notes.md) 里重复出现两遍的 diff 解析段落（「diff 的文本理解」与「补丁的文本理解」内容一致）删去后者。

### 修复

- **对话流式输出时的闪烁与跳动**：
  - 代码块不再在「纯文本 → 高亮」之间闪一下：首帧可见性改用 `useLayoutEffect` 同步量取，两种状态共用同一个容器。
  - 一轮消息提交时不再整块重挂载：流式中的内容直接渲染在它即将落进的那一轮里，代码块不会重新上色、思考行不会自己折回。
  - 跟随滚动改到绘制之前，并关掉浏览器滚动锚定；代码块预留横向滚动条位置，不再因横条出现/消失而整体下移。
  - 每个 token 一次的视图发布按动画帧合并；`Markdown` 按文本记忆化、高亮结果按「语法 + 源码」缓存，流式期间不再重解析/重高亮整个转录。
- **长行不再卡死页面**：单行超过 2 000 字符的内容直接不参与分词（`tokenizeMaxLineLength`）。一行两万字符实测要 52 秒，整页在这期间没有响应——那是 JS 正则引擎的非线性成本，原生 Oniguruma 不会这样。

## [0.1.0] - 2026-09-24

首次公开发布。一个本地 Web UI，套在 pi 之上：`npx pi-web-simple` 启动单个进程，同时提供前端与 API。

### 新增

- **项目管理**：一个本地目录 = 一个项目，项目下挂该目录的会话。内置服务端目录选择器（逐级进入、地址栏可粘贴路径、主目录/桌面/文稿/下载/根目录快捷入口）。
- **会话**：每个活跃会话对应一个 `pi --mode rpc` 子进程，活跃数上限可配，空闲自动回收（含预热进程）。
- **对话**：SSE 流式输出、Markdown 渲染、shiki 代码高亮、图片输入、消息操作行、会话 fork 与话题树。
- **模型选择**：新建会话时可选模型；模型配置沿用 pi 自己的配置文件，不另建一份状态。
- **右侧栏**：文件树、文件预览、变更面板、内嵌浏览器。
- **变更面板**：分「已暂存 / 未暂存」两份 diff、hunk 级折叠、分支列表与上游 ahead/behind、提交历史，以及写操作（暂存/取消暂存/全部暂存、提交、推送、还原、切分支）。
- **每轮改动文件卡片**：每轮对话末尾列出该轮实际改动的文件。
- **设置页**：通用、模型、插件、MCP 四节。
- **扩展生态接入**：
  - 插件清单由 pi 自己的资源解析器（`DefaultPackageManager` / `SettingsManager`）计算，与终端看到的一致。
  - MCP 一节动态加载 `pi-mcp-adapter/config` 的公开入口，并支持真实握手检查（stdio `initialize` + `tools/list`）。
  - 扩展的 UI 请求（`ctx.ui.confirm/select/input/editor`）**替换输入框**而非弹模态。
  - 任务清单面板依赖 `@juicesharp/rpiv-todo`，未安装时显示一次性的安装提示。
  - 更新检查与提示。
- **仅监听 `127.0.0.1`**，默认不对外暴露。

### 说明

- 需要 Node.js `>= 22.19.0`。
- pi 的 `todo` 工具与 MCP 能力分别由 `@juicesharp/rpiv-todo` 和 `pi-mcp-adapter` 扩展提供，本项目不内置；缺少时界面给出安装入口而非静默空白。

[0.1.1]: https://github.com/woxihejinghao/pi-web/releases/tag/v0.1.1
[0.1.0]: https://github.com/woxihejinghao/pi-web/releases/tag/v0.1.0

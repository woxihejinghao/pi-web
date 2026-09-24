# 贡献指南

感谢你有兴趣改进 pi-web-simple。这是一个本地 Web UI，套在 [pi](https://github.com/earendil-works/pi-coding-agent) 之上——agent 内核、会话存储、扩展与 MCP 全部由 pi 提供，本项目只做外壳。

## 环境要求

- Node.js `>= 22.19.0`
- pnpm `9.15.4`（`package.json` 的 `packageManager` 字段会由 Corepack 自动匹配）

## 起步

```sh
pnpm install
pnpm dev
```

开发模式下前端在 `127.0.0.1:5319`、后端 API 在 `127.0.0.1:4319`，浏览器打开的仍是 5319。完整说明见 [README 的「从源码开发」](./README.zh-CN.md#从源码开发)，环境变量表见 [docs/configuration.md](./docs/configuration.md)。

## 提交前必须通过

CI 会跑这四步，本地请先自己跑一遍：

```sh
pnpm typecheck   # 前后端 tsc --noEmit
pnpm build       # web 出 dist、server 出 build
pnpm test        # vitest（前后端）
node scripts/verify-dist.mjs   # 构建产物完整性闸门
```

`pnpm test` 必须是全绿。这个仓库的测试不是摆设：

- 测试与源码同目录（`foo.ts` 配 `foo.test.ts`），改行为时请同时改测试。
- server 侧测试会真实拉起 pi RPC 子进程、创建 bare git 仓库并 push、跑真实 MCP 握手——它们不 mock 这些边界，所以别为了「让测试过」而把断言放宽。
- web 侧测试是纯逻辑测试（无 DOM 环境），覆盖对话树的模型层、路径缩写、项目树等。

## 代码约定

- TypeScript `strict`，ESM（`"type": "module"`）。server 用 `tsx` 直跑 TS，`moduleResolution` 为 `bundler`。
- 样式用 CSS Modules；设计变量（`--dsw-*`）集中定义在 `web/src/theme/design-platform.css`，组件里别新造色值。
- 注释解释「为什么」，不解释「做了什么」——现有很多注释记录了取舍与踩过的坑，请保持这个密度。
- 不引入新的运行时依赖前，先确认它不能由现有依赖完成。前端运行时依赖目前只有 `react` / `react-dom` / `react-markdown` / `remark-gfm` / `shiki` / `clsx`。

## 提交信息

沿用现有风格：Conventional Commits 前缀 + 中文描述，不加 scope 与 emoji。

```
feat: 新增右侧栏（文件树/预览/变更面板/内嵌浏览器）
fix: 修正空闲回收后会话标题丢失
docs: 补充 MCP 一节的安装前置条件
```

## 提交 PR

1. Fork 并从 `main` 开分支。
2. 保持改动聚焦——一个 PR 解决一件事，便于 review 与回滚。
3. 在 PR 描述里写清：动机、做法、以及你**实际验证**了什么（跑了哪些测试、在浏览器里点过哪些路径）。
4. 涉及界面改动请附截图。

## 项目结构

```
bin/       发布入口（npx pi-web-simple → server/build/index.js）
server/    API + pi RPC 子进程管理 + 会话/项目/git/MCP 读写
web/       React 前端（Vite）
bench/     基准脚本（进程开销、流式、前端渲染成本），不随 npm 包发布
scripts/   发布前的仓库级闸门
docs/      设计说明、已知限制、环境变量、网络与隐私
```

更细的架构说明与设计取舍见 [设计说明](./docs/design-notes.md)。

## 许可证

贡献即表示同意以 [MIT](./LICENSE) 授权。

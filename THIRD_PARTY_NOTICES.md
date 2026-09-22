# Third-Party Notices

`pi-web-simple` 的界面与部分服务端逻辑移植、改编自下列上游项目。上游均为 MIT
许可，允许复制、修改与再分发，**前提是保留其版权声明与许可文本**——本文件即为
履行该义务而存在，随源码一并分发，不得移除。

本文件只覆盖**被复制进本仓库**的代码与设计资源。通过 npm 安装的运行时依赖
（React、Vite、shiki 等）由各自的包分发其许可，不在本文件范围内。

---

## 1. deepseek-harness (dsh)

- 上游：<https://github.com/deepseek-ai/deepseek-harness>
- 许可：MIT
- 版权：Copyright (c) 2026 DeepSeek

本项目的界面是 dsh Web UI 的移植：排版层级、尺寸度量、动效、文案与设计 token
大量照搬其原件，其中一部分是**逐字节**复制（源文件注释中标注为
`byte-identical`、`verbatim` 或 `Ported from`）。具体范围：

| 本仓库位置 | 与 dsh 的关系 |
|---|---|
| `web/src/components/dsh-icons.tsx` | Figma glyph 路径数据**逐字节相同**（仅外层 React 包装是本项目的） |
| `web/src/components/icons.tsx` | 部分 glyph 取自 dsh（如 `GaugeIcon` = dsh 的 `IconGaugeOutline16`），各 glyph 处已标注 |
| `web/src/theme/design-platform.css` | `--dsw-*` / `--dsh-*` 设计 token 表逐字移植，含四个深色主题块 |
| `web/src/theme/gradient-shadow-text.css` | 渐变与阴影 token 表 |
| `web/src/theme/scrollbar.css` | 滚动条皮肤与其消费的 `--dsw-alias-scrollbar-*` token |
| `web/src/theme/corner-shape.css` | `--dsw-corner-shape` 圆角 token |
| `web/src/theme/shiki.css` | shiki `css-variables` 主题的 `--shiki-*` 取值 |
| `web/src/features/settings/*` | 设置页骨架与文案（`SettingsPage`、`GeneralSection`、`ProviderEditor`、`ModelsSection`、`McpSection`、`FetchModelsDialog` 等标注 `Ported from dsh's …`） |
| `web/src/features/conversation/*` | `DisclosureRow`、`TurnStatus`、`TurnNavigator`、`RetryNotice`、`row-model` 等移植自 dsh 原件 |
| `web/src/features/conversation/highlight.ts` | shiki 语言表与别名表照抄 dsh |
| `server/src/store.ts` | 会话显示偏好（transcript-mode、正文字号边界）移植自 dsh |

MIT 许可全文（dsh 原件）：

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. @earendil-works/pi-coding-agent

- 上游：<https://github.com/earendil-works/pi-coding-agent>
- 许可：MIT（依据该包 `package.json` 的 `license` 字段；上游仓库与已发布包均未附带 `LICENSE` 文件，因此此处不转录版权行）
- 说明：pi 同时是本项目的运行时依赖（经 npm 安装，不随本仓库分发）。下表只是**被复制或重建进本仓库**的那部分，为了与 pi 的行为逐字节一致而存在：

| 本仓库位置 | 与 pi 的关系 |
|---|---|
| `server/src/composer.ts` | `estimateContextTokens` 按 pi 未导出的同名实现重建 |
| `server/src/extensions.ts` | `withOverride` 复制自 `pi config`，保证两处写入结果一致 |
| `server/src/session-path.ts` | 镜像 pi 私有的 `getDefaultSessionDirPath` |
| `server/src/models.ts` | provider 对象的重建逻辑遵循 `pi-ai` 未导出的实现 |
| `web/src/features/conversation/skill-block.ts` | 移植 pi 的 `parseSkillBlock` 正则，用于折叠展开后的 skill 命令 |

---

## 3. 其它第三方资源

- **shiki** 及其语法/主题数据：本项目只消费其公开 API（`@shikijs/*` 通过 `shiki` 包引入），语言表的选择是产品决定，见上表。
- **npm 依赖树**：截至开源时的扫描结果全部为宽松许可（MIT / ISC / Apache-2.0 / BSD-3-Clause / 0BSD），无 copyleft 依赖。

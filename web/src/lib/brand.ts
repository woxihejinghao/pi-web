/**
 * 应用的品牌 mark —— 一张黑底白 π 的位图，落在 `web/public/pi-mark.png`。
 *
 * 与桌面版图标同源：`desktop/resources/icon-source.png` 是同一张素材，
 * electron-builder 用它出 .icns / .ico。侧栏、新会话页、运行状态行与浏览器
 * 标签页因此共用同一枚 mark，换图时两边一起换。
 *
 * 放在 `public/` 而不是 `src/assets/`：favicon 需要一个稳定地址
 * （`web/index.html` 直接引 `/pi-mark.png`），而界面里三处 mark 只有大小与
 * 圆角不同，直接复用这一个 URL 比让打包器再走一遍 asset 管线更直白。
 */
export const PI_MARK_URL = "/pi-mark.png";

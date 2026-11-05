/**
 * 应用的品牌 mark —— 一张黑底白 π/WEB 的位图，落在 `web/public/pi-mark.png`。
 *
 * 与桌面版图标同源：`desktop/resources/icon-source.png` 是同一张素材，
 * electron-builder 用它出 .icns / .ico。侧栏、新会话页、运行状态行与浏览器
 * 标签页因此共用同一枚 mark，换图时两边一起换。
 *
 * 网页端这份是**满幅方形**，四角不带 alpha：三个用它的地方尺寸不同、圆角也不同
 * （侧栏 24px、新会话页 30px、状态行 14px），圆角一律由 CSS `border-radius` 给。
 * 预先裁好圆角的只有 macOS 那份桌面图标（`desktop/resources/icon.png`）——
 * 系统要求它的画布本身就带透明留白，详见 `desktop/scripts/render-icon.mjs`。
 *
 * 放在 `public/` 而不是 `src/assets/`：favicon 需要一个稳定地址
 * （`web/index.html` 直接引 `/pi-mark.png`），而界面里三处 mark 只有大小与
 * 圆角不同，直接复用这一个 URL 比让打包器再走一遍 asset 管线更直白。
 */
export const PI_MARK_URL = "/pi-mark.png";

/**
 * 应用对外的名字 —— 侧栏品牌文字、窗口标题、以及系统通知的标题都用它。
 *
 * 与上面那枚 mark 是一对：mark 是不带字的图形，而浏览器通知的标题行是应用
 * 唯一能自己写名字的地方（通知最上面那行来源由地址决定，页面改不了）。
 */
export const APP_NAME = "pi-web-simple";

/**
 * electron-builder 配置。
 *
 * 与 deepseek-harness 的做法一致：应用目录（`directories.app`）不是源码目录，
 * 而是 `scripts/prepare-app.mjs` 现搭出来的 `.desktop-build/app`——里面只有
 * 真正要发的东西（Electron 主进程、服务端编译产物、前端产物、以及一次干净的
 * `npm install` 装出来的 pi 内核）。
 *
 * `asar` 关掉是有意的：pi 会在运行时按路径读取包内文件（wasm、jiti 动态加载的
 * .ts），而自带 Node 运行时的子进程读 asar 需要 Electron 对 fs 打的补丁——那
 * 只在 Electron 自己的进程里有。摊平成真实文件树，两边行为就一致了。
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktopDir = dirname(fileURLToPath(import.meta.url));

/**
 * 目录全部写成绝对路径：electron-builder 是被放在 `.desktop-build/app` 里跑的
 * （原因见 scripts/package.mjs 的注释），相对路径会以那里为基准，指错地方。
 * `directories.app` 不写：工作目录就是应用目录，写了反而会多一条「应用目录与项目目录
 * 相同」的告警。
 */
const directories = {
  output: join(desktopDir, "release"),
  buildResources: join(desktopDir, "resources"),
};
const runtimeDir = join(desktopDir, ".desktop-build", "runtime");
const iconPath = join(desktopDir, "resources", "icon.png");

/**
 * Electron 版本与发行包都直接取本地已经装好的那一份：
 *
 * - 版本号不能写 `^44.0.0` 这种范围——electron-builder 会照着它去下 `44.0.0`，
 *   和实际装的 `44.5.0` 对不上。
 * - `electronDist` 指向 `node_modules/electron/dist`，electron-builder 就不再自己
 *   下载了：省掉一次约 110 MB 的网络请求（本地与 CI 都受益），也让「打包用的
 *   Electron」和「开发时跑的那个」永远是同一个。
 *
 * 应用目录（`.desktop-build/app`）里没有 electron 依赖，所以这两项只能在这里显式给。
 */
const electronPkgPath = require.resolve("electron/package.json");
const electronVersion = JSON.parse(readFileSync(electronPkgPath, "utf8")).version;
const electronDist = join(dirname(electronPkgPath), "dist");

if (!existsSync(join(electronDist, "version"))) {
  throw new Error(
    `electron 发行包缺失（${electronDist}）。\n` +
      "electron 44 起发行包不再带 postinstall，`pnpm install` 不会下二进制——\n" +
      "跑 `node desktop/node_modules/electron/install.js` 补齐即可（scripts/package.mjs 正常会先补好）。\n" +
      "若装依赖时设过 ELECTRON_SKIP_BINARY_DOWNLOAD=1，去掉它。",
  );
}

/** deb 必须有 maintainer，否则打不出来。换发布者时改这一行即可。 */
const MAINTAINER = "woxihejinghao <woxihejinghao@users.noreply.github.com>";

const MAC_ARTIFACT = "${productName}-${version}-mac-${arch}.${ext}";
const WIN_ARTIFACT = "${productName}-${version}-win-${arch}.${ext}";
const LINUX_ARTIFACT = "${productName}-${version}-linux-${arch}.${ext}";

export default {
  appId: "dev.piwebsimple.desktop",
  productName: "pi-web-simple",
  electronVersion,
  electronDist,
  copyright: "Copyright © pi-web-simple contributors",
  directories,
  // 生成的 app/package.json 里没有 author，electron-builder 会为此打一条告警，
  // 而 deb 的 maintainer、NSIS 的 publisher 也都取自它。在这里补上，而不是往
  // prepare-app.mjs 里塞一份重复的常量。
  extraMetadata: { author: MAINTAINER },
  // 产物里没有原生模块，也没有需要重新编译的依赖，跳过 electron-rebuild。
  npmRebuild: false,
  asar: false,
  // 自带运行时：安装包内的 resources/runtime/node/bin/node 就是 agent 子进程用的 Node。
  extraResources: [{ from: runtimeDir, to: "runtime" }],
  files: ["**/*", "!**/*.map", "!**/.DS_Store", "!package-lock.json"],
  // 不发到任何 publish provider；产物由 CI 挂到 GitHub Release 上。
  publish: null,

  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    icon: iconPath,
    darkModeSupport: true,
    artifactName: MAC_ARTIFACT,
    // 没有签名证书：显式关掉，免得 electron-builder 去找钥匙串然后失败。
    identity: null,
    notarize: false,
  },
  win: {
    target: ["nsis", "zip"],
    icon: iconPath,
    artifactName: WIN_ARTIFACT,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: "pi-web-simple",
    artifactName: "${productName}-${version}-win-${arch}-setup.${ext}",
  },
  linux: {
    target: ["AppImage", "deb"],
    icon: iconPath,
    category: "Development",
    maintainer: MAINTAINER,
    synopsis: "Local web UI for the pi coding agent",
    description:
      "Desktop build of pi-web-simple: one local directory per project, sessions in the pi coding agent, wrapped in an Electron shell with its own Node.js runtime.",
    artifactName: LINUX_ARTIFACT,
    // electron-builder 26 起只接受 { entry, desktopActions } 这一层包装。
    desktop: {
      entry: {
        Name: "pi-web-simple",
        Comment: "Local web UI for the pi coding agent",
        Categories: "Development;Utility;",
      },
    },
  },
};

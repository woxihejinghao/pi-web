#!/usr/bin/env node
/**
 * 组装 electron-builder 要打包的「应用目录」（`.desktop-build/app`）。
 *
 * 为什么要这么一层：桌面版不是新程序，它就是把**同一个**服务端和**同一份**
 * 前端塞进 Electron 壳里——壳只负责开窗口，`server/build/index.js` 与
 * `web/dist` 原封不动地复用（浏览器版、CLI 版、桌面版三者不会漂移成三个产品）。
 *
 * 目录布局刻意与已发布的 npm 包保持一致：`server/build/` 与 `web/dist/` 同级，
 * 因为 `server/src/config.ts` 是按 `../../web/dist` 相对定位前端的。改动这里
 * 的层级就会连带改掉前端的探测逻辑。
 *
 * 依赖不走 pnpm 的 workspace 链接：pnpm 的 `node_modules` 是一层指向仓库外
 * store 的符号链接，electron-builder 收不进包里。这里改用一次干净的
 * `npm install --omit=dev`，只装 pi 内核这一个运行时依赖（版本取仓库里实际
 * 装到的那一个，保证和 CI 测过的完全一致）。
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDir, "..");
const buildDir = join(desktopDir, ".desktop-build");
const appDir = join(buildDir, "app");
const PI = "@earendil-works/pi-coding-agent";

const rootPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** 仓库里实际装到的 pi 版本；拿不到就退回 package.json 里写的范围。 */
function resolvePiVersion() {
  const installed = join(repoRoot, "node_modules", ...PI.split("/"), "package.json");
  if (existsSync(installed)) {
    try {
      return JSON.parse(readFileSync(installed, "utf8")).version;
    } catch {
      /* 落到下面的范围 */
    }
  }
  return rootPkg.dependencies[PI];
}

// --- 前置产物 -------------------------------------------------------------

if (!existsSync(join(repoRoot, "server", "build", "index.js")) || !existsSync(join(repoRoot, "web", "dist", "index.html"))) {
  fail("缺少 server/build 或 web/dist，先在仓库根目录跑 `pnpm build`");
}
for (const file of ["main.cjs", "preload.cjs"]) {
  if (!existsSync(join(desktopDir, "build", file))) {
    fail(`缺少 desktop/build/${file}，先跑 \`pnpm --filter pi-web-simple-desktop run build\``);
  }
}

// --- 应用目录 -------------------------------------------------------------

const piVersion = resolvePiVersion();

await rm(appDir, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });

await cp(join(repoRoot, "server", "build"), join(appDir, "server", "build"), { recursive: true });
await cp(join(repoRoot, "web", "dist"), join(appDir, "web", "dist"), { recursive: true });
await cp(join(desktopDir, "build", "main.cjs"), join(appDir, "main.cjs"));
await cp(join(desktopDir, "build", "preload.cjs"), join(appDir, "preload.cjs"));

// 安装包要能自证出处：自己的 MIT 许可，以及那份必须随二进制一起分发的第三方声明
// （里面含自带的 Node.js 运行时）。两者都放在应用目录根部，菜单里的
// 「第三方声明」直接打开后者。
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await cp(join(repoRoot, file), join(appDir, file));
}

// 版本号只有仓库根 package.json 一处来源：desktop/package.json 里那个 0.0.0 只是
// 占位，免得两处版本号各自被 bump。
await writeFile(
  join(appDir, "package.json"),
  JSON.stringify(
    {
      name: "pi-web-simple",
      version: rootPkg.version,
      description: rootPkg.description,
      license: rootPkg.license,
      homepage: rootPkg.homepage,
      repository: rootPkg.repository,
      // Electron 主进程是 main.cjs，而服务端编译产物是 ESM —— 两者同处一个包，
      // 所以这里必须是 module，入口靠扩展名区分。
      type: "module",
      main: "main.cjs",
      dependencies: { [PI]: piVersion },
    },
    null,
    2,
  ) + "\n",
);

// --- 运行时依赖 -----------------------------------------------------------

// pnpm 会在环境里留下 npm_config_* / PNPM_* 之类的开关（例如把依赖装成链接），
// 那正是这里要避开的东西，所以交给 npm 的是一份清过的环境。
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(npm_|pnpm_)/i.test(key)),
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const install = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
  cwd: appDir,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: npmEnv,
});
if (install.status !== 0) fail(`npm install 失败（退出码 ${install.status}）`);

// 保留 npm 自己写出来的 package-lock.json：electron-builder 靠锁文件判断该用哪个
// 包管理器分析依赖树。删了它，它就退回去看环境变量（我们是通过 pnpm 调的，于是
// 认出 pnpm），然后拿**仓库根的 pnpm 工作区**去算文件清单——结果是以 pnpm 的目录
// 布局在应用目录里找文件，`pi-coding-agent/node_modules/**` 这一大半会被默默丢掉，
// 打出一个装机后一启动就报错的包。留着锁文件，它才老老实实分析这个 npm 树。
if (!existsSync(join(appDir, "package-lock.json"))) {
  fail("npm install 没有生成 package-lock.json，electron-builder 会认错包管理器");
}

// 真实路径检查：`node_modules` 必须是实打实的目录，不能是 pnpm 那种符号链接，
// 否则 electron-builder 收进包里的会是一堆断链。
if (!existsSync(join(appDir, "node_modules", ...PI.split("/"), "package.json"))) {
  fail(`node_modules 里没有 pi 内核（${PI}）`);
}

// --- 瘦身 -----------------------------------------------------------------

/**
 * 删掉「不属于当前平台」的包。
 *
 * 为什么需要：esbuild 把各平台的二进制写成 optionalDependencies，每条都带
 * `os`/`cpu` 字段声明自己属于哪个平台。pnpm 会照此跳过，npm 却把二十多个平台
 * 全装了下来（实测 284 MB，占整个 node_modules 的三分之二）。既然包的作者已经用
 * 标准字段声明了归属，照着删就是最不容易出错的做法——比手写包名黑名单可靠。
 *
 * 瘦身的边界也就在这里：只删整包的「平台不符」，不做按体积的黑名单。例如
 * `web-streams-polyfill` 有 9 MB（也多是好几个发行变体），但它是
 * pi-ai → @google/genai → gaxios → node-fetch 这条链上的真实运行时依赖，
 * 删它的任何一个文件都可能在用到 Google 模型时才炸。体量换安全，就这样。
 */
function excludedByPlatform(manifest) {
  const matches = (list, value) => {
    if (!Array.isArray(list) || list.length === 0) return true;
    const denied = list.filter((item) => item.startsWith("!"));
    const allowed = list.filter((item) => !item.startsWith("!"));
    if (denied.includes(`!${value}`)) return false;
    return allowed.length === 0 || allowed.includes(value);
  };
  return !matches(manifest.os, process.platform) || !matches(manifest.cpu, process.arch);
}

/** 递归遍历每层 node_modules，返回被删掉的包数量与字节数。 */
async function pruneForeignPlatforms(directory) {
  if (!existsSync(directory)) return { removed: 0, bytes: 0 };
  let removed = 0;
  let bytes = 0;
  for (const entry of await readdir(directory)) {
    if (entry === ".bin" || entry.startsWith(".")) continue;
    const entryPath = join(directory, entry);
    const candidates = entry.startsWith("@") ? (await readdir(entryPath)).map((name) => join(entryPath, name)) : [entryPath];
    for (const candidate of candidates) {
      const manifestPath = join(candidate, "package.json");
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch {
        continue;
      }
      if (excludedByPlatform(manifest)) {
        const size = directoryBytes(candidate);
        await rm(candidate, { recursive: true, force: true });
        removed += 1;
        bytes += size;
        continue;
      }
      const nested = await pruneForeignPlatforms(join(candidate, "node_modules"));
      removed += nested.removed;
      bytes += nested.bytes;
    }
  }
  return { removed, bytes };
}

function directoryBytes(path) {
  const result = spawnSync("du", ["-sk", path], { encoding: "utf8" });
  if (result.status !== 0) return 0;
  return Number(result.stdout.split(/\s+/)[0]) * 1024;
}

const pruned = await pruneForeignPlatforms(join(appDir, "node_modules"));
if (pruned.removed > 0) {
  console.log(`· 已剔除 ${pruned.removed} 个非当前平台的包（省下 ${(pruned.bytes / 1024 / 1024).toFixed(0)} MB）`);
}

// --- 汇报 -----------------------------------------------------------------

function directorySize(path) {
  return `${(directoryBytes(path) / 1024 / 1024).toFixed(0)} MB`;
}

const mainSize = (await stat(join(appDir, "main.cjs"))).size;
console.log("✓ 应用目录就绪：");
console.log(`    ${appDir}`);
console.log(`    pi-web-simple ${rootPkg.version} · pi 内核 ${piVersion}`);
console.log(`    main.cjs ${(mainSize / 1024).toFixed(1)} kB · node_modules ${directorySize(join(appDir, "node_modules"))}`);

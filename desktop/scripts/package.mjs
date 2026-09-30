#!/usr/bin/env node
/**
 * `pnpm --filter pi-web-simple-desktop run package` 的入口，把一条命令拆成四步：
 * 编译 → 搭应用目录 → 备好自带 Node 运行时 → 交给 electron-builder。
 *
 * 之所以要一个脚本而不是串四条 npm script：electron-builder 的 `--mac/--win/--linux`
 * 与体系结构必须和「已经下载好的那个 Node 运行时」严格对上（下载的是宿主平台的
 * 那一份）。把这一步的判断收在一处，跨平台打包时至少能给出人话报错，而不是打出一个
 * agent 一启动就 ENOENT 的包。
 *
 * 用法：
 *   node scripts/package.mjs                # 当前平台 + 当前架构，出安装包
 *   node scripts/package.mjs --dir          # 只出免安装目录（最快，用来验证）
 *   node scripts/package.mjs --no-build     # 跳过仓库根的 pnpm build
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopDir, "..");
const args = process.argv.slice(2);

const TARGETS = { darwin: "mac", win32: "win", linux: "linux" };
const ARCHES = { arm64: "arm64", x64: "x64" };

const target = TARGETS[process.platform];
const arch = ARCHES[process.arch];
if (target === undefined || arch === undefined) {
  console.error(`✗ 不支持的平台：${process.platform}-${process.arch}`);
  console.error("  桌面版自带宿主平台的 Node 运行时，所以请在目标平台上打包。");
  process.exit(1);
}

const windows = process.platform === "win32";
/**
 * Windows 上 `pnpm` 实际是 `pnpm.cmd`，必须过一层 cmd 才找得到；但开了 shell 之后
 * 参数是拼成命令行的，带空格的路径（Node 可执行文件在 `Program Files` 里）不加引号
 * 就会被拆成两个参数。所以开了 shell 的时候自己把引号补上。
 */
function run(command, commandArgs, cwd) {
  const quote = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  const file = windows ? quote(command) : command;
  const argv = windows ? commandArgs.map(quote) : commandArgs;
  const result = spawnSync(file, argv, { cwd, stdio: "inherit", shell: windows });
  if (result.status !== 0) {
    console.error(`✗ ${command} ${commandArgs.join(" ")} 失败（退出码 ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(join(desktopDir, "node_modules", "electron-builder"))) {
  console.error("✗ 还没装打包依赖，先在仓库根目录跑 `pnpm install`");
  process.exit(1);
}
// electron-builder 直接用本地这一份 Electron 发行包（见 electron-builder.config.mjs），
// 所以它必须在。装依赖时若设过 ELECTRON_SKIP_BINARY_DOWNLOAD=1 就会缺。
if (!existsSync(join(desktopDir, "node_modules", "electron", "dist", "version"))) {
  console.error("✗ 缺少 Electron 发行包（desktop/node_modules/electron/dist）");
  console.error("  重新装一遍即可：pnpm install --force --filter pi-web-simple-desktop");
  console.error("  （注意别带 ELECTRON_SKIP_BINARY_DOWNLOAD=1）");
  process.exit(1);
}

// 1. 编译 —— server/build 与 web/dist 是打包的输入，必须是最新的。
if (!args.includes("--no-build")) {
  console.log("· 编译 server / web / desktop");
  run("pnpm", ["build"], repoRoot);
}

// 2. 应用目录 + 3. 自带运行时。
run(process.execPath, [join(desktopDir, "scripts", "prepare-app.mjs")], desktopDir);
run(process.execPath, [join(desktopDir, "scripts", "prepare-runtime.mjs")], desktopDir);

// 4. electron-builder。`--publish never` 兜住「本地打了 tag 就顺手发出去」的情况，
//    产物一律由 CI 挂到 GitHub Release 上。
//
//    工作目录必须是**应用目录**，不能是 desktop/：electron-builder 只在 projectDir
//    （即 cwd）识别包管理器，然后**照它的目录布局**在应用目录里找文件。如果从 desktop/
//    跑，它会认出 pnpm、拿仓库根的 pnpm 工作区去算清单，结果就是
//    `pi-coding-agent/node_modules/**` 被默默丢掉（API 列出来的包对不上实际路径），
//    打出一个装机后一启动就报错的包。在应用目录里跑，它看到的是那个纯 npm 树，
//    路径一一对应。所以配置里的路径全部写成绝对路径（见 electron-builder.config.mjs）。
const builderCli = join(desktopDir, "node_modules", "electron-builder", "out", "cli", "cli.js");
if (!existsSync(builderCli)) {
  console.error("✗ 找不到 electron-builder 的入口，请重新跑 `pnpm install`");
  process.exit(1);
}
const builderArgs = [
  builderCli,
  "--config",
  join(desktopDir, "electron-builder.config.mjs"),
  `--${target}`,
  `--${arch}`,
  "--publish",
  "never",
];
if (args.includes("--dir")) builderArgs.push("--dir");

console.log(`· electron-builder：${target} ${arch}`);
run(process.execPath, builderArgs, join(desktopDir, ".desktop-build", "app"));

const releaseDir = join(desktopDir, "release");
const artifacts = existsSync(releaseDir)
  ? readdirSync(releaseDir).filter((name) => !name.startsWith(".") && statSync(join(releaseDir, name)).isFile())
  : [];

console.log("✓ 打包完成：");
for (const artifact of artifacts) {
  const size = (statSync(join(releaseDir, artifact)).size / 1024 / 1024).toFixed(0);
  console.log(`    ${relative(repoRoot, join(releaseDir, artifact))}  (${size} MB)`);
}

#!/usr/bin/env node
/**
 * 把官方 Node.js 运行时下载到 `.desktop-build/runtime/node/bin/`，随后由
 * electron-builder 以 `extraResources` 收进 `resources/runtime`。
 *
 * 为什么桌面版要自带 Node：pi 的 RPC 客户端用的是**裸命令** `node`
 * （`@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js` 里
 * `spawn("node", …)`），所以 agent 派生的每个子进程都得能在 PATH 上找到
 * `node`；而 Windows 上 `spawn("node")` 根本不会去找 `.cmd`/`.bat` 垫片。
 * 与其指望用户装过 Node，不如自带一份——deepseek-harness 的桌面版同样自带
 * 运行时，而不是借用宿主的那一份。
 *
 * 只留 `bin/node[.exe]` 与发行包自带的 `LICENSE`：官方发行包里另外还有 npm、
 * corepack、头文件与文档，桌面版一样都用不上；而许可证要跟着二进制一起分发，
 * 所以留在 `runtime/node/LICENSE`。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 与 CI 上跑测试的 Node 大版本一致；运行时版本是安全更新的一部分，随发布升级。 */
const NODE_VERSION = "v22.23.3";
const DIST = `https://nodejs.org/dist/${NODE_VERSION}`;

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(desktopDir, ".desktop-build");
const cacheDir = join(buildDir, "cache");
const runtimeDir = join(buildDir, "runtime", "node");
const force = process.argv.includes("--force");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** 官方发行包的平台标识，例如 darwin-arm64 / win-x64 / linux-arm64。 */
function nodeTarget() {
  const os = { darwin: "darwin", linux: "linux", win32: "win" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (os === undefined || arch === undefined) {
    fail(`不支持的平台：${process.platform}-${process.arch}（打包请在目标平台上进行）`);
  }
  return `${os}-${arch}`;
}

const target = nodeTarget();
const archiveName = `node-${NODE_VERSION}-${target}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
/**
 * 发行包**内部**的布局两边不一样：类 Unix 的 tar.gz 把可执行文件放在 `bin/` 下，Windows
 * 的 zip 则把 `node.exe` 直接放在解压出来的目录根上（根本没有 `bin/` 这一层）。
 *
 * 而**安装包里的落点**两边是一致的（`resources/runtime/node/bin/node[.exe]`，见
 * desktop/src/main.cts 的 appPaths）——那个 `bin/` 是本脚本自己摆的，不是从包里搬的。
 * 两者别混：这里写错，Windows 上 tar 会以「Not found in archive」+ 退出码 1 直接失败。
 */
const member =
  process.platform === "win32"
    ? `node-${NODE_VERSION}-${target}/node.exe`
    : `node-${NODE_VERSION}-${target}/bin/node`;
const licenseMember = `node-${NODE_VERSION}-${target}/LICENSE`;
const nodeBin = join(runtimeDir, "bin", process.platform === "win32" ? "node.exe" : "node");
const licenseFile = join(runtimeDir, "LICENSE");

// --- 已经就位就跳过 -------------------------------------------------------

if (!force && existsSync(nodeBin) && existsSync(licenseFile)) {
  const probe = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim() === NODE_VERSION) {
    console.log(`✓ Node 运行时已就位（${NODE_VERSION} ${target}），跳过下载`);
    process.exit(0);
  }
}

// --- 下载 + 校验 ----------------------------------------------------------

await mkdir(cacheDir, { recursive: true });
const archivePath = join(cacheDir, archiveName);

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fail(`下载失败：${url} → HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

if (!force && existsSync(archivePath)) {
  console.log(`· 复用缓存 ${archivePath}`);
} else {
  console.log(`· 下载 ${DIST}/${archiveName}`);
  await writeFile(archivePath, await download(`${DIST}/${archiveName}`));
}

// 官方 SHASUMS256.txt 走 HTTPS 取回，逐字节比对——下载途中被截断或中间人替换
// 都能挡下来。
const sums = new TextDecoder().decode(await download(`${DIST}/SHASUMS256.txt`));
const expected = sums
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .find(([, name]) => name === archiveName)?.[0];
if (expected === undefined) fail(`SHASUMS256.txt 里没有 ${archiveName}`);
const actual = createHash("sha256").update(await readFile(archivePath)).digest("hex");
if (actual !== expected) {
  await rm(archivePath, { force: true });
  fail(`校验和不匹配（期望 ${expected}，实际 ${actual}），已丢弃缓存，请重试`);
}

// --- 解压需要的两个文件 ---------------------------------------------------

// 系统自带的 tar 同时认 .tar.gz（macOS/Linux）和 .zip（Windows 10+ 的 bsdtar），
// 所以这里不需要再引入一个解压库，也省掉把整套 npm 写进磁盘的时间。
const staging = join(cacheDir, `staging-${target}`);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const untar = spawnSync("tar", ["-xf", archivePath, "-C", staging, member, licenseMember], { stdio: "inherit" });
if (untar.status !== 0) fail(`tar 解压失败（退出码 ${untar.status}）：${archiveName} 里没有 ${member}`);

const extracted = join(staging, ...member.split("/"));
const extractedLicense = join(staging, ...licenseMember.split("/"));
if (!existsSync(extracted)) fail(`解压后找不到 ${member}`);
if (!existsSync(extractedLicense)) fail(`解压后找不到 ${licenseMember}（许可证必须随二进制一起分发）`);

await rm(runtimeDir, { recursive: true, force: true });
await mkdir(dirname(nodeBin), { recursive: true });
await rename(extracted, nodeBin);
await rename(extractedLicense, licenseFile);
await chmod(nodeBin, 0o755); // tar 一般已保留权限位，显式再来一次以防 umask
await rm(staging, { recursive: true, force: true });

const probe = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
if (probe.status !== 0) fail(`自带的 Node 运行不起来：${nodeBin}`);
const size = (await stat(nodeBin)).size / 1024 / 1024;
console.log(`✓ Node 运行时就绪：${probe.stdout.trim()} ${target}（${size.toFixed(0)} MB）`);
console.log(`    ${nodeBin}`);

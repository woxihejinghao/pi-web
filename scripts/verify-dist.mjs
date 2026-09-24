#!/usr/bin/env node
/**
 * 发布前闸门：确认 tarball 要收的构建产物真的存在。
 *
 * 为什么需要它：`package.json` 的 `files` 列的是 `server/build` 与 `web/dist`，
 * 而这两个目录都不在 git 里。npm 对 `files` 中**不存在**的目录是静默跳过的——
 * 少一次 `pnpm build`，`npm publish` 就会发出一个没有后端的空壳包，而且不报错。
 * 这里把它变成一次硬失败。
 *
 * 顺带校验：`server/src` 里每个非测试的 .ts 都应有对应的 build 产物，
 * 防止 tsc 中途失败留下「入口在、依赖模块缺」的半成品。
 */
import { existsSync, readdirSync, statSync } from "node:fs";

const problems = [];

const mustExist = ["bin/pi-web-simple.js", "server/build/index.js", "web/dist/index.html"];
for (const p of mustExist) {
  if (!existsSync(p)) problems.push(`缺少 ${p}`);
}

// server 的编译产物逐个对齐源文件（tsconfig.build.json 排除 *.test.ts 与 src/testing）。
if (existsSync("server/src")) {
  for (const name of readdirSync("server/src")) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const out = `server/build/${name.replace(/\.ts$/, ".js")}`;
    if (!existsSync(out)) problems.push(`缺少 ${out}（源文件 server/src/${name}）`);
  }
}

// 前端产物除 index.html 外还需要实际的 js/css chunk。
const assets = "web/dist/assets";
if (!existsSync(assets) || readdirSync(assets).length === 0) {
  problems.push(`缺少 ${assets}/ 下的构建产物`);
}

if (problems.length > 0) {
  console.error("✗ 构建产物不完整，拒绝发布：");
  for (const p of problems) console.error(`    ${p}`);
  console.error("  先跑 `pnpm build` 再发布。");
  process.exit(1);
}

const kb = (p) => `${(statSync(p).size / 1024).toFixed(1)} kB`;
console.log("✓ 构建产物齐全，可以发布：");
for (const p of mustExist) console.log(`    ${p}  (${kb(p)})`);

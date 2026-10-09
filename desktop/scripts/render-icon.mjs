#!/usr/bin/env node
/**
 * 生成桌面版图标：`resources/icon-source.png`（人给的源素材）→
 * `resources/icon.png`（electron-builder 自己会把它转成 .icns / .ico）。
 *
 * 源素材是满幅的方图（黑底 + 手写 π），直接当图标会顶满整块画布、四角还是
 * 直角 —— macOS 从 Big Sur 起，图标在 1024 的画布上只占中间 824×824，形状是
 * 连续曲率的圆角方块（squircle），四周留透明。所以这里做两件事：把素材缩进
 * 内容区，再按 squircle 裁出 alpha。两个几何常量就是那份惯例本身。
 *
 * 想换图标就替换 `resources/icon-source.png`（方形 PNG，≥512），再跑
 * `pnpm --filter pi-web-simple-desktop run icons`（或 `pnpm icons:desktop`），
 * 别手改 icon.png。
 */
import { deflateSync, inflateSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const resourcesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "resources");
const sourcePath = join(resourcesDir, "icon-source.png");
const outputPath = join(resourcesDir, "icon.png");

/** 输出画布。1024 是 electron-builder 生成各尺寸 .icns / .ico 的基准。 */
const OUTPUT = 1024;
/** macOS 图标的内容区：1024 画布里 824×824，四周 100px 透明。 */
const CONTENT = 824 / OUTPUT;
/** 超椭圆指数。5 是贴近 Apple 那套连续曲率圆角的常用近似：指数越大越方，
 *  1 是菱形、2 是正圆；纯圆弧圆角相当于把 22.5% 半径的方角留给它。 */
const SQUIRCLE_N = 5;
/** 每个像素的超采样倍数（每轴），用来算形状覆盖率，得到抗锯齿轮廓。 */
const SAMPLES = 4;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- PNG 解码（只认 8 位、非交错的真彩 / 真彩 + alpha） --------------------

function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error(`不是 PNG：${sourcePath}`);
  }

  let header = null;
  const idat = [];
  for (let offset = 8; offset + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (!header) throw new Error(`${sourcePath} 缺少 IHDR。`);
  const { width, height, depth, colorType, interlace } = header;
  if (depth !== 8) throw new Error(`只支持 8 位深，当前 ${depth}（${sourcePath}）。`);
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`只支持真彩 / 真彩 + alpha 的 PNG，当前颜色类型 ${colorType}。`);
  }
  if (interlace !== 0) throw new Error("不支持隔行（Adam7）PNG。");

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(width * height * 4);

  let cursor = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor];
    cursor += 1;
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;

    // 逐字节的反滤波（PNG 的五个滤波器，规范 9.2）。
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          line[i] = (line[i] + left) & 0xff;
          break;
        case 2:
          line[i] = (line[i] + up) & 0xff;
          break;
        case 3:
          line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const dLeft = Math.abs(estimate - left);
          const dUp = Math.abs(estimate - up);
          const dUpLeft = Math.abs(estimate - upLeft);
          const predict = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
          line[i] = (line[i] + predict) & 0xff;
          break;
        }
        default:
          throw new Error(`不认识的 PNG 滤波器 ${filter}。`);
      }
    }

    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      data[to] = line[from];
      data[to + 1] = line[from + 1];
      data[to + 2] = line[from + 2];
      data[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    previous = line;
  }

  return { width, height, data };
}

// --- 渲染：素材缩进内容区，squircle 之外全透明 -----------------------------

function renderIcon(source) {
  const { width: sourceWidth, height: sourceHeight, data } = source;
  const total = SAMPLES * SAMPLES;
  const inset = (1 - CONTENT) / 2;

  // 子样本的两个轴各预计算一份：形状用的 |u|^N，以及它落回源图的浮点坐标。
  // 形状是中心对称的，两个轴共用同一份幂表。
  const axis = OUTPUT * SAMPLES;
  const power = new Float64Array(axis);
  const sourceX = new Float64Array(axis);
  const sourceY = new Float64Array(axis);
  for (let i = 0; i < axis; i++) {
    const canvas = (i + 0.5) / SAMPLES / OUTPUT;
    power[i] = Math.abs((canvas - 0.5) / (CONTENT / 2)) ** SQUIRCLE_N;
    const relative = Math.min(Math.max((canvas - inset) / CONTENT, 0), 1);
    sourceX[i] = relative * (sourceWidth - 1);
    sourceY[i] = relative * (sourceHeight - 1);
  }

  const out = Buffer.alloc(OUTPUT * OUTPUT * 4);
  for (let py = 0; py < OUTPUT; py++) {
    for (let px = 0; px < OUTPUT; px++) {
      let hits = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        const y = py * SAMPLES + sy;
        const vertical = power[y];
        const sy0 = Math.floor(sourceY[y]);
        const fy = sourceY[y] - sy0;
        const sy1 = Math.min(sy0 + 1, sourceHeight - 1);
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px * SAMPLES + sx;
          if (vertical + power[x] > 1) continue;

          const sx0 = Math.floor(sourceX[x]);
          const fx = sourceX[x] - sx0;
          const sx1 = Math.min(sx0 + 1, sourceWidth - 1);
          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;
          const p00 = (sy0 * sourceWidth + sx0) * 4;
          const p10 = (sy0 * sourceWidth + sx1) * 4;
          const p01 = (sy1 * sourceWidth + sx0) * 4;
          const p11 = (sy1 * sourceWidth + sx1) * 4;

          red += data[p00] * w00 + data[p10] * w10 + data[p01] * w01 + data[p11] * w11;
          green += data[p00 + 1] * w00 + data[p10 + 1] * w10 + data[p01 + 1] * w01 + data[p11 + 1] * w11;
          blue += data[p00 + 2] * w00 + data[p10 + 2] * w10 + data[p01 + 2] * w01 + data[p11 + 2] * w11;
          alpha += data[p00 + 3] * w00 + data[p10 + 3] * w10 + data[p01 + 3] * w01 + data[p11 + 3] * w11;
          hits += 1;
        }
      }

      const to = (py * OUTPUT + px) * 4;
      if (hits > 0) {
        // 颜色按命中样本取平均；alpha 是覆盖率（含素材自己的 alpha，若有）。
        out[to] = Math.round(red / hits);
        out[to + 1] = Math.round(green / hits);
        out[to + 2] = Math.round(blue / hits);
      }
      out[to + 3] = Math.round(alpha / total);
    }
  }

  return out;
}

// --- 最小 PNG 封装（8 位 RGBA，单块 IDAT） --------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function toPng(pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(OUTPUT, 0);
  header.writeUInt32BE(OUTPUT, 4);
  header[8] = 8; // 位深
  header[9] = 6; // 颜色类型：真彩 + alpha

  // PNG 每一行前面要有一个滤波器字节（这里统一用 None）。
  const stride = OUTPUT * 4;
  const raw = Buffer.alloc(OUTPUT * (stride + 1));
  for (let y = 0; y < OUTPUT; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_MAGIC,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- 入口 ------------------------------------------------------------------

const source = await readFile(sourcePath).catch(() => {
  throw new Error(`找不到图标源素材：${sourcePath}\n放一张方形 PNG 在这里，再重跑本脚本。`);
});

const decoded = decodePng(source);
if (decoded.width !== decoded.height) {
  throw new Error(`图标必须是正方形，当前是 ${decoded.width}×${decoded.height}（${sourcePath}）。`);
}
if (decoded.width < 512) {
  throw new Error(`图标至少 512×512，当前是 ${decoded.width}×${decoded.height}（${sourcePath}）。`);
}

await writeFile(outputPath, toPng(renderIcon(decoded)));
console.log(
  `✓ 图标已生成：resources/icon.png (${OUTPUT}×${OUTPUT}，内容区 ${Math.round(CONTENT * OUTPUT)}×${Math.round(CONTENT * OUTPUT)} 的 squircle)，` +
    `源素材 resources/icon-source.png (${decoded.width}×${decoded.height})`,
);

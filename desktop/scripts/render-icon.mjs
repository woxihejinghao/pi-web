#!/usr/bin/env node
/**
 * 生成桌面版图标：`resources/icon.svg`（人读的源）与 `resources/icon.png`
 * （electron-builder 自己会把它转成 .icns / .ico）。
 *
 * 仓库里原本没有任何位图素材，而 mac 的图标必须是 ≥512×512 的 PNG。
 * 与其引一个渲染依赖（sharp / resvg）只为画一个圆角方块加一个 π，不如
 * 直接在这里光栅化：形状只有圆角矩形和三条圆角短棒，超采样抗锯齿就够用了。
 *
 * 几何参数是唯一的真源 —— 想改图标就改下面的常量再跑
 * `pnpm --filter pi-web-simple-desktop run icons`，别手改 icon.svg。
 */
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const resourcesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "resources");

const SIZE = 1024;
/** 超采样倍数：3×3 已足够让 16px 下的圆角与字形边缘不出现锯齿。 */
const SAMPLES = 3;

// 与界面同一套语言：DeepSeek 蓝渐变到紫，白色 π 压在中间。
const GRADIENT_FROM = [0x4d, 0x6b, 0xfe];
const GRADIENT_TO = [0x7c, 0x3a, 0xed];

/** 圆角方块的外接矩形与圆角半径（占画布比例，macOS 图标惯例约 22.5%）。 */
const PLATE = { inset: 0.055, radius: 0.225 };
/** π 的三笔：顶横、左竖、右竖（相对画布的比例）。 */
const BARS = [
  { x0: 0.25, y0: 0.315, x1: 0.75, y1: 0.415, radius: 0.05 },
  { x0: 0.335, y0: 0.315, x1: 0.44, y1: 0.705, radius: 0.05 },
  { x0: 0.56, y0: 0.315, x1: 0.665, y1: 0.705, radius: 0.05 },
];
/** 竖笔略微外撇，否则看起来像「TT」而不是 π。 */
const LEG_FLARE = 0.022;

/** 点在圆角矩形内：把它夹到内缩矩形上，再比较距离。 */
function inRoundedRect(px, py, x0, y0, x1, y1, radius) {
  const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** 竖笔按高度线性外撇：返回某一高度处的左右边界。 */
function legBounds(bar, t) {
  const flare = LEG_FLARE * t;
  return [bar.x0 - flare, bar.x1 - flare];
}

function coverageAt(x, y) {
  const plateInset = PLATE.inset;
  const inPlate = inRoundedRect(x, y, plateInset, plateInset, 1 - plateInset, 1 - plateInset, PLATE.radius);
  if (!inPlate) return { plate: false, glyph: 0 };

  const [top, left, right] = BARS;
  let glyph = inRoundedRect(x, y, top.x0, top.y0, top.x1, top.y1, top.radius) ? 1 : 0;
  for (const leg of [left, right]) {
    if (glyph === 1) break;
    const t = Math.min(Math.max((y - leg.y0) / (leg.y1 - leg.y0), 0), 1);
    const [lx, rx] = legBounds(leg, t);
    if (inRoundedRect(x, y, lx, leg.y0, rx, leg.y1, leg.radius)) glyph = 1;
  }
  return { plate: true, glyph };
}

function render() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  const step = 1 / (SIZE * SAMPLES);
  for (let py = 0; py < SIZE; py++) {
    const rowStart = py * (SIZE * 4 + 1);
    raw[rowStart] = 0; // PNG 行过滤器：None
    for (let px = 0; px < SIZE; px++) {
      let plate = 0;
      let glyph = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px * SAMPLES + sx + 0.5) * step;
          const y = (py * SAMPLES + sy + 0.5) * step;
          const sample = coverageAt(x, y);
          plate += sample.plate ? 1 : 0;
          glyph += sample.plate ? sample.glyph : 0;
        }
      }
      const total = SAMPLES * SAMPLES;
      const plateAlpha = plate / total;
      const glyphAlpha = glyph / total;

      // 渐变沿对角线，再按字形覆盖率把白色压上去。
      const t = (px / SIZE + py / SIZE) / 2;
      const base = GRADIENT_FROM.map((from, i) => Math.round(from + (GRADIENT_TO[i] - from) * t));
      const color = base.map((channel) => Math.round(channel + (255 - channel) * glyphAlpha));

      const offset = rowStart + 1 + px * 4;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = Math.round(plateAlpha * 255);
    }
  }
  return raw;
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

function toPng(raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // 位深
  header[9] = 6; // 颜色类型：真彩 + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- SVG（同一份几何参数的矢量版，方便日后微调） --------------------------

function toSvg() {
  const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const pct = (value) => (value * SIZE).toFixed(1);
  const plateSize = (1 - PLATE.inset * 2) * SIZE;
  const [top, left, right] = BARS;
  /** 竖笔在底端外撇 FLARE，用一条梯形路径表达（圆角在 1024px 下可忽略）。 */
  const legPath = (leg) => {
    const [lx, rx] = legBounds(leg, 1);
    return `  <path d="M${pct(leg.x0 + LEG_FLARE)} ${pct(leg.y0)} H${pct(leg.x1 + LEG_FLARE)} L${pct(rx)} ${pct(leg.y1)} H${pct(lx)} Z" fill="#fff"/>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hex(GRADIENT_FROM)}"/>
      <stop offset="1" stop-color="${hex(GRADIENT_TO)}"/>
    </linearGradient>
  </defs>
  <rect x="${pct(PLATE.inset)}" y="${pct(PLATE.inset)}" width="${plateSize.toFixed(1)}" height="${plateSize.toFixed(1)}" rx="${pct(PLATE.radius)}" fill="url(#plate)"/>
  <rect x="${pct(top.x0)}" y="${pct(top.y0)}" width="${pct(top.x1 - top.x0)}" height="${pct(top.y1 - top.y0)}" rx="${pct(top.radius)}" fill="#fff"/>
${legPath(left)}
${legPath(right)}
</svg>
`;
}

await mkdir(resourcesDir, { recursive: true });
await writeFile(join(resourcesDir, "icon.png"), toPng(render()));
await writeFile(join(resourcesDir, "icon.svg"), toSvg());
console.log(`✓ 图标已生成：resources/icon.png (${SIZE}×${SIZE}) 与 resources/icon.svg`);
